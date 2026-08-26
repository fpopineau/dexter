/**
 * Flat-account exit-order sweeper (incident 2026-08-26, BZ).
 *
 * An IBKR paper-account reset wiped a LONG 134 BZ position but left its
 * GTC exits armed at the broker. Six hours later the target leg filled
 * against the flat account at the opening print and OPENED A NAKED
 * SHORT — no human and no gate ever decided that trade. The tracker,
 * OCA and adoption machinery all behaved correctly downstream; what was
 * missing is upstream: nothing watched for dexter EXIT orders resting
 * on a symbol the account no longer holds.
 *
 * This sweeper closes that gap: every few minutes it takes a COMPLETE
 * broker order snapshot and a verified positions snapshot (orders
 * first, positions second — review-20 race order, so an entry fill
 * between the two lands in positions and vetoes the sweep), selects
 * dexter exit orders (:tp/:stop refs, P-XXXX and protect-) on symbols
 * with NO position and NO working dexter entry parent, and cancels them
 * broker-confirmed — but only after seeing the SAME orphan on two
 * consecutive ticks (transient states never trigger cancels). Foreign
 * orders are never touched: a manually staged TWS bracket (e.g. the
 * bell-expiry observation) must survive this sweep by construction.
 *
 * FLAT_EXIT_SWEEP=false disables (the flag is a fingerprint surface).
 */

import { getIBApi } from '@/tools/ibkr/connection.js';
import { confirmCancelDetailed } from '@/tools/ibkr/order-ack.js';
import { withOrderLock } from '@/tools/ibkr/order-lock.js';
import { logger } from '@/utils';
import { fetchOpenOrderSnaps, type BrokerOrderSnap } from './broker-adopt.js';
import { fetchPositions, type LivePosition } from './position-actions.js';

const SWEEP_INTERVAL_MS = 5 * 60_000;
const BOOT_DELAY_MS = 90_000; // after the IBKR connection settles

export function isFlatExitSweepEnabled(): boolean {
    return (process.env.FLAT_EXIT_SWEEP ?? 'true').trim().toLowerCase() !== 'false';
}

/** Pure: dexter EXIT orders resting on symbols where the account is
 *  FLAT and NO dexter entry parent is working. A symbol with a position
 *  (either sign) keeps its exits; a symbol with a working `P-XXXX:entry`
 *  parent keeps its dormant bracket children; anything without a
 *  dexter :tp/:stop ref is foreign and untouchable. */
export function selectOrphanedExits(
    orders: Array<Pick<BrokerOrderSnap, 'orderId' | 'symbol' | 'orderRef'>>,
    positions: Array<Pick<LivePosition, 'symbol' | 'quantity'>>,
): Map<string, number[]> {
    const held = new Set(positions.filter((p) => p.quantity !== 0).map((p) => p.symbol.toUpperCase()));
    const entryParents = new Set(
        orders.filter((o) => /^P-[0-9A-F]{4}:entry$/.test(o.orderRef ?? '')).map((o) => o.symbol.toUpperCase()),
    );
    const out = new Map<string, number[]>();
    for (const o of orders) {
        if (!/^(P-[0-9A-F]{4}|protect-[A-Z.]{1,6}):(tp|stop)$/.test(o.orderRef ?? '')) continue;
        const sym = o.symbol.toUpperCase();
        if (held.has(sym) || entryParents.has(sym)) continue;
        const list = out.get(sym) ?? [];
        list.push(o.orderId);
        out.set(sym, list);
    }
    return out;
}

/** Pure: latch identity — a suspect only counts as CONFIRMED when the
 *  same symbol shows the same exit-order ids on consecutive ticks. */
export function suspectKey(symbol: string, orderIds: number[]): string {
    return `${symbol}:${[...orderIds].sort((a, b) => a - b).join(',')}`;
}

/** Pure: the two-tick latch. `confirmed` = suspects already seen last
 *  tick with identical ids (safe to act on); `next` = what the next
 *  tick must remember. A changed id set re-latches from zero. */
export function latchStep(
    prev: Set<string>,
    suspects: Map<string, number[]>,
): { confirmed: Array<[string, number[]]>; next: Set<string> } {
    const confirmed = [...suspects.entries()].filter(([sym, ids]) => prev.has(suspectKey(sym, ids)));
    return { confirmed, next: new Set([...suspects.entries()].map(([sym, ids]) => suspectKey(sym, ids))) };
}

