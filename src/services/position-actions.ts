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

import { allocReqId, assertOrderingAllowed, getIBApi, isNonFatalIbkrError } from '@/tools/ibkr/connection.js';
import { withOrderLock } from '@/tools/ibkr/order-lock.js';
import { getNextValidOrderId } from '@/tools/ibkr/orders.js';
import { logger } from '@/utils';
import type { Contract, Order } from '@stoqey/ib';
import { EventName, OrderAction, OrderType, SecType, TimeInForce } from '@stoqey/ib';

export interface PositionActionOutcome {
    ok: boolean;
    message: string;
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

interface OpenOrderSummary {
    orderId: number;
    orderType: string;
    tif: string;
}

/** Working orders for a symbol on the given side (all API clients). */
async function fetchOpenOrdersFor(
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
        assertOrderingAllowed();

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
        const targetMsg = await withOrderLock(async () => {
            const stopId = await getNextValidOrderId(api);
            const ocaGroup = `dexter-protect-${symbol}-${stopId}`;

            const stopOrder: Order = {
                orderId: stopId,
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
                return `, target ${targetPrice} (orders ${stopId}/${targetId}, OCA ${ocaGroup})`;
            }
            return ` (order ${stopId})`;
        });

        logger.info(`[position-actions] protected ${symbol}: ${exitAction} ${qty} stop ${stopPrice}${targetPrice !== undefined ? ` / target ${targetPrice}` : ''}`);
        return {
            ok: true,
            message:
                `🛡️ ${symbol} protected: ${isLong ? 'LONG' : 'SHORT'} ${qty} @ ${pos.avgCost.toFixed(2)} — ` +
                `GTC stop ${stopPrice}${targetMsg}. These exits survive the close.${dayNote}`,
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

/** Market-close the full position in a symbol (risk-reducing). */
export async function closePosition(symbolRaw: string): Promise<PositionActionOutcome> {
    const symbol = symbolRaw.trim().toUpperCase();
    try {
        assertOrderingAllowed();

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
                action: isLong ? OrderAction.SELL : OrderAction.BUY,
                totalQuantity: qty,
                orderType: OrderType.MKT,
                tif: TimeInForce.DAY,
                transmit: true,
            };
            api.placeOrder(orderId, stockContract(symbol), order);
            return { orderId, order };
        });

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
                `Outside market hours the order waits for the open. ` +
                (cancelledExits > 0
                    ? `${cancelledExits} resting bracket/exit order(s) for ${symbol} cancelled with it.`
                    : `Note: any resting exits for ${symbol} should be reviewed ('orders').`),
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[position-actions] close ${symbol} failed: ${msg}`);
        return { ok: false, message: `❌ Could not close ${symbol} — ${msg}` };
    }
}
