/**
 * End-of-day triage — decide, per unresolved DAY position, whether it
 * deserves the night.
 *
 * Operator policy (2026-07-30): do NOT flatten intraday positions at the
 * close by default. Instead, at 15:52 ET each filled DAY-bracket position
 * is triaged:
 *
 *   CLOSE before the bell  — losing vs the entry fill AND the last hour's
 *                            momentum still running against the position
 *                            ("the horizon is fading");
 *   KEEP                   — everything else: winners, and losers that are
 *                            stabilizing/recovering. At the bell the DAY
 *                            exits expire and auto-protect converts the
 *                            position to a 🌙 protected overnight hold.
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
import { closePosition, fetchPositions } from './position-actions.js';
import { listTrackable } from './trade-proposals.js';
import { getRiskRules, type TradeClass } from '@/tools/ibkr/risk-rules.js';

const ET = 'America/New_York';
// Two slots, 8 minutes before each possible close: 15:52 for a normal 16:00
// close, 12:52 for a 13:00 half-day close. Each firing checks which kind of
// day today is and yields to the other slot — without this, half-days ran
// triage at 15:52, almost three hours AFTER the DAY brackets expired at
// 13:00, on positions whose protection was already gone (audit 2026-08-20).
const TRIAGE_CRON_FULL = '52 15 * * 1-5';
const TRIAGE_CRON_HALF = '52 12 * * 1-5';
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
 * Close only when BOTH hold: the position is losing against its entry
 * fill, and price has kept moving against it over the fade lookback.
 * Unknown momentum (no hour-ago price) never closes — when in doubt, the
 * position keeps its overnight chance.
 */
