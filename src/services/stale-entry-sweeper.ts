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
 * THE ONLY SAFE CANCEL (REQ-ENTRY-003, review 2026-08-23): cancel the
 * PARENT entry leg alone, identified on a FRESH broker book by its
 * orderRef (`<id>:entry`), under the global order lock, and only count
 * what the broker CONFIRMS. Never touch the stop/target children: IBKR
 * cancels attached children itself when a still-working parent is
 * cancelled, and when the parent has already FILLED the cancel comes back
 * 'filled' / 'not-cancellable' and the children — the position's
 * protection — stay exactly where they are. The old loop cancelled every
 * stored order id blind to the broker, so a fill that raced the DB read
 * could have stripped a real position of its stop. A partial fill that
 * races the cancel lands in the tracker's terminal-partial path (WP2),
 * which resizes the exits — proven machinery, not re-invented here.
 *
 * The outcome tracker observes the confirmed cancellation and finalizes
 * the proposal as 'cancelled' through the normal path (close alert
 * included), which frees the slot and notifies the operator.
 *
 * Disable the zombie sweep with STALE_ENTRY_MAX_DAYS=0; the expiry sweep
 * with ENTRY_EXPIRY_GRACE_MIN=-1 (grace <0 disables). Both default on.
 * Nothing sweeps while the gateway is down — DAY entries die at the close
 * regardless; a GTC entry waits for the next boot's first sweep.
 */

import { OrderAction } from '@stoqey/ib';
import { getIBApi } from '@/tools/ibkr/connection.js';
import { confirmCancelDetailed } from '@/tools/ibkr/order-ack.js';
import { withOrderLock } from '@/tools/ibkr/order-lock.js';
import { logger } from '@/utils';
import { fetchOpenOrdersFor } from './position-actions.js';
import { listExpiredUnfilledEntries, listStaleUnfilled, listUnfilledIntradayGtc, type TradeProposal } from './trade-proposals.js';

const SWEEP_INTERVAL_MS = 10 * 60_000;
/** Broker-confirmation window for the parent cancel. */
const CANCEL_CONFIRM_MS = 5_000;

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

/** Pure (REQ-ENTRY-003): the one order the sweep may cancel — the
 *  proposal's own ENTRY leg as the broker currently shows it. Identity is
 *  the orderRef WP1 stamps on every bracket parent (`<id>:entry`); a book
 *  without it means the parent is gone (filled, cancelled, or never
 *  acknowledged) and there is nothing to do — the children are NEVER
 *  candidates. An incomplete book view returns null: a parent we cannot
 *  see is a parent we do not cancel. */
export function selectEntryLegToCancel(
    proposalId: string,
    book: { orders: Array<{ orderId: number; orderRef: string | null }>; complete: boolean },
): number | null {
    if (!book.complete) return null;
    const ref = `${proposalId.trim().toUpperCase()}:entry`;
    const hit = book.orders.find((o) => o.orderRef === ref);
    return hit ? hit.orderId : null;
}

/** The entry side of a proposal's bracket: a long enters by BUYING. */
export function entryActionFor(direction: 'long' | 'short'): OrderAction {
    return direction === 'long' ? OrderAction.BUY : OrderAction.SELL;
}

/** THE safe entry-cancel primitive (REQ-ENTRY-003) — also used by the EOD
 *  vet to cancel resting entries the gap-stress budget cannot afford. */
export async function cancelEntryLeg(p: TradeProposal, why: string): Promise<boolean> {
    const api = await getIBApi();
    // Under the order lock: no placement, resize, or close interleaves with
    // the book read + cancel — the snapshot we act on is the one we hold.
    return withOrderLock(async () => cancelEntryLegCore(api, p, why));
}

/** The lock-free core against any IBApi-shaped emitter — exported so the
 *  FakeIb harness drives the partial-fill and children-untouched paths
 *  without a gateway (review 2026-08-23, item 4). */
