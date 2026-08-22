/**
 * Position actions — deterministic, risk-REDUCING order flows for
 * positions that already exist:
 *
 *   protectPosition(symbol, stop, target?) — attach GTC protective exits
 *     to an unprotected position (a stop, or an OCA stop+target pair).
 *     The canonical use: a DAY bracket's entry filled but its exits
 *     expired at the close, leaving the position naked overnight.
 *
 *   closePosition(symbol) — market-close the full position.
 *
 * Trust model mirrors the proposal executor's WhatsApp path: the explicit
 * human message IS the approval. Gates: the paper/live safety lock always
 * applies (these are orders); the daily-loss kill-switch does NOT — it
 * only blocks risk-increasing actions, and protecting/closing reduces risk.
 */

import { BRACKET_ACK_TIMEOUT_MS } from '@/tools/ibkr/bracket.js';
import { allocReqId, assertAccountsVerified, getIBApi, getVerifiedSingleAccount, isNonFatalIbkrError } from '@/tools/ibkr/connection.js';
import { confirmCancel, watchOrderAcks, type CancelOutcome } from '@/tools/ibkr/order-ack.js';
import { withOrderLock } from '@/tools/ibkr/order-lock.js';
import { getNextValidOrderId } from '@/tools/ibkr/orders.js';
import { getMarketSession, isTradeableSession } from '@/utils/market-hours.js';
import { logger } from '@/utils';
import type { Contract, Order } from '@stoqey/ib';
import { EventName, OrderAction, OrderType, SecType, TimeInForce } from '@stoqey/ib';

export interface PositionActionOutcome {
    ok: boolean;
    /** Broker-lifecycle state (review 2026-08-21): a boolean cannot carry
     *  "the order exists but the position is not flat yet". Consumers that
     *  treat a close as DONE must check for 'filled', never just ok. */
    state?: 'filled' | 'working' | 'unconfirmed' | 'rejected';
    /** Round-10 review: the FILL is an order fact; FLAT is a position
     *  fact — an exit filling alongside the close leaves a filled close
     *  and a NOT-flat book. true = position book confirms flat; false =
     *  confirmed NOT flat (over-close residue); null = could not verify.
     *  Consumers that mean "the symbol is closed" gate on flat === true,
     *  never on state alone. */
    flat?: boolean | null;
    /** Round-11 review: flat and SETTLED are different facts — a flat
     *  account can still carry a manual resting exit that OPENS a position
     *  when it fills. true = flat AND cleanup fully settled (verified, no
     *  exit-fill race, nothing still working). Consumers may compress the
     *  message to "Closed." ONLY on clean === true. */
    clean?: boolean;
    message: string;
    /** protectPosition only: the GTC exit order ids just placed — the
     *  outcome tracker adopts them so the protected position stays a
     *  tracked proposal instead of an orphaned hold. */
    protectOrderIds?: { stopOrderId: number; targetOrderId?: number };
}

export interface LivePosition {
    account: string;
    symbol: string;
    /** Signed: positive = long, negative = short. */
    quantity: number;
    avgCost: number;
}

/** Fetch current positions (one-shot). */
export async function fetchPositions(api: import('@stoqey/ib').IBApi): Promise<LivePosition[]> {
    const positions: LivePosition[] = [];
    return new Promise<LivePosition[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('positions request timed out'));
        }, 10_000);
        const onPosition = (account: string, contract: Contract, pos: number, avgCost?: number) => {
            if (pos === 0) return;
            positions.push({
                account,
                symbol: contract.symbol ?? '',
                quantity: pos,
                avgCost: avgCost ?? 0,
            });
        };
        const onEnd = () => {
            clearTimeout(timeout);
            cleanup();
            resolve(positions);
        };
        const onError = (err: Error, code: number, id: number) => {
            if (id !== -1) return;
            if (isNonFatalIbkrError(code)) return;
            clearTimeout(timeout);
            cleanup();
            reject(new Error(`positions error ${code}: ${err.message}`));
        };
        function cleanup() {
            try { api.cancelPositions(); } catch { /* ignore */ }
            api.off(EventName.position, onPosition);
            api.off(EventName.positionEnd, onEnd);
            api.off(EventName.error, onError);
        }
        api.on(EventName.position, onPosition);
        api.on(EventName.positionEnd, onEnd);
        api.on(EventName.error, onError);
        api.reqPositions();
    });
}

function stockContract(symbol: string): Contract {
    return { symbol, secType: SecType.STK, exchange: 'SMART', currency: 'USD' };
}

export interface OpenOrderSummary {
    orderId: number;
    orderType: string;
    tif: string;
    /** WP11: our identity key (WP1 stamps one on every order) — the close
     *  sweep cancels OUR orphaned pairs by it and never touches unknowns. */
    orderRef: string | null;
    /** Round-5 review: the exits' OCA group — a close that JOINS it makes
     *  close-vs-stop mutual exclusion broker-side, killing the gap-open
     *  over-close race. */
    ocaGroup: string | null;
}

