/**
 * Veto-window due sweep (REQ-LIVE-002 seam, live-loop WP1).
 *
 * When LIVE_VETO_WINDOW_MIN > 0 the auto-executor stamps `auto_execute_at`
 * on a still-open proposal instead of placing it, and announces
 * "executes at HH:MM ET unless 'veto P-XXXX'". This sweep runs every 30 s
 * and executes due rows — oldest first, through `autoExecuteProposal` with
 * the window skipped, so every accept gate (session, cutoff, kill-switch,
 * epoch latch, microstructure, exposure) re-runs at execution time. A due
 * time past `expires_at` is never listed (the expiry sweep owns it).
 *
 * With the default window of 0 this sweep finds nothing and costs one
 * cheap query per tick — inert by construction.
 */

import { logger } from '@/utils';
import { autoExecuteProposal, type ExecutionOutcome } from './proposal-executor.js';
import { listDueAutoExecutions, type TradeProposal } from './trade-proposals.js';

const SWEEP_INTERVAL_MS = 30_000;

export interface DueSweepDeps {
    now: number;
    listDue: (nowMs: number) => Promise<TradeProposal[]>;
    execute: (id: string) => Promise<ExecutionOutcome>;
}

export interface DueSweepResult {
    attempted: number;
    executed: number;
    failed: number;
}

export async function sweepDueOnce(deps: DueSweepDeps): Promise<DueSweepResult> {
    const due = await deps.listDue(deps.now);
    const result: DueSweepResult = { attempted: 0, executed: 0, failed: 0 };
    for (const p of due) {
        result.attempted++;
        try {
            const outcome = await deps.execute(p.id);
            if (outcome.ok) result.executed++;
            else {
                result.failed++;
                logger.warn(`[veto-window] ${p.id} ${p.symbol}: due execution refused — ${outcome.message}`);
            }
        } catch (err) {
            result.failed++;
            logger.warn(`[veto-window] ${p.id} ${p.symbol}: due execution threw — ${err instanceof Error ? err.message : err}`);
        }
    }
    return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startVetoWindowSweeper(): void {
    if (timer) return;
    timer = setInterval(() => {
        sweepDueOnce({
            now: Date.now(),
            listDue: listDueAutoExecutions,
            execute: (id) => autoExecuteProposal(id, { skipVetoWindow: true }),
        }).then((r) => {
            if (r.attempted > 0) logger.info(`[veto-window] sweep: ${JSON.stringify(r)}`);
        }).catch((err) => logger.warn(`[veto-window] sweep failed: ${err}`));
    }, SWEEP_INTERVAL_MS);
    logger.info(`[veto-window] started: due auto-executions swept every ${SWEEP_INTERVAL_MS / 1000}s (inert while LIVE_VETO_WINDOW_MIN=0)`);
}

export function stopVetoWindowSweeper(): void {
    if (timer) { clearInterval(timer); timer = null; }
}
