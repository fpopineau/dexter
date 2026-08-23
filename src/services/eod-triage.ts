/**
 * End-of-day triage — FLAT BY CLOSE (operator policy 2026-08-23,
 * superseding the 2026-07-30 momentum-keep).
 *
 * At 15:52 ET every filled DAY-bracket position CLOSES. The only path
 * overnight for an intraday position is the operator's explicit pre-bell
 * `keep SYMBOL` — still subject to the earnings guard, the whole-book
 * overnight vet and the gap-stress budget; a PLANNED overnight position
 * is a swing proposal. The vet then prices EVERYTHING that survives the
 * bell: keep-overrides, deliberate GTC swings/bets, adopted/manual
 * positions, failed closes and resting GTC entries.
 *
 * EARNINGS GUARD (2026-08-05): a KEEP must never turn an intraday trade
 * into an accidental earnings bet — a winning DAY position in a stock
 * that reports tonight would sail through the print as a 🌙 hold, exactly
 * the binary gamble the system refuses to take deliberately (SNDK case).
 * Positions whose symbol reports within EARNINGS_GUARD_DAYS are closed
 * before the bell REGARDLESS of P&L. Disable with EOD_EARNINGS_GUARD=false.
 *
 * GUARD EXTENSIONS (2026-08-06, trade classes):
 *   - GTC positions (swings, pre-close overnight setups) get the earnings
 *     guard too — rule 4 ("every non-bet class exits before the print")
 *     is deterministic, not advisory. Their momentum is NOT triaged: a
 *     swing keeps its thesis; only an imminent print can force it flat.
 *   - tradeClass 'earnings-bet' is exempt BY DESIGN — holding through the
 *     print is the entire point of that class, and it was sized for the
 *     worst-case gap at creation. The report still names it.
 *   - UNFILLED GTC entries get the guard too (2026-08-11): a resting
 *     entry survives the close, and a post-print gap fills it exactly
 *     when it blows through the trigger — an entry-side accidental
 *     earnings bet. With a print ahead, the resting orders are cancelled.
 *   - A print dated TODAY with 'pre-market' timing already happened by
 *     15:52 — closing on it would flatten exactly the legitimate
 *     post-print reaction trades this desk exists to take. Past prints
 *     never trigger the guard ('unknown' timing stays conservative).
 *
 * Deterministic, no LLM. Disable with EOD_TRIAGE=false.
 */

import { BarSizeSetting } from '@stoqey/ib';
import { Cron } from 'croner';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getIBApi } from '@/tools/ibkr/connection.js';
import { fetchBars } from '@/tools/ibkr/signal-scorer.js';
import { logger } from '@/utils';
import { isMarketHalfDay, isMarketHoliday } from '@/utils/market-hours.js';
import { getNetLiquidation } from './daily-loss-guard.js';
import { findUpcomingEarnings, nextTradingDates, type UpcomingEarnings } from './earnings-calendar.js';
import { getMacroEventsWithin, macroNightWarning } from './event-risk.js';
import { barTimeFrameMs } from './outcome-tracker.js';
import { closePosition, fetchPositions } from './position-actions.js';
import { listTrackable, type TradeProposal } from './trade-proposals.js';
import { cancelEntryLeg } from './stale-entry-sweeper.js';
import { getRiskRules, type TradeClass } from '@/tools/ibkr/risk-rules.js';

const ET = 'America/New_York';
// Two slots, 8 minutes before each possible close: 15:52 for a normal 16:00
// close, 12:52 for a 13:00 half-day close. Each firing checks which kind of
// day today is and yields to the other slot — without this, half-days ran
// triage at 15:52, almost three hours AFTER the DAY brackets expired at
// 13:00, on positions whose protection was already gone (audit 2026-08-20).
const TRIAGE_CRON_FULL = '52 15 * * 1-5';
const TRIAGE_CRON_HALF = '52 12 * * 1-5';
// WP5/D2 preview slots, 12 minutes ahead of the triage: report what WILL
// close so the operator can arm 'keep SYMBOL' overrides before it does.
const PREVIEW_CRON_FULL = '40 15 * * 1-5';
const PREVIEW_CRON_HALF = '40 12 * * 1-5';
const FADE_LOOKBACK_MIN = 60;
/** Close before the bell when the symbol reports within this many TRADING
 *  days (0 = today's print after the close, 1 = the next session's
 *  pre-market too — on a Friday that is Monday, or Tuesday after a
 *  holiday Monday; the calendar walk skips non-trading days). */
const EARNINGS_GUARD_DAYS = 1;

// ---------------------------------------------------------------------------
// Pure decision (unit-tested)
// ---------------------------------------------------------------------------

export interface EodDecision {
    action: 'close' | 'keep';
    reason: string;
}

/**
 * FLAT BY CLOSE (operator policy 2026-08-23, "profit as surely as
 * possible"): an intraday thesis ENDS with its session. The old
 * momentum-keep ("winners hold, stabilizing losers hold") silently
 * converted intraday trades into overnight gap exposure sized by intraday
 * rules — the single largest hole four external reviews kept finding, and
 * with the take-at-x% policy winners bank at their target during the day
 * anyway. The ONLY path overnight for an intraday position is the
 * explicit pre-bell `keep SYMBOL` (a human decision, still subject to the
 * earnings guard, the overnight caps and the gap-stress vet); a planned
 * overnight position is a SWING and must be proposed as one.
 */
export function decideEodAction(input: {
    direction: 'long' | 'short';
    entryFill: number;
    last: number;
    hourAgo: number | null;
}): EodDecision {
    const { direction, entryFill, last } = input;
    if (!(last > 0) || !(entryFill > 0)) {
        return { action: 'close', reason: 'flat by close (price unavailable too) — pre-bell \'keep SYMBOL\' overrides' };
    }
    const pnlPct = direction === 'long'
        ? ((last - entryFill) / entryFill) * 100
        : ((entryFill - last) / entryFill) * 100;
    return {
        action: 'close',
        reason: `flat by close (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) — intraday theses do not ride gaps; ` +
            `pre-bell 'keep SYMBOL' overrides, a planned overnight is a swing proposal`,
    };
}

// ---------------------------------------------------------------------------
// Overnight vetting of the conversion book (WP5)
// ---------------------------------------------------------------------------

export interface OvernightVetCandidate {
    symbol: string;
    label: string;
    /** |qty| × last (market value; avgCost fallback flagged by caller). */
    marketValueUsd: number | null;
    /** Signed P&L% in the trade's direction; null = unknown (trims first). */
    pnlPct: number | null;
    /** |qty| × avgCost — the cost-basis notional an overridden unpriceable
     *  position counts at (REQ-EOD-001). Understates a winner, but exposure
     *  that the caps cannot see is how a book breaches silently. */
    fallbackValueUsd?: number | null;
    /** Counted in every sum but never trimmed (review 2026-08-23:
     *  earnings bets hold through the print BY DESIGN; adopted/manual
     *  positions are never managed; a failed close must not be blindly
     *  re-closed — but all of their tails weigh on the book). */
    trimExempt?: boolean;
    /** A resting (unfilled) GTC entry — exposure-in-waiting. A trim on
     *  this candidate CANCELS the entry parent instead of closing a
     *  position (omission 5, review 2026-08-23). */
    restingEntry?: TradeProposal;
    /** Per-candidate stress % (earnings bets stress at max(their own
     *  worst historical gap, the base stress)); null/absent = base. */
    stressPctOverride?: number | null;
}

export interface OvernightVetResult {
    /** Symbols to close before the bell, worst-first, with reasons. */
    trims: Array<{ symbol: string; label: string; reason: string }>;
    /** Cap-usage line for the report (null = inside the caps). */
    capLine: string | null;
    /** Loud anomalies for the report (REQ-EOD-001): exposure counted at
     *  cost basis, or not countable at all. */
    warnings: string[];
}