export interface OpenOrdersView {
    orders: OpenOrderSummary[];
    /** Round-8 review: false = openOrderEnd never arrived — the view is
     *  PARTIAL and must not be treated as the whole book (OCA join and
     *  double-protection checks fail closed on it). */
    complete: boolean;
}

/** Working orders for a symbol on the given side (all API clients). */
export async function fetchOpenOrdersFor(
    api: import('@stoqey/ib').IBApi,
    symbol: string,
    side: OrderAction,
    timeoutMs = 10_000,
): Promise<OpenOrdersView> {
    const found: OpenOrderSummary[] = [];
    return new Promise<OpenOrdersView>((resolve) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve({ orders: found, complete: false });
        }, timeoutMs);
        const onOpen = (id: number, contract: Contract, order: Order) => {
            if ((contract.symbol ?? '') !== symbol) return;
            if ((order.action ?? '') !== side) return;
            found.push({
                orderId: id,
                orderType: String(order.orderType ?? ''),
                tif: String(order.tif ?? ''),
                orderRef: typeof order.orderRef === 'string' ? order.orderRef : null,
                ocaGroup: typeof order.ocaGroup === 'string' && order.ocaGroup.length > 0 ? order.ocaGroup : null,
            });
        };
        const onEnd = () => {
            clearTimeout(timeout);
            cleanup();
            resolve({ orders: found, complete: true });
        };
        function cleanup() {
            api.off(EventName.openOrder, onOpen);
            api.off(EventName.openOrderEnd, onEnd);
        }
        api.on(EventName.openOrder, onOpen);
        api.on(EventName.openOrderEnd, onEnd);
        api.reqAllOpenOrders();
    });
}

/**
 * Attach GTC protective exits to an existing position: a stop, or an OCA
 * stop+target pair (either fill cancels the other). Exit side is derived
 * from the position (long → SELL exits, short → BUY exits).
 */
