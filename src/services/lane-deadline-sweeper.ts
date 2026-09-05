/**
 * Lane deadline sweeper (REQ-LANE-003, four-lane program WP5; review
 * 2026-09-06 finding 3).
 *
 * Every lane with a holding horizon beyond the session carries an exit
 * deadline stamped at entry fill (lane-contract.ts): the overnight lane's
 * 10:00 ET of the next session, a swing's or cup-and-handle's last trading
 * day at 15:50 ET. This sweeper runs every 60 s inside the regular session
 * and closes any still-open position at or past its deadline through the
 * SAFE close path (`closePosition` — the same primitive as `kill` and the
 * EOD triage: cancels the resting exits, market-closes, confirms flat).
 *
 * Two marks, two meanings:
 *   deadline_attempted_at / deadline_attempts — an attempt STARTED (stamped
 *     before the order goes out, so a crash mid-close is visible); the row
 *     is retried after COOLDOWN_MS, at most MAX_ATTEMPTS times — a close
 *     that failed to reach the broker is not a terminal state;
 *   deadline_closed_at — the broker CONFIRMED flat (or the position was
 *     already flat: the bracket exit owned the close).
 * A double close is bounded, not assumed away: every attempt re-reads the
 * broker positions first, and a market close still unfilled five minutes
 * later during the regular session is itself the incident the alert names.
 * Only a VERIFIED flat (closePosition's `flat === true`) confirms a close;
 * a symbol absent from a PARTIAL positions book is neither flat nor held
 * and the row simply waits for the next tick.
 * When the attempts are exhausted the alert says so and hands the row to
 * the operator ('kill SYMBOL'); a deadline is never converted into a longer
 * hold.
 */

import { logger } from '@/utils';
import { getMarketSession, MarketSession } from '@/utils/market-hours.js';
import { emitLoopAlert } from './loop/alerts.js';
import type { TradeProposal } from './trade-proposals.js';

const SWEEP_INTERVAL_MS = 60_000;
/** Wait this long before re-attempting a close that did not confirm flat. */
export const DEADLINE_RETRY_COOLDOWN_MS = 5 * 60_000;
/** Attempts before the row is handed to the operator. */
export const DEADLINE_MAX_ATTEMPTS = 3;

export interface DeadlineCloseOutcome {
    ok: boolean;
    message: string;
    state?: string;
    flat?: boolean | null;
}

export interface PositionsView {
    positions: Array<{ symbol: string; quantity: number }>;
    /** false = the broker's positionEnd never arrived — a PARTIAL book. A
     *  symbol absent from a partial book is NOT known flat (review
     *  2026-09-06 second pass, finding 2). */
    complete: boolean;
}

export interface DeadlineSweepDeps {
    now: number;
    /** Due rows: deadline passed, not confirmed closed, cooldown elapsed, attempts left. */
    listDue: (nowMs: number, cooldownMs: number, maxAttempts: number) => Promise<TradeProposal[]>;
    positions: () => Promise<PositionsView>;
    close: (symbol: string, reason: string) => Promise<DeadlineCloseOutcome>;
    /** Record an attempt (before the order). */
    markAttempt: (id: string, at: number, note: string) => Promise<void>;
    /** Record the confirmed close. */
    markClosed: (id: string, at: number, note: string) => Promise<void>;
    alert?: (message: string) => void;
}

export interface DeadlineSweepResult {
    due: number;
    closed: number;
    alreadyFlat: number;
    /** Rows left untouched this tick because the broker book was partial and
     *  the symbol was not in it — neither flat nor held is known. */
    unverifiable: number;
    /** Attempts that did not confirm flat (retried after the cooldown or handed over). */
    incidents: string[];
}

/** Pure: the rows whose deadline has passed, not confirmed closed, outside
 *  the retry cooldown and under the attempt cap. */
export function selectDueDeadlines<T extends {
    exitDeadline: number | null; deadlineClosedAt: number | null; deadlineAttemptedAt: number | null; deadlineAttempts: number;
    status: string; entryFillPrice: number | null;
}>(rows: T[], nowMs: number, cooldownMs = DEADLINE_RETRY_COOLDOWN_MS, maxAttempts = DEADLINE_MAX_ATTEMPTS): T[] {
    return rows.filter((r) =>
        r.status === 'executed' && r.entryFillPrice !== null && r.exitDeadline !== null && r.exitDeadline <= nowMs
        && r.deadlineClosedAt === null
        && (r.deadlineAttemptedAt === null || r.deadlineAttemptedAt <= nowMs - cooldownMs)
        && r.deadlineAttempts < maxAttempts);
}

