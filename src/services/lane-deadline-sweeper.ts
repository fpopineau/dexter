/**
 * Lane deadline sweeper (REQ-LANE-003, four-lane program WP5).
 *
 * Every lane with a holding horizon beyond the session carries an exit
 * deadline stamped at entry fill (lane-contract.ts): the overnight lane's
 * 10:00 ET of the next session, a swing's or cup-and-handle's last trading
 * day at 15:50 ET. This sweeper runs every 60 s inside the regular session
 * and closes any still-open position at or past its deadline through the
 * SAFE close path (`closePosition` — the same primitive as `kill` and the
 * EOD triage: cancels the resting exits, market-closes, confirms flat).
 *
 * ONE attempt per row: the row is stamped `deadline_closed_at` on the first
 * attempt whatever the outcome, so a working close order is never doubled
 * by the next tick. A close that does not confirm flat is an INCIDENT
 * (alert + log); a deadline is never converted into a longer hold. A row
 * whose bracket already exited (no position) is stamped without an order —
 * the tracker owns its close.
 */

import { logger } from '@/utils';
import { getMarketSession, MarketSession } from '@/utils/market-hours.js';
import { emitLoopAlert } from './loop/alerts.js';
import type { TradeProposal } from './trade-proposals.js';

const SWEEP_INTERVAL_MS = 60_000;

export interface DeadlineCloseOutcome {
    ok: boolean;
    message: string;
    state?: string;
    flat?: boolean | null;
}

export interface DeadlineSweepDeps {
    now: number;
    listDue: (nowMs: number) => Promise<TradeProposal[]>;
    positions: () => Promise<Array<{ symbol: string; quantity: number }>>;
    close: (symbol: string, reason: string) => Promise<DeadlineCloseOutcome>;
    markClosed: (id: string, at: number, note: string) => Promise<void>;
    alert?: (message: string) => void;
}

export interface DeadlineSweepResult {
    due: number;
    closed: number;
    alreadyFlat: number;
    incidents: string[];
}

/** Pure: the rows whose deadline has passed and that were never attempted. */
export function selectDueDeadlines<T extends { exitDeadline: number | null; deadlineClosedAt: number | null; status: string; entryFillPrice: number | null }>(rows: T[], nowMs: number): T[] {
    return rows.filter((r) => r.status === 'executed' && r.entryFillPrice !== null && r.exitDeadline !== null && r.exitDeadline <= nowMs && r.deadlineClosedAt === null);
}

export async function sweepDeadlinesOnce(deps: DeadlineSweepDeps): Promise<DeadlineSweepResult> {
    const due = await deps.listDue(deps.now);
    const result: DeadlineSweepResult = { due: due.length, closed: 0, alreadyFlat: 0, incidents: [] };
    if (due.length === 0) return result;
    const positions = await deps.positions();
    for (const p of due) {
        const label = `${p.id} ${p.symbol} (${p.strategyId ?? p.tradeClass}, deadline ${new Date(p.exitDeadline ?? 0).toISOString()})`;
        const pos = positions.find((x) => x.symbol.toUpperCase() === p.symbol.toUpperCase() && x.quantity !== 0);
        if (!pos) {
            await deps.markClosed(p.id, deps.now, 'lane deadline reached with no open position — the bracket exit owns the close');
            result.alreadyFlat++;
            logger.info(`[lane-deadline] ${label}: already flat — stamped`);
            continue;
        }
        // Stamp BEFORE the order so a crash mid-close cannot re-issue it.
        await deps.markClosed(p.id, deps.now, `lane deadline close attempted (${p.strategyId ?? p.tradeClass})`);
        let outcome: DeadlineCloseOutcome;
        try {
            outcome = await deps.close(p.symbol, `lane deadline (${p.strategyId ?? p.tradeClass})`);
        } catch (err) {
            outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
        if (outcome.ok && (outcome.flat === true || outcome.state === 'filled')) {
            result.closed++;
            logger.info(`[lane-deadline] ${label}: closed — ${outcome.message}`);
        } else {
            const line = `⚠️ lane deadline: ${label} close NOT confirmed flat — ${outcome.message}. Act in TWS or 'kill ${p.symbol}'.`;
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
            const [{ listDeadlineDue, markDeadlineClosed }, { closePosition, fetchPositions }, { getIBApi }] = await Promise.all([
                import('./trade-proposals.js'),
                import('./position-actions.js'),
                import('@/tools/ibkr/connection.js'),
            ]);
            const r = await sweepDeadlinesOnce({
                now: Date.now(),
                listDue: listDeadlineDue,
                positions: async () => (await fetchPositions(await getIBApi())).map((p) => ({ symbol: p.symbol, quantity: p.quantity })),
                close: (symbol, reason) => closePosition(symbol, reason),
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