export async function protectPosition(
    symbolRaw: string,
    stopPrice: number,
    targetPrice?: number,
): Promise<PositionActionOutcome> {
    const symbol = symbolRaw.trim().toUpperCase();
    try {
        // Full identity gate, not the static-only check: these place real
        // orders, and the weaker gate silently passed on an empty account
        // list (WP0.4, audit 2026-08-20). Risk-reducing, so the 5s timeout
        // still bounds the wait.
        await assertAccountsVerified();

        const api = await getIBApi();
        const positions = await fetchPositions(api);
        const pos = positions.find((p) => p.symbol === symbol);
        if (!pos) {
            return { ok: false, message: `No open position in ${symbol} — nothing to protect. ('positions' to list holdings.)` };
        }

        const isLong = pos.quantity > 0;
        const qty = Math.abs(pos.quantity);

        // Exit coherence relative to the position side.
        if (isLong && targetPrice !== undefined && !(stopPrice < targetPrice)) {
            return { ok: false, message: `Long ${symbol}: stop ${stopPrice} must be below target ${targetPrice}.` };
        }
        if (!isLong && targetPrice !== undefined && !(stopPrice > targetPrice)) {
            return { ok: false, message: `Short ${symbol}: stop ${stopPrice} must be above target ${targetPrice}.` };
        }

        const exitAction = isLong ? OrderAction.SELL : OrderAction.BUY;

        // Double-protection guard: an existing GTC exit for this symbol
        // means a protect pair (or manual exits) already stands — adding
        // another risks OVERSELLING (each OCA pair only cancels within
        // itself). DAY exits are fine: they die at the session rollover,
        // which is exactly the gap this command exists to cover.
        const existingView = await fetchOpenOrdersFor(api, symbol, exitAction);
        if (!existingView.complete) {
            // Round-8 review: a PARTIAL book view could hide an existing
            // pair — protecting on top of it oversells. Fail closed.
            return {
                ok: false,
                message: `⛔ Cannot protect ${symbol} right now: the open-orders snapshot did not complete, so an existing exit pair could be hidden. Retry in a moment.`,
            };
        }
        const existing = existingView.orders;
        const existingGtc = existing.filter((o) => o.tif === 'GTC');
        if (existingGtc.length > 0) {
            return {
                ok: false,
                message:
                    `⛔ ${symbol} already has ${existingGtc.length} GTC exit order(s) working ` +
                    `(${existingGtc.map((o) => `#${o.orderId} ${o.orderType}`).join(', ')}). ` +
                    `Adding more would risk overselling. Cancel them first (TWS or the TUI) if you want different levels.`,
            };
        }
        const dayNote = existing.length > 0
            ? ` ${existing.length} existing DAY exit(s) expire at the session rollover; the GTC pair takes over.`
            : '';

        // Locked: the OCA pair assumes contiguous ids stopId/stopId+1.
        const placed = await withOrderLock(async () => {
            const stopId = await getNextValidOrderId(api);
            const ocaGroup = `dexter-protect-${symbol}-${stopId}`;
            // Identity binding (WP1): account + a stable orderRef on every
            // order this module places.
            const account = getVerifiedSingleAccount();
            const targetId = targetPrice !== undefined ? stopId + 1 : null;
            const legIds = targetId !== null ? [stopId, targetId] : [stopId];
            // Review 2026-08-21: "protected" is a broker fact, not a
            // handoff — arm the ack watch before placement.
            const watch = watchOrderAcks(api, legIds);

            const stopOrder: Order = {
                orderId: stopId,
                account,
                orderRef: `protect-${symbol}:stop`,
                action: exitAction,
                totalQuantity: qty,
                orderType: OrderType.STP,
                auxPrice: stopPrice,
                tif: TimeInForce.GTC, // protection must survive the close
                // Round-6 review: a LONE stop gets the OCA group too — a
                // one-member group is legal, and it is what lets a later
                // close JOIN it for broker-side close-vs-stop exclusion.
                // Without it, stop-only protection kept the over-close race.
                ocaGroup,
                ocaType: 1,
                // NOTE: transmit-chaining only works for parent/child brackets.
                // A standalone OCA pair must transmit BOTH legs explicitly, or
                // the first leg sits untransmitted and the position has no stop.
                transmit: true,
            };
            try {
                api.placeOrder(stopId, stockContract(symbol), stopOrder);
                if (targetId !== null) {
                    const targetOrder: Order = {
                        orderId: targetId,
                        account,
                        orderRef: `protect-${symbol}:tp`,
                        action: exitAction,
                        totalQuantity: qty,
                        orderType: OrderType.LMT,
                        lmtPrice: targetPrice,
                        tif: TimeInForce.GTC,
                        ocaGroup,
                        ocaType: 1,
                        transmit: true,
                    };
                    api.placeOrder(targetId, stockContract(symbol), targetOrder);
                }
            } catch (err) {
                watch.dispose();
                throw err;
            }
            const states = await watch.settle(BRACKET_ACK_TIMEOUT_MS);
            const rejected = states.find((s) => s.rejection !== null);
            const unconfirmed = states.some((s) => !s.acked);
            if (rejected || unconfirmed) {
                // Review 2026-08-21 (round 3): an UNCONFIRMED pair must not
                // report "protected" — an unknown broker state would be
                // promoted into database truth (the tracker converts DAY
                // rows into "protected" overnight holds on this result).
                // Fail closed: sweep the legs best-effort and say NOT
                // protected — loud and wrong-side-safe beats silent naked.
                for (const id of legIds) {
                    try { api.cancelOrder(id); } catch { /* already dead */ }
                }
                return {
                    rejected: rejected
                        ? `order ${rejected.orderId}: ${rejected.rejection!.reason}`
                        : 'no broker acknowledgement within the window (legs cancel-swept best-effort)',
                    msg: '', ids: { stopOrderId: stopId },
                };
            }
            const idsOut = targetId !== null ? { stopOrderId: stopId, targetOrderId: targetId } : { stopOrderId: stopId };
            const msg = targetId !== null
                ? `, target ${targetPrice} (orders ${stopId}/${targetId}, OCA ${ocaGroup})`
                : ` (order ${stopId})`;
            return { rejected: null as string | null, msg, ids: idsOut };
        });

        if (placed.rejected) {
            logger.error(`[position-actions] protect ${symbol} NOT protected: ${placed.rejected}`);
            return {
                ok: false,
                state: 'rejected',
                message: `❌ ${symbol} is NOT protected (${placed.rejected}). Verify with 'orders', then fix the levels and retry — or close the position.`,
            };
        }

        logger.info(`[position-actions] protected ${symbol}: ${exitAction} ${qty} stop ${stopPrice}${targetPrice !== undefined ? ` / target ${targetPrice}` : ''}`);
        return {
            ok: true,
            message:
                `🛡️ ${symbol} protected: ${isLong ? 'LONG' : 'SHORT'} ${qty} @ ${pos.avgCost.toFixed(2)} — ` +
                `GTC stop ${stopPrice}${placed.msg}. These exits survive the close.${dayNote}`,
            protectOrderIds: placed.ids,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[position-actions] protect ${symbol} failed: ${msg}`);
        return { ok: false, message: `❌ Could not protect ${symbol} — ${msg}` };
    }
}

// Symbols deliberately closed just now: auto-protect must NOT re-attach
// exits to a position that is mid-liquidation (the close MKT order and the
// exit cancellations race through the tracker).
const recentlyClosed = new Map<string, number>();
const RECENTLY_CLOSED_MS = 10 * 60_000;

/** True when the operator closed this symbol within the last 10 minutes. */
export function wasRecentlyClosed(symbol: string): boolean {
    const at = recentlyClosed.get(symbol.trim().toUpperCase());
    return at !== undefined && Date.now() - at < RECENTLY_CLOSED_MS;
}

/** Market-close the full position in a symbol (risk-reducing). `source`
 *  labels who decided (operator command, profit-trail, EOD triage) — it
 *  flows into the outcome tracker so the close gets a real P&L. */
/** Per-symbol closes in flight — two concurrent callers (operator,
 *  dashboard, profit-trail, triage) must never each snapshot the full
 *  position and submit two full-size closing orders: the second is a net
 *  REVERSAL (review 2026-08-21). */
const closesInFlight = new Set<string>();

/** Fill window for a close: an RTH market order fills in well under this;
 *  a pre-market/resting close exits via the 'working' path instead. */
const CLOSE_FILL_WAIT_MS = 8_000;

/** Injection seam for the close-lifecycle tests (round-4 review: the
 *  filled/working/rejected branches carry real safety semantics and had
 *  zero coverage). Production always runs the real bindings; mock.module
 *  is process-global under bun and would poison sibling suites. */
/** Broker-confirmation window for a cancel request (round-4 review). */
const CANCEL_CONFIRM_MS = 5_000;

/** Our order identity (WP1/WP11): refs Dexter stamps on everything it
 *  places. The orphan sweep cancels ONLY these; the OCA-join trusts only
 *  these. Unknown refs are never touched. */
const OUR_REF = /^(protect-|close-|reduce-|BRKT-|P-[0-9A-F]{4}:)/;

/** The one shared ownership predicate (REQ-TRAIL-001): every service that
 *  considers cancelling a broker order must test identity through this —
 *  cancelling by order TYPE alone is how a manual TWS order gets killed. */
export function isOurOrderRef(ref: string | null | undefined): boolean {
    return OUR_REF.test(ref ?? '');
}

const closeDeps = {
    getApi: getIBApi,
    verifyAccounts: assertAccountsVerified,
    verifiedAccount: getVerifiedSingleAccount,
    nextOrderId: getNextValidOrderId,
    fillWaitMs: CLOSE_FILL_WAIT_MS,
    cancelConfirmMs: CANCEL_CONFIRM_MS,
    reconcileWaitMs: 10_000,
    probeTimeoutMs: 10_000,
};
export function __setCloseDepsForTests(overrides: Partial<typeof closeDeps> | null): void {
    if (overrides === null) {
        closeDeps.getApi = getIBApi;
        closeDeps.verifyAccounts = assertAccountsVerified;
        closeDeps.verifiedAccount = getVerifiedSingleAccount;
        closeDeps.nextOrderId = getNextValidOrderId;
        closeDeps.fillWaitMs = CLOSE_FILL_WAIT_MS;
        closeDeps.cancelConfirmMs = CANCEL_CONFIRM_MS;
        closeDeps.reconcileWaitMs = 10_000;
        closeDeps.probeTimeoutMs = 10_000;
    } else {
        Object.assign(closeDeps, overrides);
    }
}

/**
 * Cancel this symbol's exit protection AFTER the position is flat:
 * tracked bracket/exit ids first, then the WP11 orphan sweep (our
 * orderRef'd GTC pairs; unknown refs flagged, never touched). Called by
 * closePosition on an immediate fill and by the outcome tracker when a
 * resting close's fill lands later.
 *
 * Round-4 review (2026-08-21): every cancel is broker-CONFIRMED — the
 * count returned is orders the broker reported dead, not requests sent.
 * The dangerous residues are loud: an exit that FILLED during cleanup
 * means the flat account now holds an unintended position (a GTC stop
 * surviving a close can short the account when it triggers), and an
 * unconfirmed cancel means the book must not be assumed clean — the WP3
 * sweep retries, but the operator is told NOW, not at the next sweep.
 */
export interface ExitCleanupResult {
    /** Cancels the broker CONFIRMED, counted only when `verified` — an
     *  unverified count is a certification the book never backed
     *  (round-9 review). */
    confirmedCancelled: number;
    /** The post-condition open-orders snapshot completed on both sides. */
    verified: boolean;
    /** A non-entry order classified FILLED during cleanup — the close
     *  raced an exit; the position may not be flat. */
    exitFilledDuringClose: boolean;
    /** Ids the book still shows working after everything. */
    stillWorking: number[];
}

export async function cleanupExitsAfterClose(api: import('@stoqey/ib').IBApi, symbolRaw: string): Promise<ExitCleanupResult> {
    const symbol = symbolRaw.trim().toUpperCase();
    const requested = new Set<number>();
    // Round-5 review: orderIds[0] is the ENTRY by convention. Cancelling
    // it is deliberate (a partially-filled entry left working would rebuild
    // the position after the close), but on a routine close the entry is
    // long FILLED — the broker answers 10148 state:Filled, which is benign
    // for the entry and an ALARM for an exit. Classify per id.
    const entryIds = new Set<number>();
    const pending: Array<Promise<readonly [number, CancelOutcome]>> = [];
    const requestCancel = (oid: number) => {
        if (requested.has(oid)) return;
        requested.add(oid);
        pending.push(confirmCancel(api, oid, closeDeps.cancelConfirmMs).then((o) => [oid, o] as const));
    };
    try {
        const { listTrackable } = await import('./trade-proposals.js');
        for (const t of await listTrackable()) {
            if (t.symbol !== symbol || !t.orderIds?.length) continue;
            entryIds.add(t.orderIds[0]);
            for (const oid of t.orderIds) requestCancel(oid);
        }
    } catch (err) {
        logger.warn(`[position-actions] exit cleanup for ${symbol} failed: ${err}`);
    }
    try {
        for (const side of [OrderAction.SELL, OrderAction.BUY]) {
            const sweepView = await fetchOpenOrdersFor(api, symbol, side, closeDeps.probeTimeoutMs);
            if (!sweepView.complete) logger.warn(`[position-actions] ${symbol}: orphan-sweep book view incomplete — sweeping what was seen; the WP3 sweep retries`);
            for (const o of sweepView.orders) {
                if (requested.has(o.orderId) || o.tif !== 'GTC') continue;
                if (OUR_REF.test(o.orderRef ?? '')) {
                    requestCancel(o.orderId);
                    logger.info(`[position-actions] ${symbol}: sweeping orphaned GTC ${o.orderType} #${o.orderId} (ref '${o.orderRef}')`);
                } else {
                    logger.warn(`[position-actions] ${symbol}: UNKNOWN GTC ${o.orderType} #${o.orderId}${o.orderRef ? ` (ref '${o.orderRef}')` : ''} left untouched — review in TWS`);
                }
            }
        }
    } catch (err) {
        logger.warn(`[position-actions] orphan-exit sweep for ${symbol} failed: ${err}`);
    }
    let cancelledExits = 0;
    const outcomes = await Promise.all(pending);
    // Round-6 review: the POST-CONDITION is the book, not the events. A
    // cancel event stream can lie (10147 for a foreign-client id, a missed
    // status) — re-read the open orders and let anything still working
    // override its classification loudly. Round 7: override the COUNT too,
    // not just the log — an order the book shows working must never be
    // reported to the operator as cancelled.
    const stillOpen = new Set<number>();
    let verifyComplete = true;
    try {
        for (const side of [OrderAction.SELL, OrderAction.BUY]) {
            const view = await fetchOpenOrdersFor(api, symbol, side, closeDeps.probeTimeoutMs);
            if (!view.complete) verifyComplete = false;
            for (const o of view.orders) stillOpen.add(o.orderId);
        }
        if (!verifyComplete) {
            logger.error(`[position-actions] ${symbol}: post-close book verification INCOMPLETE — the cancelled counts below are event-based only; verify the ${symbol} order book in TWS`);
        }
        for (const [oid, outcome] of outcomes) {
            if (stillOpen.has(oid)) {
                logger.error(
                    `[position-actions] ${symbol}: order #${oid} is STILL WORKING after cleanup (events said '${outcome}') — ` +
                    `the book overrides the event stream; cancel it in TWS or it can fill against a flat position.`,
                );
            }
        }
    } catch (err) {
        // Round-10 review: a THROWN verification is a failed verification —
        // leaving the flag true let event-only outcomes certify cancels
        // after the exact failure the verification exists to catch.
        verifyComplete = false;
        logger.warn(`[position-actions] ${symbol}: post-cleanup book verification failed: ${err}`);
    }
    let exitFilledDuringClose = false;
    for (const [oid, outcome] of outcomes) {
        if (stillOpen.has(oid)) {
            continue; // book truth: working — already loudly reported above
        } else if (outcome === 'cancelled') {
            // Round-9 review: only a VERIFIED book backs a confirmed count —
            // with a partial post-condition snapshot the event class alone
            // certifies nothing (the 10147 foreign-id lie again).
            if (verifyComplete) cancelledExits++;
        } else if (entryIds.has(oid) && (outcome === 'filled' || outcome === 'not-cancellable')) {
            // The entry that built the position we just closed — complete,
            // nothing working, nothing to alarm about.
            logger.info(`[position-actions] ${symbol}: entry order #${oid} already complete (${outcome}) — expected on a routine close`);
        } else if (outcome === 'filled') {
            exitFilledDuringClose = true;
            logger.error(
                `[position-actions] ${symbol}: exit order #${oid} FILLED during post-close cleanup — the account ` +
                `may hold an UNINTENDED position (a surviving stop shorts on trigger). Review 'positions' NOW.`,
            );
        } else {
            logger.error(
                `[position-actions] ${symbol}: cancel of exit order #${oid} ${outcome === 'not-cancellable' ? 'REFUSED (not in a cancellable state)' : 'NOT CONFIRMED'} — do not ` +
                `assume it is gone; the reconciliation sweep retries, verify in TWS if the symbol matters tonight.`,
            );
        }
    }
    // Round-11 review: report EVERY surviving order, not just the ones we
    // tried to cancel — a manual order that appeared after preflight is a
    // future position-opener against a flat account and was being dropped
    // from the result.
    for (const id of stillOpen) {
        if (!outcomes.some(([oid]) => oid === id)) {
            logger.error(
                `[position-actions] ${symbol}: order #${id} (not placed by this cleanup — manual or late) is STILL ` +
                `WORKING after the close — against a flat account it OPENS a position when it fills. Cancel it in TWS.`,
            );
        }
    }
    return {
        confirmedCancelled: cancelledExits,
        verified: verifyComplete,
        exitFilledDuringClose,
        stillWorking: [...stillOpen],
    };
}

