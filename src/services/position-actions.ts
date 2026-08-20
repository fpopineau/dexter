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

import { allocReqId, assertAccountsVerified, getIBApi, getVerifiedSingleAccount, isNonFatalIbkrError } from '@/tools/ibkr/connection.js';
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
            found.push({ orderId: id, orderType: String(order.orderType ?? ''), tif: String(order.tif ?? '') });
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
            api.placeOrder(stopId, stockContract(symbol), stopOrder);

            if (targetPrice !== undefined) {
                const targetId = stopId + 1;
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
                return {
                    msg: `, target ${targetPrice} (orders ${stopId}/${targetId}, OCA ${ocaGroup})`,
                    ids: { stopOrderId: stopId, targetOrderId: targetId },
                };
            }
            return { msg: ` (order ${stopId})`, ids: { stopOrderId: stopId } };
        });

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
export async function closePosition(symbolRaw: string, source = 'close command'): Promise<PositionActionOutcome> {
    const symbol = symbolRaw.trim().toUpperCase();
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
        const { orderId, order } = await withOrderLock(async () => {
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
            api.placeOrder(orderId, stockContract(symbol), order);
            return { orderId, order };
        });

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

        // Cancel this symbol's tracked bracket/exit orders: a live GTC exit
        // on a CLOSED position is a naked short (or unintended long) waiting
        // for the target/stop price to print.
        let cancelledExits = 0;
        try {
            const { listTrackable } = await import('./trade-proposals.js');
            for (const t of await listTrackable()) {
                if (t.symbol !== symbol || !t.orderIds?.length) continue;
                for (const oid of t.orderIds) {
                    try { api.cancelOrder(oid); cancelledExits++; } catch { /* already gone */ }
                }
            }
        } catch (err) {
            logger.warn(`[position-actions] exit cleanup for ${symbol} failed: ${err}`);
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
    }
}
