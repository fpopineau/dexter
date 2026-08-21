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
import { watchOrderAcks } from '@/tools/ibkr/order-ack.js';
import { withOrderLock } from '@/tools/ibkr/order-lock.js';
import { getNextValidOrderId } from '@/tools/ibkr/orders.js';
import { getMarketSession, isTradeableSession } from '@/utils/market-hours.js';
import { logger } from '@/utils';
import type { Contract, Order } from '@stoqey/ib';
import { EventName, OrderAction, OrderType, SecType, TimeInForce } from '@stoqey/ib';

export interface PositionActionOutcome {
    ok: boolean;
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
}

/** Working orders for a symbol on the given side (all API clients). */
export async function fetchOpenOrdersFor(
    api: import('@stoqey/ib').IBApi,
    symbol: string,
    side: OrderAction,
): Promise<OpenOrderSummary[]> {
    const found: OpenOrderSummary[] = [];
    return new Promise<OpenOrderSummary[]>((resolve) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve(found);
        }, 10_000);
        const onOpen = (id: number, contract: Contract, order: Order) => {
            if ((contract.symbol ?? '') !== symbol) return;
            if ((order.action ?? '') !== side) return;
            found.push({
                orderId: id,
                orderType: String(order.orderType ?? ''),
                tif: String(order.tif ?? ''),
                orderRef: typeof order.orderRef === 'string' ? order.orderRef : null,
            });
        };
        const onEnd = () => {
            clearTimeout(timeout);
            cleanup();
            resolve(found);
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
        const existing = await fetchOpenOrdersFor(api, symbol, exitAction);
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
                ...(targetPrice !== undefined ? { ocaGroup, ocaType: 1 } : {}),
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
            if (rejected) {
                // A half-armed OCA pair is worse than none: sweep the legs
                // and report the truth — the position is NOT protected.
                for (const id of legIds) {
                    try { api.cancelOrder(id); } catch { /* already dead */ }
                }
                return {
                    rejected: `order ${rejected.orderId}: ${rejected.rejection!.reason}`,
                    msg: '', ids: { stopOrderId: stopId },
                };
            }
            const unconfirmed = states.some((s) => !s.acked);
            const idsOut = targetId !== null ? { stopOrderId: stopId, targetOrderId: targetId } : { stopOrderId: stopId };
            const msg = targetId !== null
                ? `, target ${targetPrice} (orders ${stopId}/${targetId}, OCA ${ocaGroup}${unconfirmed ? ', ack PENDING — verify with \'orders\'' : ''})`
                : ` (order ${stopId}${unconfirmed ? ', ack PENDING — verify with \'orders\'' : ''})`;
            return { rejected: null as string | null, msg, ids: idsOut };
        });

        if (placed.rejected) {
            logger.error(`[position-actions] protect ${symbol} REJECTED: ${placed.rejected}`);
            return {
                ok: false,
                message: `❌ ${symbol} is NOT protected — the broker rejected the protective exits (${placed.rejected}). Fix the levels and retry, or close the position.`,
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

export async function closePosition(symbolRaw: string, source = 'close command'): Promise<PositionActionOutcome> {
    const symbol = symbolRaw.trim().toUpperCase();
    if (closesInFlight.has(symbol)) {
        return {
            ok: false,
            message: `⏳ A close for ${symbol} is already in flight — not placing a second full-size order (reversal guard). Verify with 'orders'.`,
        };
    }
    if (wasRecentlyClosed(symbol)) {
        return {
            ok: false,
            message:
                `⏳ ${symbol} was closed less than 10 minutes ago — its close order may still be working ` +
                `(a second full-size close would REVERSE the position). Verify with 'orders' and 'positions' first.`,
        };
    }
    closesInFlight.add(symbol);
    try {
        // Full identity gate, not the static-only check: these place real
        // orders, and the weaker gate silently passed on an empty account
        // list (WP0.4, audit 2026-08-20). Risk-reducing, so the 5s timeout
        // still bounds the wait.
        await assertAccountsVerified();

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

        const api = await getIBApi();
        const positions = await fetchPositions(api);
        const pos = positions.find((p) => p.symbol === symbol);
        if (!pos) {
            return { ok: false, message: `No open position in ${symbol} — nothing to close.` };
        }
        recentlyClosed.set(symbol, Date.now());

        const isLong = pos.quantity > 0;
        const qty = Math.abs(pos.quantity);
        const { orderId, order, ack } = await withOrderLock(async () => {
            const orderId = await getNextValidOrderId(api);
            const order: Order = {
                orderId,
                // Identity binding (WP1): the close routes to the verified
                // account, not the API default.
                account: getVerifiedSingleAccount(),
                orderRef: `close-${symbol}`,
                action: isLong ? OrderAction.SELL : OrderAction.BUY,
                totalQuantity: qty,
                orderType: OrderType.MKT,
                tif: TimeInForce.DAY,
                transmit: true,
            };
            // Review 2026-08-21: a close must be ACKNOWLEDGED before any
            // protection is removed — armed before placement so a fast
            // broker reaction cannot slip past the first listener.
            const watch = watchOrderAcks(api, [orderId]);
            try {
                api.placeOrder(orderId, stockContract(symbol), order);
            } catch (err) {
                watch.dispose();
                throw err;
            }
            const states = await watch.settle(BRACKET_ACK_TIMEOUT_MS);
            return { orderId, order, ack: states[0] };
        });

        if (ack?.rejection) {
            // The close DID NOT go out: protection stays exactly as it was.
            recentlyClosed.delete(symbol);
            const r = ack.rejection;
            logger.error(`[position-actions] close ${symbol} REJECTED by broker (${r.code ?? '?'}: ${r.reason})`);
            return {
                ok: false,
                message:
                    `❌ Close ${symbol} REJECTED by the broker (${r.reason}). ` +
                    `Nothing was cancelled — the position keeps its protection. Resolve and retry.`,
            };
        }

        // Register the close with the outcome tracker BEFORE cancelling the
        // bracket exits: its fill is the exit price that turns the tracked
        // proposals' 'manual / P&L unknown' into a real realized P&L.
        // (Dynamic import mirrors the tracker's own import of this module —
        // no static cycle.)
        try {
            const { trackManualExit } = await import('./outcome-tracker.js');
            trackManualExit(symbol, orderId, qty, source);
        } catch (err) {
            logger.warn(`[position-actions] could not register ${symbol} close with the outcome tracker: ${err}`);
        }

        if (!ack?.acked) {
            // Unconfirmed close (broker silent through the window): removing
            // protection now gambles a naked position against a reversal —
            // the naked side loses. Exits stay; the operator resolves.
            logger.warn(`[position-actions] close ${symbol}: no broker ack within the window — exits left standing`);
            return {
                ok: true,
                message:
                    `⚠️ Close ${symbol} handed to the broker but NOT acknowledged yet (order ${orderId}). ` +
                    `The resting exits were LEFT STANDING — cancelling them against an unconfirmed close risks a ` +
                    `naked position. Verify with 'orders': close working → cancel the exits ('cancel ${symbol}'); ` +
                    `close absent → retry.`,
            };
        }

        // Cancel this symbol's tracked bracket/exit orders: a live GTC exit
        // on a CLOSED position is a naked short (or unintended long) waiting
        // for the target/stop price to print.
        let cancelledExits = 0;
        const cancelledIds = new Set<number>();
        try {
            const { listTrackable } = await import('./trade-proposals.js');
            for (const t of await listTrackable()) {
                if (t.symbol !== symbol || !t.orderIds?.length) continue;
                for (const oid of t.orderIds) {
                    try { api.cancelOrder(oid); cancelledExits++; cancelledIds.add(oid); } catch { /* already gone */ }
                }
            }
        } catch (err) {
            logger.warn(`[position-actions] exit cleanup for ${symbol} failed: ${err}`);
        }

        // WP11 (closes audit 2026-08-06 finding 10): GTC pairs placed
        // OUTSIDE proposal rows — the auto-protect path after a row already
        // closed — are persisted nowhere and used to survive every close.
        // Sweep by symbol: cancel resting GTC orders carrying OUR orderRef
        // (WP1 stamps one on every order); unknown refs are flagged and
        // left untouched (the WP3 orphan rule).
        const OUR_REF = /^(protect-|close-|reduce-|BRKT-|P-[0-9A-F]{4}:)/;
        try {
            for (const side of [OrderAction.SELL, OrderAction.BUY]) {
                for (const o of await fetchOpenOrdersFor(api, symbol, side)) {
                    if (cancelledIds.has(o.orderId) || o.tif !== 'GTC') continue;
                    if (OUR_REF.test(o.orderRef ?? '')) {
                        try { api.cancelOrder(o.orderId); cancelledExits++; cancelledIds.add(o.orderId); } catch { /* gone */ }
                        logger.info(`[position-actions] ${symbol}: swept orphaned GTC ${o.orderType} #${o.orderId} (ref '${o.orderRef}')`);
                    } else {
                        logger.warn(`[position-actions] ${symbol}: UNKNOWN GTC ${o.orderType} #${o.orderId}${o.orderRef ? ` (ref '${o.orderRef}')` : ''} left untouched — review in TWS`);
                    }
                }
            }
        } catch (err) {
            logger.warn(`[position-actions] orphan-exit sweep for ${symbol} failed: ${err}`);
        }

        logger.info(`[position-actions] closing ${symbol}: ${order.action} ${qty} MKT (order ${orderId}), ${cancelledExits} tracked exit order(s) cancelled`);
        return {
            ok: true,
            message:
                `🔚 Closing ${symbol}: ${order.action} ${qty} at market (order ${orderId}). ` +
                `Placed pre-market it rests until the open. ` +
                (cancelledExits > 0
                    ? `${cancelledExits} resting bracket/exit order(s) for ${symbol} cancelled with it.`
                    : `Note: any resting exits for ${symbol} should be reviewed ('orders').`),
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