export async function closePosition(symbolRaw: string, source = 'close command'): Promise<PositionActionOutcome> {
    const symbol = symbolRaw.trim().toUpperCase();
    if (closesInFlight.has(symbol)) {
        return {
            ok: false,
            message: `⏳ A close for ${symbol} is already in flight — not placing a second full-size order (reversal guard). Verify with 'orders'.`,
        };
    }
    // Review 2026-08-21 (round 3): a resting close (pre-market) can work
    // for HOURS — the guard must track the ORDER's life, not a wall-clock
    // window. The outcome tracker knows every registered close still
    // working; only when none is live does the 10-minute courtesy window
    // apply (covers the gap between fill and tracker bookkeeping).
    // Round-7 review: during gateway BOOT the guard's memory is empty until
    // the broker snapshot rehydrates it — an inbound close in that window
    // could double a resting pre-restart close. Wait briefly for the first
    // reconciliation; still pending → refuse, never guess. ('idle' =
    // tracker not running at all — TUI/standalone keeps its old semantics.)
    try {
        const { hasWorkingManualExit, reconciliationState } = await import('./outcome-tracker.js');
        if (reconciliationState() === 'pending') {
            const deadline = Date.now() + closeDeps.reconcileWaitMs;
            while (reconciliationState() === 'pending' && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 250));
            }
            if (reconciliationState() === 'pending') {
                return {
                    ok: false,
                    message:
                        `⏳ Cannot close ${symbol} yet: the gateway just started and broker reconciliation has not ` +
                        `finished — a resting pre-restart close would not be visible, and a second close REVERSES. ` +
                        `Retry in a few seconds.`,
                };
            }
        }
        if (hasWorkingManualExit(symbol)) {
            return {
                ok: false,
                message:
                    `⏳ A close order for ${symbol} is still WORKING at the broker — a second full-size close ` +
                    `would REVERSE the position when both fill. Cancel the working order first ('cancel ${symbol}' ` +
                    `or TWS) if you want to replace it.`,
            };
        }
    } catch { /* tracker unavailable — fall through to the time guard */ }
    if (wasRecentlyClosed(symbol)) {
        return {
            ok: false,
            message:
                `⏳ ${symbol} was closed less than 10 minutes ago. If 'positions' still shows it and 'orders' shows ` +
                `no working close, wait out the window — it exists so a filled close's bookkeeping can settle, ` +
                `never to be raced.`,
        };
    }
    closesInFlight.add(symbol);
    try {
        // Full identity gate, not the static-only check: these place real
        // orders, and the weaker gate silently passed on an empty account
        // list (WP0.4, audit 2026-08-20). Risk-reducing, so the 5s timeout
        // still bounds the wait.
        await closeDeps.verifyAccounts();

        // Post-close, a DAY MKT order is a guaranteed IBKR 201 rejection
        // (market-hours doctrine, observed live 2026-08-11). Placing it
        // anyway would then CANCEL the tracked bracket exits below — leaving
        // the position open AND unprotected overnight. Refuse instead: the
        // position keeps its stops and the operator gets told why (audit
        // 2026-08-20 finding 5). Pre-market DAY orders legally rest until
        // the open, so only AFTER_HOURS/OVERNIGHT/CLOSED refuse. Test-gated
        // like the executor's session gate (wall-clock dependent).
        if (process.env.NODE_ENV !== 'test' && !isTradeableSession(getMarketSession().session)) {
            return {
                ok: false,
                message:
                    `⛔ Cannot close ${symbol} now: the session is over, a DAY market order would be ` +
                    `rejected by the broker and its resting exits would have been cancelled anyway. ` +
                    `The position keeps its bracket protection; close it at the next open (or manually in TWS).`,
            };
        }

        const api = await closeDeps.getApi();
        const positions = await fetchPositions(api);
        const pos = positions.find((p) => p.symbol === symbol);
        if (!pos) {
            return { ok: false, message: `No open position in ${symbol} — nothing to close.` };
        }
        recentlyClosed.set(symbol, Date.now());

        const isLong = pos.quantity > 0;
        const qty = Math.abs(pos.quantity);
        const closeAction = isLong ? OrderAction.SELL : OrderAction.BUY;

        // Round-9 review: an automated close either shares ONE atomic
        // exclusion scheme with every working Dexter exit, or it does not
        // go out. Proceeding unjoined embedded the over-close race (a stop
        // and the close both filling = reversal); "documented trade-off"
        // is not a fix. Cases:
        //   complete view, no Dexter exits  → nothing to race, proceed
        //   complete view, wholly one group → JOIN it
        //   multi-group / ungrouped exits   → REFUSE with instructions
        //   incomplete view / probe failure → REFUSE (unprovable book)
        let joinOcaGroup: string | null = null;
        try {
            const exitView = await fetchOpenOrdersFor(api, symbol, closeAction, closeDeps.probeTimeoutMs);
            if (!exitView.complete) {
                recentlyClosed.delete(symbol);
                return {
                    ok: false,
                    message:
                        `⛔ Cannot close ${symbol} safely right now: the open-orders snapshot did not complete, ` +
                        `so a working exit could be hidden — the close and a hidden stop could BOTH fill and ` +
                        `reverse the position. Retry in a moment.`,
                };
            }
            // Round-10 review: EVERY working exit-side order can race the
            // close — a manual TWS stop is not ours to join OR cancel, so
            // filtering to OUR_REF before deciding "nothing to race" was a
            // bypass. Foreign/manual exits refuse outright.
            const foreign = exitView.orders.filter((o) => !OUR_REF.test(o.orderRef ?? ''));
            if (foreign.length > 0) {
                recentlyClosed.delete(symbol);
                return {
                    ok: false,
                    message:
                        `⛔ Cannot close ${symbol} atomically: ${foreign.length} working exit-side order(s) not placed by ` +
                        `Dexter (${foreign.map((o) => `#${o.orderId} ${o.orderType}${o.orderRef ? ` ref '${o.orderRef}'` : ''}`).join(', ')}) — ` +
                        `they cannot be joined or cancelled from here, and one filling alongside the close REVERSES the ` +
                        `position. Cancel them in TWS first, or close there.`,
                };
            }
            const ours = exitView.orders.filter((o) => OUR_REF.test(o.orderRef ?? ''));
            const groups = [...new Set(ours.filter((o) => o.ocaGroup !== null).map((o) => o.ocaGroup as string))];
            const ungrouped = ours.filter((o) => o.ocaGroup === null).length;
            if (ours.length === 0) {
                // Truly empty exit book — nothing can race the close.
            } else if (groups.length === 1 && ungrouped === 0) {
                joinOcaGroup = groups[0]!;
                logger.info(`[position-actions] ${symbol}: close joins exit OCA group '${joinOcaGroup}' — broker-side mutual exclusion with the stop/target`);
            } else {
                recentlyClosed.delete(symbol);
                return {
                    ok: false,
                    message:
                        `⛔ Cannot close ${symbol} atomically: its exit book spans ${groups.length} OCA group(s)` +
                        `${ungrouped > 0 ? ` plus ${ungrouped} ungrouped exit(s)` : ''} — the close cannot be made ` +
                        `mutually exclusive with ALL of them, and a stop filling alongside the close would REVERSE ` +
                        `the position. Cancel the extra exit pair first ('cancel ${symbol}' or TWS), then close.`,
                };
            }
        } catch (err) {
            recentlyClosed.delete(symbol);
            return {
                ok: false,
                message: `⛔ Cannot close ${symbol} safely: the exit-book probe failed (${err instanceof Error ? err.message : err}). Retry in a moment.`,
            };
        }

        // Review 2026-08-21 (round 4): the tracker registration must exist
        // BEFORE the first broker event can arrive. The old order —
        // place, wait up to 8s for the fill, then register — let the
        // tracker's permanent listener consume the fill of an order it did
        // not know: P&L lost, and the late-registered entry stayed
        // "working" forever, refusing every future close of the symbol.
        // (Dynamic import mirrors the tracker's own import of this module —
        // no static cycle.)
        const tracker = await import('./outcome-tracker.js').catch((err) => {
            logger.warn(`[position-actions] outcome tracker unavailable for ${symbol} close registration: ${err}`);
            return null;
        });
        const { orderId, order, ack } = await withOrderLock(async () => {
            const orderId = await closeDeps.nextOrderId(api);
            const order: Order = {
                orderId,
                // Identity binding (WP1): the close routes to the verified
                // account, not the API default.
                account: closeDeps.verifiedAccount(),
                orderRef: `close-${symbol}`,
                action: closeAction,
                totalQuantity: qty,
                orderType: OrderType.MKT,
                tif: TimeInForce.DAY,
                transmit: true,
                // Same OCA type as the exits (1 = cancel remaining on fill):
                // the close's fill kills the stop/target at the broker, and
                // a stop's fill kills this close — no over-close window.
                ...(joinOcaGroup ? { ocaGroup: joinOcaGroup, ocaType: 1 } : {}),
            };
            // Review 2026-08-21 (round 3): protection is removed only after
            // the close FILLS — an acknowledgement proves the broker saw
            // the order, not that the position is flat. Watch armed before
            // placement; an RTH market order fills within the window, a
            // pre-market one rests and the outcome tracker cleans up at
            // its eventual fill instead.
            const watch = watchOrderAcks(api, [orderId]);
            tracker?.trackManualExit(symbol, orderId, qty, source);
            try {
                api.placeOrder(orderId, stockContract(symbol), order);
            } catch (err) {
                // Never reached the broker: no events will ever untrack it.
                tracker?.untrackManualExit(orderId);
                watch.dispose();
                throw err;
            }
            const states = await watch.settle(closeDeps.fillWaitMs, 'filled');
            return { orderId, order, ack: states[0] };
        });

        if (ack?.rejection) {
            // The close DID NOT go out: protection stays exactly as it was.
            // The status listener usually untracked already (Inactive/
            // Cancelled event); this covers error-only rejections.
            tracker?.untrackManualExit(orderId);
            recentlyClosed.delete(symbol);
            const r = ack.rejection;
            logger.error(`[position-actions] close ${symbol} REJECTED by broker (${r.code ?? '?'}: ${r.reason})`);
            return {
                ok: false,
                state: 'rejected',
                message:
                    `❌ Close ${symbol} REJECTED by the broker (${r.reason}). ` +
                    `Nothing was cancelled — the position keeps its protection. Resolve and retry.`,
            };
        }

        if (!ack?.filled) {
            // Acked-or-silent but NOT FLAT: protection stays exactly where
            // it is. The outcome tracker owns the rest of this lifecycle —
            // when the close order's fill lands (pre-market closes fill at
            // the open), handleManualExitFill runs the exit cleanup; if the
            // order dies instead, the tracked exits were never touched.
            const working = ack?.acked === true;
            logger.warn(`[position-actions] close ${symbol}: ${working ? 'acknowledged but not filled' : 'no broker reaction'} within the window — exits left standing; cleanup happens at fill`);
            return {
                ok: true,
                state: working ? 'working' : 'unconfirmed',
                message:
                    `⏳ Close ${symbol} is ${working ? 'WORKING at the broker' : 'submitted but UNCONFIRMED'} (order ${orderId}) — ` +
                    `the position is NOT flat yet. Protective exits were LEFT STANDING and will be cancelled ` +
                    `automatically when the close fills. Do not assume flat until 'positions' shows it; ` +
                    `a second 'close ${symbol}' is refused while this order works.`,
            };
        }

        // The close FILLED — the position is flat, and only now does
        // protection removal become safe (review 2026-08-21). The tracker's
        // listener has already attributed the P&L (registration preceded
        // placement) and may have started its own fire-and-forget cleanup;
        // this awaited pass is the deterministic one the operator report
        // counts, and double-cancel of an already-dead order is a no-op.
        const cleanup = await cleanupExitsAfterClose(api, symbol);

        // Round-9 review: "the position is flat" is a POSITION claim — when
        // cleanup saw an exit fill during the race, was unverified, or left
        // orders working, re-read the position book before claiming it.
        // Round-11 review: flat is VERIFIED on every filled close, never
        // inferred — the fill proves the ORDER completed, and only a fresh
        // position snapshot proves the ACCOUNT is flat (quantity can drift
        // between the preflight snapshot and execution).
        let flatSuffix: string;
        let flat: boolean | null;
        try {
            const after = (await fetchPositions(api)).find((p) => p.symbol === symbol);
            if (after && after.quantity !== 0) {
                flat = false;
                flatSuffix = `⚠️ the position is NOT flat: ${after.quantity > 0 ? 'LONG' : 'SHORT'} ${Math.abs(after.quantity)} remains — ` +
                    `review 'positions' NOW (over-close race or drifted quantity).`;
                logger.error(`[position-actions] ${symbol}: post-close position check shows ${after.quantity} — NOT flat`);
            } else {
                flat = true;
                flatSuffix = 'the position book confirms FLAT.';
            }
        } catch {
            flat = null;
            flatSuffix = "⚠️ flatness could NOT be verified — check 'positions'.";
        }
        const exitsNote = cleanup.verified
            ? (cleanup.confirmedCancelled > 0
                ? `${cleanup.confirmedCancelled} resting exit order(s) cancelled (broker-verified).`
                : `No resting exits needed cancelling.`)
            : `⚠️ Exit cleanup ran but could NOT be verified (partial book view) — treat no cancellation as confirmed; check 'orders'.`;
        const workingNote = cleanup.stillWorking.length > 0
            ? ` ⚠️ ${cleanup.stillWorking.length} order(s) STILL WORKING despite cleanup — cancel in TWS.`
            : '';

        logger.info(`[position-actions] closed ${symbol}: ${order.action} ${qty} MKT (order ${orderId}) FILLED, ${cleanup.confirmedCancelled} exit(s) confirmed cancelled (verified=${cleanup.verified})`);
        return {
            ok: true,
            // Round 4: eod-triage and stacked-close flows gate on this —
            // omitting it made every filled close read as not-closed.
            state: 'filled',
            flat,
            clean: flat === true && cleanup.verified && !cleanup.exitFilledDuringClose && cleanup.stillWorking.length === 0,
            message:
                `🔚 Closed ${symbol}: ${order.action} ${qty} at market (order ${orderId}) — FILLED, ${flatSuffix} ` +
                exitsNote + workingNote,
        };
    } catch (err) {
        // The close did NOT go out (post-placement failures are absorbed by
        // the inner try/catches above) — forget the marker, or auto-protect
        // would treat a still-open position as operator-closed and skip it
        // for 10 minutes (audit 2026-08-20).
        recentlyClosed.delete(symbol);
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[position-actions] close ${symbol} failed: ${msg}`);
        return { ok: false, message: `❌ Could not close ${symbol} — ${msg}` };
    } finally {
        closesInFlight.delete(symbol);
    }
}
