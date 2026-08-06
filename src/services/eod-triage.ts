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
 *   - A print dated TODAY with 'pre-market' timing already happened by
 *     15:52 — closing on it would flatten exactly the legitimate
 *     post-print reaction trades this desk exists to take. Past prints
 *     never trigger the guard ('unknown' timing stays conservative).
 *
 * Deterministic, no LLM. Disable with EOD_TRIAGE=false.
 */

import { BarSizeSetting } from '@stoqey/ib';
import { Cron } from 'croner';
import { getIBApi } from '@/tools/ibkr/connection.js';
import { fetchBars } from '@/tools/ibkr/signal-scorer.js';
import { logger } from '@/utils';
import { isMarketHoliday } from '@/utils/market-hours.js';
import { findUpcomingEarnings, type UpcomingEarnings } from './earnings-calendar.js';
import { closePosition, fetchPositions } from './position-actions.js';
import { listTrackable } from './trade-proposals.js';
import type { TradeClass } from '@/tools/ibkr/risk-rules.js';

const ET = 'America/New_York';
const TRIAGE_CRON = '52 15 * * 1-5';
const FADE_LOOKBACK_MIN = 60;
/** Close before the bell when the symbol reports within this many days
 *  (0 = today's print after the close, 1 = tomorrow pre-market too). */
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

export async function runEodTriageOnce(): Promise<void> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: ET });
    if (isMarketHoliday(today)) return;

    const trackable = await listTrackable();
    // Filled DAY-bracket proposals still working = positions whose exits
    // die at the bell → full triage (momentum + earnings guard).
    const dayCandidates = trackable.filter((t) => t.tif === 'DAY' && t.entryFillPrice != null);
    // Filled GTC positions (swings, overnight setups, earnings bets) →
    // earnings guard only; their exits survive the close.
    const gtcCandidates = trackable.filter((t) => t.tif === 'GTC' && t.entryFillPrice != null);
    if (dayCandidates.length === 0 && gtcCandidates.length === 0) return;

    const api = await getIBApi();
    const positions = await fetchPositions(api);
    const lines: string[] = [];

    // Earnings guard: one calendar lookup for all candidates. Unavailable
    // days fail OPEN (no forced close on unverifiable data) but are called
    // out in the report so a KEEP is never mistaken for "verified safe".
    let earningsBySymbol = new Map<string, UpcomingEarnings>();
    let earningsUnknownDays: string[] = [];
    if (isEarningsGuardEnabled()) {
        try {
            const symbols = [...new Set([...dayCandidates, ...gtcCandidates].map((t) => t.symbol))];
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

        logger.info(`[eod-triage] ${t.id} ${t.symbol}: ${decision.action} — ${decision.reason}`);
        if (decision.action === 'close') {
            const outcome = await closePosition(t.symbol, 'EOD triage');
            lines.push(`• ${t.symbol} (${t.id}): ${decision.reason}. ${outcome.ok ? 'Closed.' : outcome.message}`);
        } else {
            lines.push(`• ${t.symbol} (${t.id}): ${decision.reason}.`);
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
        lines.push(`• ${t.symbol} (${t.id}, ${t.tradeClass} GTC): ${decision.reason}. ${outcome.ok ? 'Closed.' : outcome.message}`);
    }

    if (lines.length) {
        const footer = earningsUnknownDays.length
            ? `\n⚠ earnings calendar unavailable (${earningsUnknownDays.join(', ')}) — keeps are NOT verified print-free.`
            : '';
        await notify(`🌇 EOD triage (15:52 ET):\n${lines.join('\n')}${footer}`);
    }
}

let job: Cron | null = null;

/** Start the 15:52 ET triage (idempotent; no-op when disabled). */
export function startEodTriage(): void {
    if (job || !isEodTriageEnabled()) return;
    job = new Cron(TRIAGE_CRON, { timezone: ET }, () => {
        runEodTriageOnce().catch((err) => logger.error(`[eod-triage] run failed: ${err}`));
    });
    logger.info(
        '[eod-triage] scheduled 15:52 ET: close losing-and-fading DAY positions; keep the rest for protected overnight' +
        (isEarningsGuardEnabled()
            ? `; earnings guard ON (flat before any print within ${EARNINGS_GUARD_DAYS}d, DAY and GTC non-bet classes; past BMO prints exempt)`
            : '; earnings guard OFF'),
    );
}

export function stopEodTriage(): void {
    if (job) { job.stop(); job = null; }
}