/**
 * Pure: vet the CONVERSION book (DAY keeps + kept-overnight holds) against
 * the overnight caps at MARKET value — the checks a deliberate GTC accept
 * gets, applied to what converts at the bell. Per-name breaches trim; a
 * book breach trims worst-first (lowest P&L%, unknown P&L first) until it
 * fits. `overrides` (pre-bell `keep SYMBOL`) exempts a symbol from
 * trimming — the exposure still counts and the cap line still reports it.
 * NetLiq unavailable: per-position vetting impossible — LOUD warning, no
 * blind mass-close (recorded deviation from pure fail-closed).
 */

/**
 * Review-19, pure: rebuild the overnight book for the POSTCONDITION
 * re-vet from BROKER TRUTH — fresh positions plus the actual working
 * `P-XXXX:entry` parents in the open-order snapshot. A partial fill is
 * counted BOTH ways (the position AND the still-working remainder ride
 * the night); the DB never decides what is resting, only what class a
 * resting parent belongs to. Conservative: an entry order counts at its
 * full totalQuantity (the snapshot cannot see the remaining quantity —
 * overstating a partially filled parent overstates stress, never
 * understates it). DAY-parent entries die at the bell and are skipped;
 * an entry whose row is gone (orphan) counts anyway. Symbols that
 * cannot be priced are returned in `unpriced` — the caller must alarm,
 * not pass.
 */
export function buildRevetBook(input: {
    positions: Array<{ symbol: string; quantity: number; avgCost: number }>;
    orders: Array<{ symbol: string; orderRef: string | null; quantity: number | null; auxPrice: number | null; lmtPrice: number | null; tif: string | null }>;
    rows: Array<Pick<TradeProposal, 'id' | 'symbol' | 'tradeClass' | 'worstCaseGapPct' | 'entry' | 'entryLimit' | 'tif' | 'quantity'>>;
    lastBySymbol: Map<string, number>;
    baseStress: number;
}): { candidates: OvernightVetCandidate[]; unpriced: string[] } {
    const candidates: OvernightVetCandidate[] = [];
    const unpriced: string[] = [];
    const rowById = new Map(input.rows.map((r) => [r.id.toUpperCase(), r]));
    const rowBySymbol = new Map<string, (typeof input.rows)[number]>();
    for (const r of input.rows) if (!rowBySymbol.has(r.symbol)) rowBySymbol.set(r.symbol, r);

    for (const pos of input.positions) {
        if (pos.quantity === 0) continue;
        const row = rowBySymbol.get(pos.symbol);
        const isBet = row?.tradeClass === 'earnings-bet';
        const last = input.lastBySymbol.get(pos.symbol) ?? null;
        const mv = last !== null ? Math.abs(pos.quantity) * last
            : pos.avgCost > 0 ? Math.abs(pos.quantity) * pos.avgCost : null;
        if (mv === null) unpriced.push(pos.symbol);
        candidates.push({
            symbol: pos.symbol,
            label: 're-vet position',
            marketValueUsd: mv,
            pnlPct: null,
            fallbackValueUsd: pos.avgCost > 0 ? Math.abs(pos.quantity) * pos.avgCost : null,
            // Bets stress at their own gap and are never trimmed; a
            // position with no row (adopted/manual) stays counted-but-
            // exempt exactly as in the first vet — only failed actions on
            // managed rows should alarm.
            ...(isBet ? { trimExempt: true, stressPctOverride: Math.max(input.baseStress, row?.worstCaseGapPct ?? 0) }
                : row === undefined ? { trimExempt: true }
                : {}),
        });
    }

    for (const o of input.orders) {
        const m = /^(P-[0-9A-F]{4}):entry$/.exec(o.orderRef ?? '');
        if (!m) continue;
        const row = rowById.get(m[1]) ?? null;
        // A DAY parent dies at the bell — no overnight exposure. Broker
        // truth decides when it speaks; the row only fills its silence;
        // fully unknown counts (conservative).
        if (o.tif === 'DAY') continue;
        if (o.tif === null && row !== null && row.tif !== 'GTC') continue;
        const qty = o.quantity ?? row?.quantity ?? null;
        if (qty === null || !(qty > 0)) { unpriced.push(o.symbol); continue; }
        const basisOrder = Math.max(o.auxPrice ?? 0, o.lmtPrice ?? 0);
        const basisRow = row ? Math.max(row.entry ?? 0, row.entryLimit ?? 0) : 0;
        const basis = basisOrder > 0 ? basisOrder
            : basisRow > 0 ? basisRow
            : input.lastBySymbol.get(o.symbol) ?? 0;
        if (!(basis > 0)) { unpriced.push(o.symbol); continue; }
        const isBet = row?.tradeClass === 'earnings-bet';
        candidates.push({
            symbol: o.symbol,
            label: row ? `re-vet resting entry (${row.id})` : 're-vet ORPHAN resting entry',
            marketValueUsd: basis * qty,
            pnlPct: null,
            ...(isBet ? { trimExempt: true, stressPctOverride: Math.max(input.baseStress, row?.worstCaseGapPct ?? 0) } : {}),
        });
    }
    return { candidates, unpriced };
}

