/**
 * Stale-entry sweeper — reclaim position slots from zombie brackets.
 *
 * Observed live (2026-07-23): 5 of the 10 max_open_positions slots were
 * occupied by executed proposals whose ENTRY never filled — some days old,
 * one pointing at orders that no longer existed at IBKR — and a fresh
 * earnings trade was refused for "10 positions already open".
 *
 * Hourly: executed proposals with an unfilled entry older than
 * STALE_ENTRY_MAX_DAYS (default 3) get their orders cancelled. The outcome
 * tracker observes the cancellations and finalizes each proposal as
 * 'cancelled' through the normal path (close alert included), which frees
 * the slot. Patient swing entries younger than the cutoff are untouched.
 *
 * Disable with STALE_ENTRY_MAX_DAYS=0.
 */

import { getIBApi } from '@/tools/ibkr/connection.js';
import { logger } from '@/utils';
import { listStaleUnfilled } from './trade-proposals.js';

const SWEEP_INTERVAL_MS = 60 * 60_000;

export function staleEntryMaxDays(): number {
    const n = Number(process.env.STALE_ENTRY_MAX_DAYS);
    if (Number.isFinite(n)) return Math.max(0, n);
    return 3;
}

export async function sweepStaleEntriesOnce(): Promise<number> {
    const days = staleEntryMaxDays();
    if (days <= 0) return 0;

    const stale = await listStaleUnfilled(days * 24 * 3600_000);
    if (stale.length === 0) return 0;

    const api = await getIBApi();
    for (const p of stale) {
        logger.info(
            `[stale-entry-sweeper] ${p.id} ${p.symbol}: entry unfilled since ` +
            `${new Date(p.executedAt ?? p.createdAt).toISOString()} (> ${days}d) — cancelling orders ${p.orderIds?.join('/') ?? '?'}`,
        );
        for (const oid of p.orderIds ?? []) {
            try { api.cancelOrder(oid); } catch { /* already gone */ }
        }
        // No status write here: the outcome tracker sees the cancellations
        // and closes the proposal honestly (or, if the orders were already
        // dead at IBKR, its reconciliation sweep does).
    }
    return stale.length;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the hourly sweep (idempotent; no-op when disabled). */
export function startStaleEntrySweeper(): void {
    if (timer || staleEntryMaxDays() <= 0) return;
    timer = setInterval(() => {
        sweepStaleEntriesOnce().catch((err) => logger.warn(`[stale-entry-sweeper] sweep failed: ${err}`));
    }, SWEEP_INTERVAL_MS);
    logger.info(`[stale-entry-sweeper] started: unfilled entries cancelled after ${staleEntryMaxDays()}d (hourly check)`);
}

export function stopStaleEntrySweeper(): void {
    if (timer) { clearInterval(timer); timer = null; }
}
