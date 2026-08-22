/**
 * Stale-entry sweeper — the broker entry must not outlive its thesis.
 *
 * Two independent criteria, one sweep (every 10 minutes):
 *
 * 1. EXPIRED (REQ-ENTRY-001): an executed INTRADAY proposal whose entry
 *    never filled and whose `expires_at` validity window has passed. A
 *    "valid for 150 minutes" thesis must not fill late in the afternoon
 *    (or, on GTC, days later). A grace period after acceptance protects a
 *    deliberate late accept. Swing / earnings-bet entries are exempt —
 *    patient by design.
 *
 * 2. ZOMBIE (observed live 2026-07-23): ANY executed proposal with an
 *    unfilled entry older than STALE_ENTRY_MAX_DAYS (default 3) — some
 *    pointed at orders that no longer existed at IBKR, and each occupied a
 *    max_open_positions slot.
 *
 * Cancels go to the broker; the outcome tracker observes the cancellations
 * and finalizes each proposal as 'cancelled' through the normal path
 * (close alert included), which frees the slot and notifies the operator.
 *
 * Disable the zombie sweep with STALE_ENTRY_MAX_DAYS=0; the expiry sweep
 * with ENTRY_EXPIRY_GRACE_MIN=-1 (grace <0 disables). Both default on.
 */

import { getIBApi } from '@/tools/ibkr/connection.js';
import { logger } from '@/utils';
import { listExpiredUnfilledEntries, listStaleUnfilled, type TradeProposal } from './trade-proposals.js';

const SWEEP_INTERVAL_MS = 10 * 60_000;

export function staleEntryMaxDays(): number {
    const n = Number(process.env.STALE_ENTRY_MAX_DAYS);
    if (Number.isFinite(n)) return Math.max(0, n);
    return 3;
}

/** Minimum resting time an accepted entry keeps even past its proposal's
 *  expiry (REQ-ENTRY-001) — an operator accepting near the deadline judged
 *  the thesis still live. Negative disables the expiry sweep. */
export function entryExpiryGraceMin(): number {
    const n = Number(process.env.ENTRY_EXPIRY_GRACE_MIN);
    if (Number.isFinite(n)) return n;
    return 30;
}

async function cancelEntryOrders(proposals: TradeProposal[], why: string): Promise<void> {
    if (proposals.length === 0) return;
    const api = await getIBApi();
    for (const p of proposals) {
        logger.info(
            `[stale-entry-sweeper] ${p.id} ${p.symbol}: ${why} — cancelling orders ${p.orderIds?.join('/') ?? '?'}`,
        );
        for (const oid of p.orderIds ?? []) {
            try { api.cancelOrder(oid); } catch { /* already gone */ }
        }
        // No status write here: the outcome tracker sees the cancellations
        // and closes the proposal honestly (or, if the orders were already
        // dead at IBKR, its reconciliation sweep does).
    }
}

export async function sweepStaleEntriesOnce(): Promise<number> {
    let swept = 0;

    // Criterion 1: expired intraday entries (thesis validity).
    const graceMin = entryExpiryGraceMin();
    if (graceMin >= 0) {
        const expired = await listExpiredUnfilledEntries(Date.now(), graceMin * 60_000);
        await cancelEntryOrders(expired, 'entry unfilled past the proposal\'s validity window');
        swept += expired.length;
    }

    // Criterion 2: zombie brackets (any class).
    const days = staleEntryMaxDays();
    if (days > 0) {
        const stale = await listStaleUnfilled(days * 24 * 3600_000);
        await cancelEntryOrders(stale, `entry unfilled > ${days}d (zombie bracket)`);
        swept += stale.length;
    }

    return swept;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the sweep (idempotent; no-op when both criteria are disabled). */
export function startStaleEntrySweeper(): void {
    if (timer || (staleEntryMaxDays() <= 0 && entryExpiryGraceMin() < 0)) return;
    timer = setInterval(() => {
        sweepStaleEntriesOnce().catch((err) => logger.warn(`[stale-entry-sweeper] sweep failed: ${err}`));
    }, SWEEP_INTERVAL_MS);
    logger.info(
        `[stale-entry-sweeper] started: expired intraday entries cancelled past expiry ` +
        `(+${entryExpiryGraceMin()}min grace), any unfilled entry after ${staleEntryMaxDays()}d ` +
        `(check every ${SWEEP_INTERVAL_MS / 60_000}min)`,
    );
}

export function stopStaleEntrySweeper(): void {
    if (timer) { clearInterval(timer); timer = null; }
}