export function vetOvernightBook(
    keeps: OvernightVetCandidate[],
    netLiq: number | null,
    rules: {
        max_overnight_exposure_pct: number;
        max_overnight_position_pct: number;
        /** Review 2026-08-23 P1: assumed adverse overnight gap (%). The
         *  book is trimmed until gap × surviving notional fits inside one
         *  daily-loss budget — a stop cannot contain an opening gap. */
        overnight_gap_stress_pct?: number;
        max_daily_loss_pct?: number;
    },
    overrides: ReadonlySet<string>,
): OvernightVetResult {
    if (keeps.length === 0) return { trims: [], capLine: null, warnings: [] };
    if (netLiq === null || !(netLiq > 0)) {
        return {
            trims: [],
            capLine: '⚠ overnight caps could NOT be verified (NetLiq unavailable) — the conversion book rides UNVETTED.',
            warnings: [],
        };
    }
    const trims: OvernightVetResult['trims'] = [];
    const warnings: string[] = [];
    const surviving: Array<OvernightVetCandidate & { valueUsd: number }> = [];

    for (const k of keeps) {
        if (k.marketValueUsd === null || !(k.marketValueUsd >= 0)) {
            if (overrides.has(k.symbol)) {
                // REQ-EOD-001: operator-owned but the exposure must still
                // weigh on the book cap — count it at cost basis; only when
                // even that is unknown does it ride uncounted, and loudly.
                const fallback = k.fallbackValueUsd;
                if (fallback !== null && fallback !== undefined && fallback > 0) {
                    warnings.push(`⚠ ${k.symbol}: unpriceable — counted at cost basis ($${fallback.toFixed(0)}) for the overnight caps.`);
                    surviving.push({ ...k, valueUsd: fallback });
                } else {
                    warnings.push(`⚠ ${k.symbol}: unpriceable and no cost basis — its exposure is NOT counted in the overnight caps.`);
                    surviving.push({ ...k, valueUsd: 0 });
                }
                continue;
            }
            trims.push({ symbol: k.symbol, label: k.label, reason: 'position value unknown — cannot vet against the overnight caps (fail-closed)' });
            continue;
        }
        const pct = (k.marketValueUsd / netLiq) * 100;
        if (pct > rules.max_overnight_position_pct && !overrides.has(k.symbol) && k.trimExempt !== true) {
            trims.push({
                symbol: k.symbol, label: k.label,
                reason: `${pct.toFixed(1)}% of NetLiq vs the ${rules.max_overnight_position_pct}% per-position overnight cap`,
            });
            continue;
        }
        surviving.push({ ...k, valueUsd: k.marketValueUsd });
    }

    // Book cap: close worst-first until the remaining book fits.
    let bookUsd = surviving.reduce((s, k) => s + k.valueUsd, 0);
    const capUsd = (rules.max_overnight_exposure_pct / 100) * netLiq;
    if (bookUsd > capUsd) {
        const trimmable = surviving
            .filter((k) => !overrides.has(k.symbol) && k.trimExempt !== true)
            .sort((a, b) => (a.pnlPct ?? -Infinity) - (b.pnlPct ?? -Infinity));
        for (const k of trimmable) {
            if (bookUsd <= capUsd) break;
            bookUsd -= k.valueUsd;
            trims.push({
                symbol: k.symbol, label: k.label,
                reason: `book over the ${rules.max_overnight_exposure_pct}% overnight cap — trimming worst-first (${k.pnlPct === null ? 'P&L unknown' : `${k.pnlPct.toFixed(2)}%`})`,
            });
        }
    }

    // Gap-stress trim (review 2026-08-23 P1): notional caps bound SIZE; this
    // bounds the LOSS a correlated adverse gap hands the account overnight —
    // gap% × surviving notional must fit inside one daily-loss budget.
    // Trims worst-first among the non-overridden; operator overrides hold
    // their excess (reported, like the notional caps).
    const stressPct = rules.overnight_gap_stress_pct ?? 0;
    const dailyLossPct = rules.max_daily_loss_pct ?? 0;
    let stressedUsd = 0;
    if (stressPct > 0 && dailyLossPct > 0) {
        const budgetUsd = (dailyLossPct / 100) * netLiq;
        const trimmed = new Set(trims.map((t) => t.symbol));
        const alive = () => surviving.filter((k) => !trimmed.has(k.symbol));
        const stressOf = (k: typeof surviving[number]) => k.valueUsd * ((k.stressPctOverride ?? stressPct) / 100);
        stressedUsd = alive().reduce((s, k) => s + stressOf(k), 0);
        if (stressedUsd > budgetUsd) {
            const stressTrimmable = alive()
                .filter((k) => !overrides.has(k.symbol) && k.trimExempt !== true)
                .sort((a, b) => (a.pnlPct ?? -Infinity) - (b.pnlPct ?? -Infinity));
            for (const k of stressTrimmable) {
                if (stressedUsd <= budgetUsd) break;
                stressedUsd -= stressOf(k);
                trimmed.add(k.symbol);
                trims.push({
                    symbol: k.symbol, label: k.label,
                    reason: `an adverse overnight gap on the surviving book would cost more than one daily-loss budget ` +
                        `(${dailyLossPct}% of NetLiq) — gap-stress trim, worst-first (${k.pnlPct === null ? 'P&L unknown' : `${k.pnlPct.toFixed(2)}%`})`,
                });
            }
            if (stressedUsd > budgetUsd) {
                warnings.push(
                    `⚠ gap-stress: overrides/exempt positions hold a book whose adverse gap costs ` +
                    `$${stressedUsd.toFixed(0)} — over the ${dailyLossPct}% daily-loss budget ($${budgetUsd.toFixed(0)}).`,
                );
            }
        }
        // Recompute the surviving notional for the cap line below.
        bookUsd = alive().reduce((s, k) => s + k.valueUsd, 0);
    }

    const finalPct = (bookUsd / netLiq) * 100;
    const overCap = bookUsd > capUsd;
    const stressNote = stressPct > 0 && dailyLossPct > 0
        ? ` Gap-stress (${stressPct}%): $${stressedUsd.toFixed(0)} vs the ${dailyLossPct}% budget.`
        : '';
    const capLine = overCap
        ? `⚠ overnight book ${finalPct.toFixed(1)}% of NetLiq still exceeds the ${rules.max_overnight_exposure_pct}% cap after trims (operator overrides hold the excess).${stressNote}`
        : trims.length
            ? `overnight book ${finalPct.toFixed(1)}% of NetLiq after ${trims.length} trim(s).${stressNote}`
            : null;
    return { trims, capLine, warnings };
}

/**
 * REQ-EOD-002: when the earnings calendar lookup FAILED outright, no keep
 * decision is backed by a verified print-free window — a would-keep fails
 * closed unless the operator armed a pre-bell override (an UNKNOWN print
 * status is overridable; a KNOWN print never is). Closes pass through.
 */
export function applyLookupFailurePolicy(
    decision: { action: 'keep' | 'close'; reason: string },
    lookupFailed: boolean,
    hasOverride: boolean,
): { action: 'keep' | 'close'; reason: string } {
    if (!lookupFailed || decision.action === 'close') return decision;
    if (hasOverride) {
        return {
            action: 'keep',
            reason: `${decision.reason} (earnings lookup FAILED — the override holds it through an unverifiable print risk)`,
        };
    }
    return {
        action: 'close',
        reason: `earnings guard could not verify a print ahead (lookup failed) — closing (fail-closed; pre-bell 'keep SYMBOL' overrides)`,
    };
}

// --- Pre-bell operator overrides (decision D2) ---
const keepOverrides = new Map<string, string>(); // SYMBOL → ET date armed

function todayEt(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: ET });
}

/** Arm a pre-bell keep override for today (WhatsApp `keep SYMBOL`). */
export function registerKeepOverride(symbolRaw: string): { ok: boolean; message: string } {
    const symbol = symbolRaw.trim().toUpperCase();
    if (!/^[A-Z.]{1,6}$/.test(symbol)) {
        return { ok: false, message: `'${symbolRaw}' does not look like a ticker.` };
    }
    keepOverrides.set(symbol, todayEt());
    return {
        ok: true,
        message:
            `🤝 ${symbol}: pre-bell KEEP override armed for today — the EOD triage will not fail-close or cap-trim it ` +
            `(logged as your decision). The EARNINGS GUARD still applies: a print ahead closes it regardless — ` +
            `hold through a print only via an explicit earnings-bet proposal.`,
    };
}

/** Today's armed overrides (ET-dated; yesterday's arm does not carry). */
export function activeKeepOverrides(): Set<string> {
    const today = todayEt();
    return new Set([...keepOverrides.entries()].filter(([, d]) => d === today).map(([s]) => s));
}

// --- Vetted-keep registry: the 🌙 conversion message consults this ---
const vettedKeeps = new Map<string, string>(); // SYMBOL → ET date vetted

/** Did today's triage vet-and-keep this symbol? (outcome tracker asks
 *  before wording the 🌙 conversion notice.) */
export function wasVettedKeepToday(symbol: string): boolean {
    return vettedKeeps.get(symbol.trim().toUpperCase()) === todayEt();
}

/**
 * Pure (WP11): close from ~`minutesBack` before the LAST bar, located by
 * TIMESTAMP. The old `bars[len-1-60]` index arithmetic assumed a gapless
 * 1-min series — on a thin name it reached back hours, and with <61 bars
 * it silently became the session's first print. Returns null when the
 * series does not reach back far enough (the fail-closed decision path
 * then treats momentum as unknown).
 */
export function priceMinutesBack(
    bars: Array<{ time?: string; close?: number | null }>,
    minutesBack: number,
    barFrameMs: (time: string | undefined) => number | null,
): number | null {
    if (bars.length === 0) return null;
    const lastFrame = barFrameMs(bars[bars.length - 1]?.time);
    if (lastFrame === null) return null;
    const target = lastFrame - minutesBack * 60_000;
    for (let i = bars.length - 1; i >= 0; i--) {
        const f = barFrameMs(bars[i]?.time);
        if (f !== null && f <= target) {
            const c = bars[i]?.close;
            return typeof c === 'number' && c > 0 ? c : null;
        }
    }
    return null; // series too short — momentum honestly unknown
}

/**
 * Pure: split trackable proposals into the three triage lanes.
 *   - momentum lane: filled DAY brackets (exits die at the bell) AND
 *     kept-overnight holds (converted DAY keeps — tif is GTC now, but they
 *     are intraday positions that must re-earn every additional night, not
 *     thesis-carrying swings);
 *   - guard-only lane: filled GTC positions entered deliberately (swings,
 *     overnight setups, earnings bets) — their thesis holds, only an
 *     imminent print can force them flat;
 *   - unfilled-GTC lane: executed proposals whose ENTRY still rests as a
 *     GTC order. The entry survives the close, so a post-print gap can
 *     blow through the trigger and fill INTO the reaction — an entry-side
 *     accidental earnings bet. (Unfilled DAY entries die at the bell —
 *     safe by construction, in no lane.)
 */