export function decideEodAction(input: {
    direction: 'long' | 'short';
    entryFill: number;
    last: number;
    hourAgo: number | null;
}): EodDecision {
    const { direction, entryFill, last, hourAgo } = input;
    if (!(last > 0) || !(entryFill > 0)) return { action: 'keep', reason: 'price unavailable — keeping (fail-open to hold)' };

    const pnlPct = direction === 'long'
        ? ((last - entryFill) / entryFill) * 100
        : ((entryFill - last) / entryFill) * 100;
    if (pnlPct >= 0) {
        return { action: 'keep', reason: `winning ${pnlPct.toFixed(2)}% — holds overnight (protected at the bell)` };
    }

    if (hourAgo === null || !(hourAgo > 0)) {
        return { action: 'keep', reason: `losing ${pnlPct.toFixed(2)}% but momentum unknown — keeping` };
    }
    const drift = direction === 'long' ? last - hourAgo : hourAgo - last;
    if (drift < 0) {
        const driftPct = (Math.abs(drift) / hourAgo) * 100;
        return {
            action: 'close',
            reason: `losing ${pnlPct.toFixed(2)}% and still fading (${driftPct.toFixed(2)}% against us over the last hour) — closing before the bell`,
        };
    }
    return { action: 'keep', reason: `losing ${pnlPct.toFixed(2)}% but stabilizing/recovering over the last hour — keeping` };
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

export async function runEodTriageOnce(): Promise<void> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: ET });
    if (isMarketHoliday(today)) return;
    // Stamp at the START of the run: the boot-time catch-up must never
    // double-run behind a cron firing that is already in flight.
    markTriageRun(today, 'ran');

    // Adopted rows (WP3) are broker positions Dexter did not open and does
    // not manage — they exist so the caps see them. Triage closing one
    // would be adoption placing orders, which the adoption contract
    // forbids; the operator manages them ('close SYMBOL' still works).
    const trackable = (await listTrackable()).filter((t) => t.source !== 'adopted');
    // Momentum lane: DAY brackets + kept-overnight holds (full triage);
    // guard-only lane: deliberate GTC positions (earnings guard only);
    // unfilled-GTC lane: resting entries that would survive the close.
    const { momentum: dayCandidates, guardOnly: gtcCandidates, unfilledGtc } = splitTriageCandidates(trackable);
    if (dayCandidates.length === 0 && gtcCandidates.length === 0 && unfilledGtc.length === 0) return;

    const api = await getIBApi();
    const positions = await fetchPositions(api);
    const lines: string[] = [];
    const closedSymbols = new Set<string>();

    // Earnings guard: one calendar lookup for all candidates. Unavailable
    // days fail OPEN (no forced close on unverifiable data) but are called
    // out in the report so a KEEP is never mistaken for "verified safe".
    let earningsBySymbol = new Map<string, UpcomingEarnings>();
    let earningsUnknownDays: string[] = [];
    if (isEarningsGuardEnabled()) {
        try {
            const symbols = [...new Set([...dayCandidates, ...gtcCandidates, ...unfilledGtc].map((t) => t.symbol))];
            const { hits, unknownDays } = await findUpcomingEarnings(symbols, EARNINGS_GUARD_DAYS);
            earningsBySymbol = new Map(hits.map((h) => [h.symbol, h]));
            earningsUnknownDays = unknownDays;
        } catch (err) {
            logger.warn(`[eod-triage] earnings lookup failed (guard skipped this run): ${err}`);
            earningsUnknownDays = ['lookup failed'];
        }
    }

    for (const t of dayCandidates) {
        const pos = positions.find((p) => p.symbol === t.symbol && p.quantity !== 0);
        if (!pos) continue; // already flat (target/stop just filled, or closed)

        let last: number | null = null;
        let hourAgo: number | null = null;
        try {
            const bars = (await fetchBars(t.symbol, BarSizeSetting.MINUTES_ONE, '1 D', true))
                .filter((b) => b.close != null);
            last = bars[bars.length - 1]?.close ?? null;
            hourAgo = bars[Math.max(0, bars.length - 1 - FADE_LOOKBACK_MIN)]?.close ?? null;
        } catch (err) {
            logger.warn(`[eod-triage] ${t.symbol}: bars unavailable (${err instanceof Error ? err.message : err})`);
        }

        const base = last !== null
            ? decideEodAction({ direction: t.direction, entryFill: t.entryFillPrice!, last, hourAgo })
            : { action: 'keep' as const, reason: 'price unavailable — keeping (fail-open to hold)' };
        const decision = applyEarningsGuard(base, earningsBySymbol.get(t.symbol) ?? null, today);

        const label = t.keptOvernightAt != null ? `${t.id}, kept-overnight` : t.id;
        logger.info(`[eod-triage] ${t.id} ${t.symbol}: ${decision.action} — ${decision.reason}`);
        if (decision.action === 'close') {
            const outcome = await closePosition(t.symbol, 'EOD triage');
            if (outcome.ok) closedSymbols.add(t.symbol);
            lines.push(`• ${t.symbol} (${label}): ${decision.reason}. ${outcome.ok ? 'Closed.' : outcome.message}`);
        } else {
            lines.push(`• ${t.symbol} (${label}): ${decision.reason}.`);
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

        logger.info(`[eod-triage] ${t.id} ${t.symbol} {${t.tradeClass}, GTC}: ${decision.action} — ${decision.reason}`);
        const outcome = await closePosition(t.symbol, 'EOD triage (earnings guard)');
        if (outcome.ok) closedSymbols.add(t.symbol);
        lines.push(`• ${t.symbol} (${t.id}, ${t.tradeClass} GTC): ${decision.reason}. ${outcome.ok ? 'Closed.' : outcome.message}`);
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
        logger.info(`[eod-triage] ${t.id} ${t.symbol} {${t.tradeClass}, GTC, unfilled}: cancel — ${reason}`);
        let cancelled = 0;
        for (const oid of t.orderIds ?? []) {
            try { api.cancelOrder(oid); cancelled++; } catch { /* already gone */ }
        }
        lines.push(`• ${t.symbol} (${t.id}, ${t.tradeClass} entry UNFILLED): ${reason}. ${cancelled ? `${cancelled} resting order(s) cancelled.` : 'No live orders found — check ibkr_orders.'}`);
    }

    // Overnight-cap usage (advisory, never trims): everything still open
    // after the decisions above rides the night — including positions the
    // caps would have refused as deliberate GTC entries.
    const holds = positions
        .filter((pos) => pos.quantity !== 0 && !closedSymbols.has(pos.symbol))
        .map((pos) => ({ symbol: pos.symbol, valueUsd: Math.abs(pos.quantity) * pos.avgCost }));
    const capLine = holds.length
        ? overnightCapWarning(holds, await getNetLiquidation(), getRiskRules())
        : null;

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

    if (lines.length || (macroLine && macroEvents !== null) || capLine) {
        const footer =
            (earningsUnknownDays.length
                ? `\n⚠ earnings calendar unavailable (${earningsUnknownDays.join(', ')}) — keeps and resting entries are NOT verified print-free.`
                : '') +
            (capLine ? `\n${capLine}` : '') +
            (macroLine ? `\n${macroLine}` : '');
        const body = lines.length
            ? lines.join('\n')
            : `${dayCandidates.length + gtcCandidates.length} tracked position(s), none needed action.`;
        await notify(`🌇 EOD triage (pre-close):\n${body}${footer}`);
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
    if (halfDayJob) { halfDayJob.stop(); halfDayJob = null; }
    if (job) { job.stop(); job = null; }
}