type SweepAlertCallback = (message: string) => Promise<void> | void;
const alertCallbacks = new Set<SweepAlertCallback>();

/** Register an alert callback (bridged to WhatsApp in the gateway). */
export function onFlatExitSweep(cb: SweepAlertCallback): () => void {
    alertCallbacks.add(cb);
    return () => alertCallbacks.delete(cb);
}

let prevSuspects = new Set<string>();
let sweepRunning = false;

export async function sweepFlatExitsOnce(): Promise<void> {
    if (sweepRunning) return; // overlap guard: a slow broker call must not stack sweeps
    sweepRunning = true;
    try {
        await withOrderLock(async () => {
            const api = await getIBApi();
            // Orders FIRST, positions SECOND: a fill between the snapshots
            // shows up in positions and vetoes the symbol.
            const snap = await fetchOpenOrderSnaps(api);
            if (!snap.complete) {
                // A partial view proves nothing — and must not AGE suspicion:
                // the latch restarts from a clean pair of complete views.
                prevSuspects = new Set();
                logger.warn('[flat-exit-sweeper] open-orders snapshot incomplete — skipping tick');
                return;
            }
            const positions = await fetchPositions(api);
            const { confirmed, next } = latchStep(prevSuspects, selectOrphanedExits(snap.orders, positions));
            prevSuspects = next;
            for (const [sym, ids] of confirmed) {
                let cancelled = 0;
                const problems: string[] = [];
                let filledDuringSweep = false;
                for (const id of ids) {
                    try {
                        const { outcome, filledQty } = await confirmCancelDetailed(api, id, 5_000);
                        if (outcome === 'cancelled' && !(filledQty !== null && filledQty > 0)) cancelled++;
                        else {
                            problems.push(`#${id}: ${outcome}${filledQty ? `, ${filledQty} filled` : ''}`);
                            if (filledQty !== null && filledQty > 0) filledDuringSweep = true;
                        }
                    } catch (err) {
                        problems.push(`#${id}: cancel failed (${err instanceof Error ? err.message : err})`);
                    }
                }
                const msg =
                    `🧹🚨 ORPHANED EXITS swept on ${sym}: the account is FLAT with no working entry, ` +
                    `but ${ids.length} dexter exit order(s) rested at the broker (external position change — ` +
                    `account reset or manual liquidation). ${cancelled} cancelled broker-confirmed` +
                    (problems.length ? `; UNRESOLVED: ${problems.join('; ')}` : '') +
                    (filledDuringSweep ? `\n🚨 AN EXIT FILLED before it could be cancelled — check 'positions' NOW: a reverse position may be open (the reconciliation will adopt and protect it).` : '');
                logger.error(`[flat-exit-sweeper] ${msg}`);
                for (const cb of [...alertCallbacks]) {
                    try { await cb(msg); } catch (err) {
                        logger.error(`[flat-exit-sweeper] alert callback failed: ${err}`);
                    }
                }
            }
        });
    } catch (err) {
        // An unverifiable tick (positions fetch failed, lock timeout…)
        // resets the latch: suspicion must be built from consecutive
        // VERIFIED observations only.
        prevSuspects = new Set();
        logger.warn(`[flat-exit-sweeper] sweep failed: ${err instanceof Error ? err.message : err}`);
    } finally {
        sweepRunning = false;
    }
}

let timer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;

/** Start the sweeper (idempotent; FLAT_EXIT_SWEEP=false disables). */
export function startFlatExitSweeper(): void {
    if (timer || !isFlatExitSweepEnabled()) return;
    prevSuspects = new Set(); // a fresh lifecycle builds fresh suspicion
    timer = setInterval(() => {
        sweepFlatExitsOnce().catch((err) => logger.warn(`[flat-exit-sweeper] tick failed: ${err}`));
    }, SWEEP_INTERVAL_MS);
    if (process.env.NODE_ENV !== 'test') {
        const t: ReturnType<typeof setTimeout> = setTimeout(() => {
            if (bootTimer !== t) return; // review-35: stopped while queued
            bootTimer = null;
            sweepFlatExitsOnce().catch((err) => logger.warn(`[flat-exit-sweeper] boot sweep failed: ${err}`));
        }, BOOT_DELAY_MS);
        bootTimer = t;
    }
    logger.info(`[flat-exit-sweeper] started: dexter exits resting on FLAT symbols are cancelled after two consecutive sightings (every ${SWEEP_INTERVAL_MS / 60_000} min; foreign orders untouched)`);
}

export function stopFlatExitSweeper(): void {
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
}