export function splitTriageCandidates<T extends {
    tif: 'DAY' | 'GTC';
    entryFillPrice: number | null;
    keptOvernightAt: number | null;
}>(trackable: T[]): { momentum: T[]; guardOnly: T[]; unfilledGtc: T[] } {
    const filled = trackable.filter((t) => t.entryFillPrice != null);
    return {
        momentum: filled.filter((t) => t.tif === 'DAY' || t.keptOvernightAt != null),
        guardOnly: filled.filter((t) => t.tif === 'GTC' && t.keptOvernightAt == null),
        unfilledGtc: trackable.filter((t) => t.entryFillPrice == null && t.tif === 'GTC'),
    };
}

/**
 * Earnings guard for a RESTING GTC entry: with a print ahead, the order
 * must not survive into it — tomorrow's gap fills exactly when it blows
 * through the trigger, entering a position the stop math never priced.
 * Cancel, never hold. Earnings bets are exempt (their entry window is the
 * final hour before the print's close and their size assumes the gap);
 * they are reported, not cancelled. Null = nothing needs doing.
 */
export function decideUnfilledEntryGuard(
    tradeClass: TradeClass,
    earnings: Pick<UpcomingEarnings, 'date' | 'time'> | null,
    todayIso: string,
): string | null {
    if (tradeClass === 'earnings-bet') return null; // gap-sized by design
    if (!earnings || !isUpcomingPrint(earnings, todayIso)) return null;
    return (
        `reports earnings ${earnings.date}${earnings.time !== 'unknown' ? ` ${earnings.time}` : ''} — ` +
        `cancelling the resting ${tradeClass} entry: a post-print gap through the trigger would fill ` +
        `INTO the reaction with a stop the sizing never priced for (entry-side earnings guard)`
    );
}

/**
 * Pure: overnight-cap usage line for the triage report, or null when the
 * book is inside the caps. REPORTING, not enforcement: the operator's EOD
 * policy is keep-by-default, so triage never force-trims — but a keep
 * must never ride past the overnight caps in silence. (The deliberate
 * GTC path — overnight setups, swings, bets — is hard-enforced by the
 * acceptance gate; this covers what converts at the bell.)
 */
export function overnightCapWarning(
    holds: Array<{ symbol: string; valueUsd: number }>,
    netLiq: number | null,
    rules: { max_overnight_exposure_pct: number; max_overnight_position_pct: number },
): string | null {
    if (holds.length === 0) return null;
    if (netLiq === null || !(netLiq > 0)) {
        return '⚠ overnight caps could NOT be verified (NetLiq unavailable).';
    }
    const totalUsd = holds.reduce((s, h) => s + h.valueUsd, 0);
    const totalPct = (totalUsd / netLiq) * 100;
    const oversized = holds
        .map((h) => ({ ...h, pct: (h.valueUsd / netLiq) * 100 }))
        .filter((h) => h.pct > rules.max_overnight_position_pct);
    const parts: string[] = [];
    if (totalPct > rules.max_overnight_exposure_pct) {
        parts.push(
            `book ${totalPct.toFixed(1)}% of NetLiq rides overnight vs the ${rules.max_overnight_exposure_pct}% cap`,
        );
    }
    if (oversized.length) {
        parts.push(
            oversized.map((h) => `${h.symbol} is ${h.pct.toFixed(1)}%`).join(', ') +
            ` vs the ${rules.max_overnight_position_pct}% per-position overnight cap`,
        );
    }
    if (parts.length === 0) return null;
    return `⚠ overnight caps: ${parts.join('; ')} — trim manually ('close <SYMBOL>') or accept the exposure knowingly.`;
}

/**
 * Is this calendar hit a print still AHEAD of the 15:52 triage? A report
 * dated today with pre-market timing already happened this morning —
 * closing on it would punish the legitimate post-print reaction trade.
 * 'unknown' timing stays conservative (treated as upcoming).
 */
export function isUpcomingPrint(
    earnings: Pick<UpcomingEarnings, 'date' | 'time'>,
    todayIso: string,
): boolean {
    return !(earnings.date === todayIso && earnings.time === 'pre-market');
}

/**
 * Earnings guard: an imminent print overrides ANY momentum decision —
 * winners included. Holding through earnings turns a technical trade into
 * a binary bet the stop/target math was never sized for.
 */
export function applyEarningsGuard(
    base: EodDecision,
    earnings: Pick<UpcomingEarnings, 'date' | 'time'> | null,
    todayIso: string,
): EodDecision {
    if (!earnings || !isUpcomingPrint(earnings, todayIso)) return base;
    const would = base.action === 'keep' ? ` (would otherwise keep: ${base.reason})` : '';
    return {
        action: 'close',
        reason:
            `reports earnings ${earnings.date}${earnings.time !== 'unknown' ? ` ${earnings.time}` : ''} — ` +
            `flat before the print regardless of P&L (earnings guard)${would}`,
    };
}

/**
 * Earnings guard for GTC positions (swings and pre-close overnight
 * setups). No momentum triage — the position keeps its thesis — but a
 * print ahead forces it flat, because only the 'earnings-bet' class is
 * sized to survive a gap. Returns null when nothing needs doing.
 */
export function decideGtcEarningsGuard(
    tradeClass: TradeClass,
    earnings: Pick<UpcomingEarnings, 'date' | 'time'> | null,
    todayIso: string,
): EodDecision | null {
    if (tradeClass === 'earnings-bet') return null; // sanctioned hold — sized for the gap
    if (!earnings || !isUpcomingPrint(earnings, todayIso)) return null;
    return {
        action: 'close',
        reason:
            `reports earnings ${earnings.date}${earnings.time !== 'unknown' ? ` ${earnings.time}` : ''} — ` +
            `a ${tradeClass} position must be flat before the print; holding through is only valid ` +
            `as an explicit earnings-bet (earnings guard)`,
    };
}

// ---------------------------------------------------------------------------
// Notifications (bridged to WhatsApp by the gateway)
// ---------------------------------------------------------------------------

type TriageCallback = (message: string) => void | Promise<void>;
const callbacks = new Set<TriageCallback>();

/** Register a callback for triage reports (idempotent per cb). */
export function onEodTriage(cb: TriageCallback): () => void {
    callbacks.add(cb);
    return () => callbacks.delete(cb);
}