export async function sweepDeadlinesOnce(deps: DeadlineSweepDeps): Promise<DeadlineSweepResult> {
    const due = await deps.listDue(deps.now, DEADLINE_RETRY_COOLDOWN_MS, DEADLINE_MAX_ATTEMPTS);
    const result: DeadlineSweepResult = { due: due.length, closed: 0, alreadyFlat: 0, unverifiable: 0, incidents: [] };
    if (due.length === 0) return result;
    const book = await deps.positions();
    for (const p of due) {
        const label = `${p.id} ${p.symbol} (${p.strategyId ?? p.tradeClass}, deadline ${new Date(p.exitDeadline ?? 0).toISOString()})`;
        const pos = book.positions.find((x) => x.symbol.toUpperCase() === p.symbol.toUpperCase() && x.quantity !== 0);
        if (!pos) {
            if (!book.complete) {
                // A partial book proves nothing about an absent symbol: leave
                // the row due for the next tick (no stamp, no order).
                result.unverifiable++;
                logger.warn(`[lane-deadline] ${label}: positions snapshot incomplete and the symbol is absent — not marked, retried next tick`);
                continue;
            }
            await deps.markClosed(p.id, deps.now, 'lane deadline reached with no open position — the bracket exit owns the close');
            result.alreadyFlat++;
            logger.info(`[lane-deadline] ${label}: already flat — stamped`);
            continue;
        }
        const attempt = p.deadlineAttempts + 1;
        // The attempt is recorded BEFORE the order so a crash mid-close is
        // visible and the next tick waits the cooldown instead of firing again.
        await deps.markAttempt(p.id, deps.now, `lane deadline close attempt ${attempt}/${DEADLINE_MAX_ATTEMPTS} (${p.strategyId ?? p.tradeClass})`);
        let outcome: DeadlineCloseOutcome;
        try {
            outcome = await deps.close(p.symbol, `lane deadline (${p.strategyId ?? p.tradeClass})`);
        } catch (err) {
            outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
        // Only a VERIFIED flat position closes the row (review 2026-09-06
        // second pass, finding 1): closePosition reports the order state and
        // the residual position separately — 'filled' with flat false/null is
        // an incident, not a close.
        if (outcome.ok && outcome.flat === true) {
            await deps.markClosed(p.id, deps.now, `lane deadline close confirmed flat — ${outcome.message}`);
            result.closed++;
            logger.info(`[lane-deadline] ${label}: closed — ${outcome.message}`);
        } else {
            const exhausted = attempt >= DEADLINE_MAX_ATTEMPTS;
            const line = exhausted
                ? `🚨 lane deadline: ${label} close NOT confirmed flat after ${attempt} attempts — ${outcome.message}. Retries exhausted: act in TWS or 'kill ${p.symbol}'.`
                : `⚠️ lane deadline: ${label} close NOT confirmed flat (attempt ${attempt}/${DEADLINE_MAX_ATTEMPTS}) — ${outcome.message}. Retry in ${DEADLINE_RETRY_COOLDOWN_MS / 60_000} min; 'kill ${p.symbol}' to act now.`;
            result.incidents.push(line);
            logger.error(`[lane-deadline] ${line}`);
            deps.alert?.(line);
        }
    }
    return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startLaneDeadlineSweeper(): void {
    if (timer) return;
    timer = setInterval(() => {
        if (inFlight) return;
        if (getMarketSession().session !== MarketSession.REGULAR) return;
        inFlight = true;
        (async () => {
            const [{ listDeadlineDue, markDeadlineAttempt, markDeadlineClosed }, { closePosition }, { requestPositions }, { getIBApi }] = await Promise.all([
                import('./trade-proposals.js'),
                import('./position-actions.js'),
                import('@/tools/ibkr/positions.js'),
                import('@/tools/ibkr/connection.js'),
            ]);
            const r = await sweepDeadlinesOnce({
                now: Date.now(),
                listDue: listDeadlineDue,
                // The COMPLETE flag matters: a partial book must not read as flat.
                positions: async () => {
                    const snap = await requestPositions(await getIBApi());
                    return { positions: snap.positions.map((p) => ({ symbol: p.symbol, quantity: p.quantity })), complete: snap.complete };
                },
                close: (symbol, reason) => closePosition(symbol, reason),
                markAttempt: markDeadlineAttempt,
                markClosed: markDeadlineClosed,
                alert: emitLoopAlert,
            });
            if (r.due > 0) logger.info(`[lane-deadline] sweep: ${JSON.stringify(r)}`);
        })().catch((err) => logger.warn(`[lane-deadline] sweep failed: ${err}`)).finally(() => { inFlight = false; });
    }, SWEEP_INTERVAL_MS);
    logger.info(`[lane-deadline] started: lane exit deadlines swept every ${SWEEP_INTERVAL_MS / 1000}s during the regular session (REQ-LANE-003)`);
}

export function stopLaneDeadlineSweeper(): void {
    if (timer) { clearInterval(timer); timer = null; }
}