export async function cancelEntryLegCore(
    api: Awaited<ReturnType<typeof getIBApi>>,
    p: TradeProposal,
    why: string,
): Promise<boolean> {
    {
        const book = await fetchOpenOrdersFor(api, p.symbol, entryActionFor(p.direction));
        const parentId = selectEntryLegToCancel(p.id, book);
        if (parentId === null) {
            logger.info(
                `[stale-entry-sweeper] ${p.id} ${p.symbol}: ${why} — no working entry leg ${p.id}:entry on the ` +
                `${book.complete ? 'broker book' : 'INCOMPLETE broker view'}; nothing cancelled${book.complete ? ' (filled or already gone — the tracker reconciles it)' : ''}`,
            );
            return false;
        }
        const { outcome, filledQty } = await confirmCancelDetailed(api, parentId, CANCEL_CONFIRM_MS);
        switch (outcome) {
            case 'cancelled':
                // Review 2026-08-23 P1: IBKR can confirm a cancel WITH a
                // nonzero filled quantity — a partial fill raced us and a
                // real position exists. Never report that as a clean sweep:
                // the tracker's terminal-partial path (WP2) downgrades the
                // row and resizes the exits; this sweep's job is only to be
                // honest about what happened.
                if (filledQty !== null && filledQty > 0) {
                    logger.warn(
                        `[stale-entry-sweeper] ${p.id} ${p.symbol}: entry #${parentId} cancelled with ${filledQty} share(s) ` +
                        `ALREADY FILLED — partial position is LIVE; exits left standing, tracker resizes protection (WP2)`,
                    );
                    return false;
                }
                logger.info(`[stale-entry-sweeper] ${p.id} ${p.symbol}: ${why} — entry #${parentId} cancelled clean (broker-confirmed, 0 filled; attached exits cancel with it)`);
                return true;
            case 'filled':
            case 'not-cancellable':
                // The race the old loop lost: the parent filled under us. The
                // children are the position's protection — untouched by
                // construction; the tracker owns the fill from here.
                logger.warn(`[stale-entry-sweeper] ${p.id} ${p.symbol}: entry #${parentId} ${outcome} during the sweep — position is LIVE, exits left standing, tracker owns it`);
                return false;
            case 'unconfirmed':
                logger.error(`[stale-entry-sweeper] ${p.id} ${p.symbol}: entry #${parentId} cancel NOT CONFIRMED within ${CANCEL_CONFIRM_MS}ms — will retry next sweep; review in TWS if it persists`);
                return false;
        }
    }
}

export async function sweepStaleEntriesOnce(): Promise<number> {
    // One candidate list: an old intraday proposal can satisfy BOTH criteria
    // — it must be cancelled once, not raced against itself.
    const candidates = new Map<string, { p: TradeProposal; why: string }>();

    // Criterion 0 (review 2026-08-23): LEGACY intraday GTC entries are
    // policy-invalid since flat-by-close (the gate now refuses creating
    // them) — swept regardless of expiry, not merely once expired.
    for (const p of await listUnfilledIntradayGtc()) {
        candidates.set(p.id, { p, why: 'intraday GTC entry — policy-invalid since flat-by-close (2026-08-23)' });
    }

    // Criterion 1: expired intraday entries (thesis validity).
    const graceMin = entryExpiryGraceMin();
    if (graceMin >= 0) {
        for (const p of await listExpiredUnfilledEntries(Date.now(), graceMin * 60_000)) {
            if (!candidates.has(p.id)) candidates.set(p.id, { p, why: 'entry unfilled past the proposal\'s validity window' });
        }
    }

    // Criterion 2: zombie brackets (any class).
    const days = staleEntryMaxDays();
    if (days > 0) {
        for (const p of await listStaleUnfilled(days * 24 * 3600_000)) {
            if (!candidates.has(p.id)) candidates.set(p.id, { p, why: `entry unfilled > ${days}d (zombie bracket)` });
        }
    }

    let cancelled = 0;
    for (const { p, why } of candidates.values()) {
        try {
            if (await cancelEntryLeg(p, why)) cancelled++;
        } catch (err) {
            logger.warn(`[stale-entry-sweeper] ${p.id} ${p.symbol}: sweep step failed — ${err}`);
        }
    }
    return cancelled;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the sweep (idempotent; no-op when both criteria are disabled). */
export function startStaleEntrySweeper(): void {
    if (timer || (staleEntryMaxDays() <= 0 && entryExpiryGraceMin() < 0)) return;
    timer = setInterval(() => {
        sweepStaleEntriesOnce().catch((err) => logger.warn(`[stale-entry-sweeper] sweep failed: ${err}`));
    }, SWEEP_INTERVAL_MS);
    if (process.env.NODE_ENV !== 'test') {
        // Boot sweep (review 2026-08-23): the gateway starts this AFTER the
        // outcome tracker's boot reconciliation — entries that went stale
        // while the gateway was down are cancelled promptly on recovery, not
        // ten minutes later.
        setTimeout(() => {
            sweepStaleEntriesOnce().catch((err) => logger.warn(`[stale-entry-sweeper] boot sweep failed: ${err}`));
        }, 5_000);
    }
    logger.info(
        `[stale-entry-sweeper] started: expired intraday entries cancelled past expiry ` +
        `(+${entryExpiryGraceMin()}min grace), any unfilled entry after ${staleEntryMaxDays()}d ` +
        `(check every ${SWEEP_INTERVAL_MS / 60_000}min; parent leg only, broker-confirmed)`,
    );
}

export function stopStaleEntrySweeper(): void {
    if (timer) { clearInterval(timer); timer = null; }
}