async function notify(message: string): Promise<void> {
    for (const cb of [...callbacks]) {
        try { await cb(message); } catch (err) {
            logger.error(`[eod-triage] callback failed: ${err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// The 15:52 run
// ---------------------------------------------------------------------------

export function isEodTriageEnabled(): boolean {
    return (process.env.EOD_TRIAGE ?? 'true').trim().toLowerCase() !== 'false';
}

export function isEarningsGuardEnabled(): boolean {
    return (process.env.EOD_EARNINGS_GUARD ?? 'true').trim().toLowerCase() !== 'false';
}

export function isMacroWarningEnabled(): boolean {
    return (process.env.EOD_MACRO_WARNING ?? 'true').trim().toLowerCase() !== 'false';
}

export async function runEodTriageOnce(dryRun = false): Promise<void> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: ET });
    if (isMarketHoliday(today)) return;
    // Stamp at the START of the run: the boot-time catch-up must never
    // double-run behind a cron firing that is already in flight. A preview
    // (dryRun) stamps nothing — the real slot must still fire.
    if (!dryRun) markTriageRun(today, 'ran');

    // Adopted rows (WP3) are broker positions Dexter did not open and does
    // not manage — they exist so the caps see them. Triage closing one
    // would be adoption placing orders, which the adoption contract
    // forbids; the operator manages them ('close SYMBOL' still works).
    const trackable = (await listTrackable()).filter((t) => t.source !== 'adopted');
    // Momentum lane: DAY brackets + kept-overnight holds (full triage);
    // guard-only lane: deliberate GTC positions (earnings guard only);
    // unfilled-GTC lane: resting entries that would survive the close.
    const { momentum: dayCandidates, guardOnly: gtcCandidates, unfilledGtc } = splitTriageCandidates(trackable);

    // Review-17 P1: enumerate the broker BEFORE deciding there is no work.
    // An account holding only adopted/manual positions has no managed
    // candidates, yet its book still rides the night — the whole-book vet
    // below must see it. Return only when there is genuinely nothing.
    const api = await getIBApi();
    const positions = await fetchPositions(api);
    if (dayCandidates.length === 0 && gtcCandidates.length === 0 && unfilledGtc.length === 0
        && !positions.some((p) => p.quantity !== 0)) return;
    const lines: string[] = [];
    const closedSymbols = new Set<string>();

    // Earnings guard: one calendar lookup for all candidates. Unavailable
    // days fail OPEN (no forced close on unverifiable data) but are called
    // out in the report so a KEEP is never mistaken for "verified safe".
    let earningsBySymbol = new Map<string, UpcomingEarnings>();
    let earningsUnknownDays: string[] = [];
    // REQ-EOD-002: a TOTAL lookup failure is not "no earnings" — it makes
    // every DAY keep unverifiable, and unverifiable keeps fail closed.
    // Per-day partial gaps stay fail-open (recorded decision), reported.
    let earningsLookupFailed = false;
    if (isEarningsGuardEnabled()) {
        try {
            const symbols = [...new Set([...dayCandidates, ...gtcCandidates, ...unfilledGtc].map((t) => t.symbol))];
            const { hits, unknownDays } = await findUpcomingEarnings(symbols, EARNINGS_GUARD_DAYS);
            earningsBySymbol = new Map(hits.map((h) => [h.symbol, h]));
            earningsUnknownDays = unknownDays;
        } catch (err) {
            logger.warn(`[eod-triage] earnings lookup FAILED — DAY keeps fail closed this run (REQ-EOD-002): ${err}`);
            earningsUnknownDays = ['lookup failed'];
            earningsLookupFailed = true;
        }
    }

    const overrides = activeKeepOverrides();
    const lastBySymbol = new Map<string, number>();
    /** DAY closes that did NOT confirm flat — still holding (omission 5). */
    const failedCloses = new Map<string, string>();
    // Keeps surviving the momentum/earnings decisions — the conversion book
    // the overnight vet (WP5) prices next.
    const vetCandidates: Array<OvernightVetCandidate & { pos?: { quantity: number; avgCost: number } }> = [];

    for (const t of dayCandidates) {
        const pos = positions.find((p) => p.symbol === t.symbol && p.quantity !== 0);
        if (!pos) continue; // already flat (target/stop just filled, or closed)

        let last: number | null = null;
        let hourAgo: number | null = null;
        try {
            const bars = (await fetchBars(t.symbol, BarSizeSetting.MINUTES_ONE, '1 D', true))
                .filter((b) => b.close != null);
            last = bars[bars.length - 1]?.close ?? null;
            // WP11: located by TIMESTAMP — index arithmetic assumed a
            // gapless series and reached back hours on thin names.
            hourAgo = priceMinutesBack(bars, FADE_LOOKBACK_MIN, barTimeFrameMs);
        } catch (err) {
            logger.warn(`[eod-triage] ${t.symbol}: bars unavailable (${err instanceof Error ? err.message : err})`);
        }
        if (last !== null) lastBySymbol.set(t.symbol, last);

        // WP11 double-close guard (D4: one 'close SYMBOL' means flat — the
        // FIRST close this run wins; a second same-symbol proposal's close
        // would re-fetch the still-nonzero position and place a second
        // full-size MKT order, a net REVERSAL).
        if (closedSymbols.has(t.symbol)) {
            lines.push(`• ${t.symbol} (${t.keptOvernightAt != null ? `${t.id}, kept-overnight` : t.id}): already closed this run (stacked proposal) — no second order.`);
            continue;
        }

        // Fail-closed base decision (WP5) → operator override (D2) →
        // earnings guard LAST: 'keep SYMBOL' never holds through a print.
        const base = decideEodAction({ direction: t.direction, entryFill: t.entryFillPrice!, last: last ?? 0, hourAgo });
        const afterOverride = base.action === 'close' && overrides.has(t.symbol)
            ? { action: 'keep' as const, reason: `operator override ('keep ${t.symbol}') — would otherwise close: ${base.reason}` }
            : base;
        const guarded = applyEarningsGuard(afterOverride, earningsBySymbol.get(t.symbol) ?? null, today);
        const decision = applyLookupFailurePolicy(guarded, earningsLookupFailed, overrides.has(t.symbol));

        const label = t.keptOvernightAt != null ? `${t.id}, kept-overnight` : t.id;
        logger.info(`[eod-triage] ${t.id} ${t.symbol}: ${decision.action} — ${decision.reason}${dryRun ? ' (preview)' : ''}`);
        if (decision.action === 'close') {
            if (dryRun) {
                lines.push(`• ${t.symbol} (${label}): WILL CLOSE at 15:52 — ${decision.reason}`);
                continue;
            }
            const outcome = await closePosition(t.symbol, 'EOD triage');
            // Review 2026-08-21: only a FILLED close is closed — a working
            // or unconfirmed order is not flat, stays in the book math,
            // and the report must say so instead of 'Closed.'.
            // Round-10 review: 'closed' means CONFIRMED FLAT, not 'the
            // close order filled' — an over-close incident must surface.
            if (outcome.state === 'filled' && outcome.flat === true) closedSymbols.add(t.symbol);
            else failedCloses.set(t.symbol, label); // omission 5: still holding — must weigh on the overnight book
            lines.push(`• ${t.symbol} (${label}): ${decision.reason}. ${outcome.clean === true ? 'Closed.' : outcome.message}`);
        } else {
            lines.push(`• ${t.symbol} (${label}): ${decision.reason}.`);
            const pnlPct = last !== null && t.entryFillPrice
                ? (t.direction === 'long'
                    ? ((last - t.entryFillPrice) / t.entryFillPrice) * 100
                    : ((t.entryFillPrice - last) / t.entryFillPrice) * 100)
                : null;
            vetCandidates.push({
                symbol: t.symbol,
                label,
                marketValueUsd: last !== null ? Math.abs(pos.quantity) * last : null,
                pnlPct,
                // REQ-EOD-001: the cost-basis notional an overridden
                // unpriceable position still counts at in the vet.
                fallbackValueUsd: pos.avgCost > 0 ? Math.abs(pos.quantity) * pos.avgCost : null,
                pos,
            });
        }
    }

    // GTC positions: silent when healthy (their brackets survive the bell);
    // a line only when the guard closes one, or an earnings bet is about
    // to do exactly what it was sized for.
    for (const t of gtcCandidates) {
        const pos = positions.find((p) => p.symbol === t.symbol && p.quantity !== 0);
        if (!pos) continue;

        const hit = earningsBySymbol.get(t.symbol) ?? null;
        if (t.tradeClass === 'earnings-bet' && hit && isUpcomingPrint(hit, today)) {
            lines.push(`• ${t.symbol} (${t.id}, earnings-bet): holds through the ${hit.date} print BY DESIGN — sized for the worst-case gap.`);
            continue;
        }
        const decision = decideGtcEarningsGuard(t.tradeClass, hit, today);
        if (!decision) continue;

        logger.info(`[eod-triage] ${t.id} ${t.symbol} {${t.tradeClass}, GTC}: ${decision.action} — ${decision.reason}${dryRun ? ' (preview)' : ''}`);
        if (closedSymbols.has(t.symbol)) {
            lines.push(`• ${t.symbol} (${t.id}, ${t.tradeClass} GTC): already closed this run — no second order.`);
            continue;
        }
        if (dryRun) {
            lines.push(`• ${t.symbol} (${t.id}, ${t.tradeClass} GTC): WILL CLOSE at 15:52 — ${decision.reason} (earnings guard: 'keep' does NOT override)`);
            continue;
        }
        const outcome = await closePosition(t.symbol, 'EOD triage (earnings guard)');
        if (outcome.state === 'filled' && outcome.flat === true) closedSymbols.add(t.symbol);
        lines.push(`• ${t.symbol} (${t.id}, ${t.tradeClass} GTC): ${decision.reason}. ${outcome.clean === true ? 'Closed.' : outcome.message}`);
    }

    // Whole-book overnight vet (WP5 + review 2026-08-23): EVERYTHING that
    // survives the bell — keep-override conversions AND deliberate GTC
    // positions — is vetted at market value against the overnight caps and
    // the gap-stress budget. A GTC book alone could lose 2× the daily-loss
    // budget under the configured shock while only conversions were
    // stressed. Earnings bets are counted at max(their own worst historical
    // gap, the base stress) but never trimmed — holding through the print
    // IS the class; the 🌙 conversion at the bell then only fires on
    // gate-passed DAY positions (wasVettedKeepToday).
    const daySymbols = new Set(vetCandidates.map((k) => k.symbol));
    const baseStress = getRiskRules().overnight_gap_stress_pct;
    // Review-17 P1: the whole-book additions must price the book AS IT IS
    // NOW — the boot-time snapshot predates every close above and would
    // resurrect symbols already flattened (or miss a failed close that is
    // in fact still holding).
    const positionsNow = dryRun ? positions : await fetchPositions(api);
    const gtcSeen = new Set<string>();
    for (const t of gtcCandidates) {
        if (gtcSeen.has(t.symbol) || daySymbols.has(t.symbol) || closedSymbols.has(t.symbol)) continue;
        gtcSeen.add(t.symbol);
        const pos = positionsNow.find((p) => p.symbol === t.symbol && p.quantity !== 0);
        if (!pos) continue;
        let last: number | null = lastBySymbol.get(t.symbol) ?? null;
        if (last === null) {
            try {
                const bars = (await fetchBars(t.symbol, BarSizeSetting.MINUTES_ONE, '1 D', true)).filter((b) => b.close != null);
                last = bars[bars.length - 1]?.close ?? null;
            } catch { /* cost-basis mark below — a data hiccup must not close a deliberate swing */ }
        }
        const costMark = last === null;
        const mv = last !== null
            ? Math.abs(pos.quantity) * last
            : pos.avgCost > 0 ? Math.abs(pos.quantity) * pos.avgCost : null;
        const pnlPct = last !== null && t.entryFillPrice
            ? (t.direction === 'long'
                ? ((last - t.entryFillPrice) / t.entryFillPrice) * 100
                : ((t.entryFillPrice - last) / t.entryFillPrice) * 100)
            : null;
        vetCandidates.push({
            symbol: t.symbol,
            label: `${t.id}, ${t.tradeClass} GTC${costMark ? ', cost-basis mark' : ''}`,
            marketValueUsd: mv,
            pnlPct,
            fallbackValueUsd: pos.avgCost > 0 ? Math.abs(pos.quantity) * pos.avgCost : null,
            trimExempt: t.tradeClass === 'earnings-bet',
            stressPctOverride: t.tradeClass === 'earnings-bet'
                ? Math.max(baseStress, t.worstCaseGapPct ?? 0)
                : null,
            pos,
        });
    }
    // Omission 5 (review 2026-08-23) — the stress book must be the WHOLE
    // book, not just the rows the triage manages:
    // (ii) DAY closes that did not confirm flat still hold — counted,
    //      never blindly re-closed (a second full-size MKT risks a double).
    for (const [sym, label] of failedCloses) {
        if (vetCandidates.some((k) => k.symbol === sym)) continue;
        const pos = positionsNow.find((p) => p.symbol === sym && p.quantity !== 0);
        if (!pos) continue;
        const last = lastBySymbol.get(sym) ?? null;
        vetCandidates.push({
            symbol: sym, label: `${label}, close FAILED — still holding`,
            marketValueUsd: last !== null ? Math.abs(pos.quantity) * last : (pos.avgCost > 0 ? Math.abs(pos.quantity) * pos.avgCost : null),
            pnlPct: null, trimExempt: true,
            fallbackValueUsd: pos.avgCost > 0 ? Math.abs(pos.quantity) * pos.avgCost : null,
        });
    }
    // (i) adopted/manual broker positions the triage never manages —
    //     counted at cost basis (never trimmed: not ours to close).
    for (const pos of positionsNow) {
        if (pos.quantity === 0) continue;
        if (closedSymbols.has(pos.symbol) || vetCandidates.some((k) => k.symbol === pos.symbol)) continue;
        vetCandidates.push({
            symbol: pos.symbol, label: 'adopted/manual — counted, never managed',
            marketValueUsd: pos.avgCost > 0 ? Math.abs(pos.quantity) * pos.avgCost : null,
            pnlPct: null, trimExempt: true,
            fallbackValueUsd: pos.avgCost > 0 ? Math.abs(pos.quantity) * pos.avgCost : null,
        });
    }
    // (iii) resting GTC entries: exposure-in-waiting at the worst entry
    //       basis. A non-bet trim here CANCELS the entry (safe primitive) —
    //       cancelling an order always beats closing a position. Review-17
    //       P1: a resting EARNINGS-BET entry is gap exposure-in-waiting too
    //       — counted at its own gap severity, but never trimmed (holding
    //       through the print IS the class; the guard loop reports it).
    for (const t of unfilledGtc) {
        if (vetCandidates.some((k) => k.symbol === t.symbol)) continue;
        const basis = Math.max(t.entry ?? 0, t.entryLimit ?? 0);
        if (!(basis > 0) || !(t.quantity > 0)) continue;
        const isBet = t.tradeClass === 'earnings-bet';
        vetCandidates.push({
            symbol: t.symbol, label: `${t.id}, resting ${t.tradeClass} entry`,
            marketValueUsd: basis * t.quantity, pnlPct: null,
            ...(isBet
                ? { trimExempt: true, stressPctOverride: Math.max(baseStress, t.worstCaseGapPct ?? 0) }
                : { restingEntry: t }),
        });
    }

    const vet = vetOvernightBook(vetCandidates, await getNetLiquidation(), getRiskRules(), overrides);
    const candidateBySymbol = new Map(vetCandidates.map((k) => [k.symbol, k]));
    for (const trim of vet.trims) {
        if (closedSymbols.has(trim.symbol)) continue; // WP11: already flat this run
        const cand = candidateBySymbol.get(trim.symbol);
        if (dryRun) {
            lines.push(`• ${trim.symbol} (${trim.label}): WILL ${cand?.restingEntry ? 'CANCEL the resting entry' : 'TRIM'} at 15:52 — ${trim.reason}. Reply 'keep ${trim.symbol}' to hold it anyway.`);
            continue;
        }
        if (cand?.restingEntry) {
            const cancelled = await cancelEntryLeg(cand.restingEntry, `overnight vet — ${trim.reason}`)
                .catch((err: unknown) => { logger.warn(`[eod-triage] ${trim.symbol}: resting-entry cancel failed — ${err}`); return false; });
            lines.push(`• ${trim.symbol} (${trim.label}): overnight vet — ${trim.reason}. ${cancelled ? 'Resting entry cancelled (broker-confirmed).' : 'Entry cancel NOT confirmed — check orders.'}`);
            continue;
        }
        const outcome = await closePosition(trim.symbol, 'EOD triage (overnight vet trim)');
        if (outcome.state === 'filled' && outcome.flat === true) closedSymbols.add(trim.symbol);
        lines.push(`• ${trim.symbol} (${trim.label}): overnight vet — ${trim.reason}. ${outcome.clean === true ? 'Closed.' : outcome.message}`);
    }
    if (!dryRun) {
        for (const sym of daySymbols) {
            if (!vet.trims.some((tr) => tr.symbol === sym)) vettedKeeps.set(sym, today);
        }
    }

    // Unfilled GTC entries: a resting order is exposure-in-waiting. With a
    // print ahead, cancel it (the outcome tracker finalizes the proposal as
    // 'cancelled' when it sees the cancellations, same as the stale-entry
    // sweeper). An unfilled earnings-bet entry is reported, never cancelled.
    for (const t of unfilledGtc) {
        const hit = earningsBySymbol.get(t.symbol) ?? null;
        if (t.tradeClass === 'earnings-bet' && hit && isUpcomingPrint(hit, today)) {
            lines.push(`• ${t.symbol} (${t.id}, earnings-bet): entry still resting into the ${hit.date} print — final-hour window, gap-sized BY DESIGN; it expires with the proposal if unfilled.`);
            continue;
        }
        const reason = decideUnfilledEntryGuard(t.tradeClass, hit, today);
        if (!reason) continue;
        logger.info(`[eod-triage] ${t.id} ${t.symbol} {${t.tradeClass}, GTC, unfilled}: cancel — ${reason}${dryRun ? ' (preview)' : ''}`);
        if (dryRun) {
            lines.push(`• ${t.symbol} (${t.id}, ${t.tradeClass} entry UNFILLED): WILL CANCEL at 15:52 — ${reason}`);
            continue;
        }
        // Review-17 P1: never cancel the stored bracket IDs wholesale — if
        // the parent fills during that loop, the cancels strip the newly
        // live stop and target (the exact race cancelEntryLeg exists to
        // prevent). Cancel ONLY the broker-verified parent; the dormant
        // children die with it. Losing the race means the position now
        // EXISTS with a print ahead — which is precisely what the guard
        // closes on a filled position, so close it.
        const cancelled = await cancelEntryLeg(t, `EOD earnings guard — ${reason}`)
            .catch((err: unknown) => { logger.warn(`[eod-triage] ${t.symbol}: guard entry cancel failed — ${err}`); return false; });
        if (cancelled) {
            lines.push(`• ${t.symbol} (${t.id}, ${t.tradeClass} entry UNFILLED): ${reason}. Resting entry cancelled (broker-confirmed; children die with the parent).`);
            continue;
        }
        const nowPos = (await fetchPositions(api)).find((p) => p.symbol === t.symbol && p.quantity !== 0);
        if (nowPos && !closedSymbols.has(t.symbol)) {
            logger.error(`[eod-triage] ${t.id} ${t.symbol}: entry cancel lost the race — the position EXISTS with a print ahead; guard closes it`);
            const outcome = await closePosition(t.symbol, 'EOD triage (earnings guard — entry filled during cancel)');
            if (outcome.state === 'filled' && outcome.flat === true) closedSymbols.add(t.symbol);
            lines.push(`• ${t.symbol} (${t.id}, ${t.tradeClass} entry): ${reason}. ⚠️ Entry FILLED during the cancel — guard closed the position: ${outcome.clean === true ? 'Closed.' : outcome.message}`);
        } else {
            lines.push(`• ${t.symbol} (${t.id}, ${t.tradeClass} entry UNFILLED): ${reason}. ⚠️ Entry cancel NOT broker-confirmed and no position visible — verify in TWS.`);
        }
    }

    // Overnight-cap usage (advisory, never trims): everything still open
    // after the decisions above rides the night — including positions the
    // caps would have refused as deliberate GTC entries. Review-17 P1:
    // taken FRESH — the vet trims and guard closes above changed the book.
    const finalPositions = dryRun ? positionsNow : await fetchPositions(api);
    const holds = finalPositions
        .filter((pos) => pos.quantity !== 0 && !closedSymbols.has(pos.symbol))
        .map((pos) => ({ symbol: pos.symbol, valueUsd: Math.abs(pos.quantity) * pos.avgCost }));
    const capLine = holds.length
        ? overnightCapWarning(holds, await getNetLiquidation(), getRiskRules())
        : null;

    // Review-18/19 P1: the trims above were REQUESTS, not outcomes. A
    // close that did not confirm flat, or an entry cancel that lost to a
    // fill, leaves the book still carrying the excess the vet ordered
    // removed — and the first vet's math is now stale. The postcondition
    // re-vet is rebuilt ENTIRELY from broker truth: fresh positions PLUS
    // the actual working `:entry` parents in a complete open-order
    // snapshot (a partial fill counts BOTH ways — the position and the
    // still-working remainder both ride the night; the DB only supplies
    // classes). Report-only: residual trim demand, an incomplete
    // snapshot, or an unpriceable symbol is an UNRESOLVED EXCESS the
    // operator must fix by hand — a second blind close loop here would
    // risk doubling an in-flight close, so the postcondition alerts
    // loudly instead of re-firing.
    let excessLine: string | null = null;
    if (!dryRun) {
        const { fetchOpenOrderSnaps } = await import('./broker-adopt.js');
        const snap = await fetchOpenOrderSnaps(api).catch(() => ({ orders: [], complete: false }));
        // Fresh marks for held symbols the run has not priced yet
        // (adopted/manual books never enter the day loops).
        const markGaps: string[] = [];
        for (const pos of finalPositions) {
            if (pos.quantity === 0 || lastBySymbol.has(pos.symbol)) continue;
            const last = await import('./proposal-executor.js')
                .then((m) => m.fetchLastPrice(pos.symbol)).catch(() => null);
            if (last !== null && last > 0) lastBySymbol.set(pos.symbol, last);
            else markGaps.push(pos.symbol);
        }
        const built = buildRevetBook({
            positions: finalPositions,
            orders: snap.orders,
            rows: trackable,
            lastBySymbol,
            baseStress,
        });
        const revet = built.candidates.length
            ? vetOvernightBook(built.candidates, await getNetLiquidation(), getRiskRules(), overrides)
            : null;
        const problems: string[] = [];
        if (!snap.complete) problems.push('the open-orders snapshot was INCOMPLETE — resting-entry exposure is unproven');
        const unpriceable = [...new Set([...markGaps, ...built.unpriced])];
        if (unpriceable.length > 0) problems.push(`unpriceable at market: ${unpriceable.join(', ')} (cost basis counted where available)`);
        if (revet && revet.trims.length > 0) {
            problems.push(`the book STILL fails the gap-stress vet: ${revet.trims.map((tr) => `${tr.symbol} (${tr.reason})`).join('; ')}`);
        }
        if (problems.length > 0) {
            excessLine = `🚨 UNRESOLVED OVERNIGHT EXCESS — ${problems.join('; ')}. A close or cancel may have failed or lost a race — act in TWS before the bell.`;
            logger.error(`[eod-triage] ${excessLine}`);
        }
    }

    // Macro-night check (advisory, never closes): the earnings guard covers
    // single-name prints, but a keep on CPI/FOMC-eve rides a macro binary no
    // stop can protect against — the report must say so. The horizon runs to
    // the NEXT TRADING SESSION in calendar days (1 midweek, 3 across a
    // weekend): a Friday keep rides every night until Monday's open. A real
    // event forces the notification even when no position needed action; the
    // data-unavailable caveat rides along only when a report goes out anyway.
    const macroHorizonDays = Math.max(1, Math.round(
        (Date.parse(nextTradingDates(1)[0]) - Date.parse(today)) / 86_400_000,
    ));
    const macroEvents = isMacroWarningEnabled() ? await getMacroEventsWithin(macroHorizonDays) : [];
    const macroLine = macroNightWarning(macroEvents, macroHorizonDays);

    if (lines.length || (macroLine && macroEvents !== null) || capLine || vet.capLine || vet.warnings.length || excessLine) {
        const footer =
            (earningsUnknownDays.length
                ? `\n⚠ earnings calendar unavailable (${earningsUnknownDays.join(', ')}) — keeps and resting entries are NOT verified print-free.`
                : '') +
            (vet.warnings.length ? `\n${vet.warnings.join('\n')}` : '') +
            (vet.capLine ? `\n${vet.capLine}` : '') +
            (capLine ? `\n${capLine}` : '') +
            (excessLine ? `\n${excessLine}` : '') +
            (macroLine ? `\n${macroLine}` : '');
        const body = lines.length
            ? lines.join('\n')
            : `${dayCandidates.length + gtcCandidates.length} tracked position(s), none needed action.`;
        await notify(dryRun
            ? `🔭 EOD PREVIEW (12 min before triage):\n${body}${footer}\nReply 'keep SYMBOL' before 15:52 to override a fail-closed close or cap trim (never the earnings guard).`
            : `🌇 EOD triage (pre-close):\n${body}${footer}`);
    }
}

// ---------------------------------------------------------------------------
// Missed-run catch-up — SECZ post-mortem 2026-08-13: a gateway restart
// window (process down 15:50→16:00 ET) swallowed the 15:52 cron slot, and
// croner does not backfill missed firings. Five open positions reached the
// bell untriaged — no losing-and-fading close, no earnings-guard flatten.
// The run stamps a per-day marker; on boot, a missing stamp either runs the
// triage late (still before the bell — decisions are still actionable at
// RTH prices) or alerts loudly (after the bell — closing now would execute
// at tomorrow's open, a different decision that stays with the operator).
// ---------------------------------------------------------------------------

/** Minutes before the close that the triage slot fires (must match the
 *  TRIAGE_CRON_* schedules: 15:52 before a 16:00 close, 12:52 before 13:00). */
const TRIAGE_LEAD_MIN = 8;
const FULL_DAY_CLOSE_MINUTES_ET = 16 * 60;
const HALF_DAY_CLOSE_MINUTES_ET = 13 * 60;

export type TriageCatchUp = 'none' | 'run-late' | 'alert-missed';

/** Pure: what a boot at `minutesEt` (minutes since ET midnight) should do
 *  about today's triage slot. `closeMinutesEt` is today's actual regular
 *  close — 13:00 on half-days — so the catch-up window tracks the real
 *  bell, not a hard-coded 16:00. */
export function triageCatchUpAction(
    minutesEt: number,
    ranToday: boolean,
    isTradingDay: boolean,
    closeMinutesEt: number = FULL_DAY_CLOSE_MINUTES_ET,
): TriageCatchUp {
    if (!isTradingDay || ranToday) return 'none';
    const triageMinutes = closeMinutesEt - TRIAGE_LEAD_MIN;
    if (minutesEt >= triageMinutes && minutesEt < closeMinutesEt) return 'run-late';
    if (minutesEt >= closeMinutesEt) return 'alert-missed';
    return 'none'; // before the slot — the cron will fire normally
}

interface TriageRunStamp { date: string; status: 'ran' | 'missed-alerted'; at: number }

function stampPath(): string {
    return join(process.env.DEXTER_DATA_DIR || join('.dexter', 'data'), 'eod-triage-run.json');
}

function readTriageStamp(): TriageRunStamp | null {
    try {
        return JSON.parse(readFileSync(stampPath(), 'utf-8')) as TriageRunStamp;
    } catch {
        return null;
    }
}

function markTriageRun(date: string, status: TriageRunStamp['status']): void {
    try {
        writeFileSync(stampPath(), JSON.stringify({ date, status, at: Date.now() } satisfies TriageRunStamp));
    } catch (err) {
        logger.warn(`[eod-triage] run stamp persist failed: ${err}`);
    }
}

async function checkMissedTriage(): Promise<void> {
    const now = new Date();
    const todayIso = now.toLocaleDateString('en-CA', { timeZone: ET });
    const et = new Date(now.toLocaleString('en-US', { timeZone: ET }));
    const weekday = et.getDay(); // 0=Sun .. 6=Sat, in ET
    const isTradingDay = weekday >= 1 && weekday <= 5 && !isMarketHoliday(todayIso);
    const closeMinutes = isMarketHalfDay(todayIso) ? HALF_DAY_CLOSE_MINUTES_ET : FULL_DAY_CLOSE_MINUTES_ET;
    const stamp = readTriageStamp();
    const action = triageCatchUpAction(
        et.getHours() * 60 + et.getMinutes(),
        stamp?.date === todayIso,
        isTradingDay,
        closeMinutes,
    );
    if (action === 'run-late') {
        logger.warn('[eod-triage] today\'s pre-close slot was missed (gateway was down) — running catch-up triage now');
        await runEodTriageOnce();
    } else if (action === 'alert-missed') {
        markTriageRun(todayIso, 'missed-alerted'); // once per day, across restarts
        logger.warn('[eod-triage] today\'s pre-close slot was missed and the bell has rung — positions went untriaged');
        await notify(
            '⚠️ EOD TRIAGE MISSED today: the gateway was down at the pre-close slot and came back after the bell. ' +
            'Open positions reached the close untriaged — no losing-and-fading close, no earnings-guard flatten. ' +
            'The 🌙 conversion still protects expired DAY brackets; review \'positions\' and close anything you would not hold.',
        );
    }
}

let job: Cron | null = null;
let halfDayJob: Cron | null = null;
let previewJob: Cron | null = null;
let previewHalfDayJob: Cron | null = null;

/** True when the slot firing now is the right one for today: the 12:52
 *  slot on half-days, the 15:52 slot otherwise. The other slot yields. */
function slotMatchesToday(halfDaySlot: boolean): boolean {
    const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: ET });
    return isMarketHalfDay(todayIso) === halfDaySlot;
}

/** Start the pre-close triage (idempotent; no-op when disabled). */
export function startEodTriage(): void {
    if (job || !isEodTriageEnabled()) return;
    job = new Cron(TRIAGE_CRON_FULL, { timezone: ET }, () => {
        if (!slotMatchesToday(false)) return; // half-day: 12:52 already ran
        runEodTriageOnce().catch((err) => logger.error(`[eod-triage] run failed: ${err}`));
    });
    halfDayJob = new Cron(TRIAGE_CRON_HALF, { timezone: ET }, () => {
        if (!slotMatchesToday(true)) return; // normal day: wait for 15:52
        runEodTriageOnce().catch((err) => logger.error(`[eod-triage] half-day run failed: ${err}`));
    });
    previewJob = new Cron(PREVIEW_CRON_FULL, { timezone: ET }, () => {
        if (!slotMatchesToday(false)) return;
        runEodTriageOnce(true).catch((err) => logger.error(`[eod-triage] preview failed: ${err}`));
    });
    previewHalfDayJob = new Cron(PREVIEW_CRON_HALF, { timezone: ET }, () => {
        if (!slotMatchesToday(true)) return;
        runEodTriageOnce(true).catch((err) => logger.error(`[eod-triage] half-day preview failed: ${err}`));
    });
    logger.info(
        '[eod-triage] scheduled 15:52 ET (12:52 on half-days): close losing-and-fading DAY positions; keep the rest for protected overnight' +
        (isEarningsGuardEnabled()
            ? `; earnings guard ON (flat before any print within ${EARNINGS_GUARD_DAYS} trading day(s) — Friday reaches Monday; DAY and GTC non-bet classes; past BMO prints exempt)`
            : '; earnings guard OFF'),
    );
    // Boot-time catch-up, delayed so the IBKR connection and the WhatsApp
    // alert bridge finish wiring first. Wall-clock dependent — gated off in
    // tests like the other session-time logic (the pure decision is tested).
    if (process.env.NODE_ENV !== 'test') {
        setTimeout(() => {
            checkMissedTriage().catch((err) => logger.error(`[eod-triage] catch-up check failed: ${err}`));
        }, 15_000);
    }
}

export function stopEodTriage(): void {
    if (previewHalfDayJob) { previewHalfDayJob.stop(); previewHalfDayJob = null; }
    if (previewJob) { previewJob.stop(); previewJob = null; }
    if (halfDayJob) { halfDayJob.stop(); halfDayJob = null; }
    if (job) { job.stop(); job = null; }
}
