/**
 * IBKR Order Management tool — place, modify, cancel orders and query open orders.
 *
 * Safety features:
 * - Paper-trading by default (connection default is port 7497 = TWS paper)
 * - SAFETY LOCK: order placement is refused on live ports (4001/7496) and on
 *   non-paper managed accounts unless IBKR_ALLOW_LIVE=true (see connection.ts)
 * - Registered in TOOLS_REQUIRING_APPROVAL so the agent must get user consent
 * - transmit=true by default but can be set to false for "what-if" orders
 * - Quantity and price sanity checks
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Contract, Order, OrderState } from '@stoqey/ib';
import { EventName, OrderAction, OrderStatus, OrderType, SecType, TimeInForce } from '@stoqey/ib';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { allocReqId, assertOrderingAllowed, getIBApi, isNonFatalIbkrError } from './connection.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORDER_TIMEOUT_MS = 15_000;

// Supported order types — keep it simple, no exotic algo orders
const SUPPORTED_ORDER_TYPES = [
    'MKT',
    'LMT',
    'STP',
    'STP_LMT',
    'TRAIL',
    'TRAIL_LIMIT',
    'MOC',
    'LOC',
    'MIDPRICE',
] as const;

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

export const IBKR_ORDERS_DESCRIPTION = `
Manage orders through Interactive Brokers. Requires interactive user
approval — in headless contexts (WhatsApp gateway, cron briefs, trigger
evaluations) this tool is AUTO-DENIED by design and will never succeed;
there, create a trade_proposal instead and tell the user to reply
'accept <ID>'. Supports three actions:

**place** — Submit a new order. Requires ticker, action (BUY/SELL), quantity, and order type.
  Order types: MKT (market), LMT (limit), STP (stop), STP_LMT (stop-limit),
  TRAIL (trailing stop), TRAIL_LIMIT, MOC (market-on-close), LOC (limit-on-close), MIDPRICE.
  For limit orders, provide limitPrice. For stop orders, provide stopPrice.
  For trailing stops, provide trailingAmount (dollar) or trailingPercent.

**cancel** — Cancel an existing order by orderId.

**list** — List all open orders. No additional parameters required.

IMPORTANT: This tool requires user approval before execution.
Orders go to the connected IB Gateway (paper or live depending on port).
A safety lock refuses order placement on live ports (4001/7496) or live
accounts unless the IBKR_ALLOW_LIVE environment variable is set to true.
`.trim();

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const PlaceOrderSchema = z.object({
    action: z.literal('place'),
    ticker: z.string().describe("US equity ticker symbol, e.g. 'AAPL'."),
    side: z.enum(['BUY', 'SELL']).describe('Order side: BUY or SELL.'),
    quantity: z.coerce.number().int().positive().describe('Number of shares. Must be a positive integer.'),
    orderType: z
        .enum(SUPPORTED_ORDER_TYPES)
        .describe('Order type: MKT, LMT, STP, STP_LMT, TRAIL, TRAIL_LIMIT, MOC, LOC, MIDPRICE.'),
    limitPrice: z.coerce.number().positive().optional().describe('Limit price (required for LMT, STP_LMT, LOC, TRAIL_LIMIT).'),
    stopPrice: z.coerce.number().positive().optional().describe('Stop/trigger price (required for STP, STP_LMT).'),
    trailingAmount: z.coerce.number().positive().optional().describe('Trailing amount in dollars (for TRAIL / TRAIL_LIMIT).'),
    trailingPercent: z.coerce.number().positive().optional().describe('Trailing percent (for TRAIL / TRAIL_LIMIT). Use this OR trailingAmount, not both.'),
    timeInForce: z.enum(['DAY', 'GTC', 'IOC', 'OPG', 'MOC']).default('DAY').describe("Time in force. Defaults to 'DAY'."),
    outsideRth: z.boolean().default(false).describe('Allow execution outside regular trading hours.'),
    exchange: z.string().default('SMART').describe("Exchange routing. Defaults to 'SMART'."),
    currency: z.string().default('USD').describe("Currency. Defaults to 'USD'."),
    transmit: z.boolean().default(true).describe('Transmit the order immediately. Set false for what-if preview.'),
});

const CancelOrderSchema = z.object({
    action: z.literal('cancel'),
    orderId: z.coerce.number().int().positive().describe('The order ID to cancel.'),
});

const ListOrdersSchema = z.object({
    action: z.literal('list'),
});

const OrdersSchema = z.discriminatedUnion('action', [
    PlaceOrderSchema,
    CancelOrderSchema,
    ListOrdersSchema,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapOrderType(ot: string): OrderType {
    const map: Record<string, OrderType> = {
        MKT: OrderType.MKT,
        LMT: OrderType.LMT,
        STP: OrderType.STP,
        STP_LMT: OrderType.STP_LMT,
        TRAIL: OrderType.TRAIL,
        TRAIL_LIMIT: OrderType.TRAIL_LIMIT,
        MOC: OrderType.MOC,
        LOC: OrderType.LOC,
        MIDPRICE: OrderType.MIDPRICE,
    };
    return map[ot] ?? OrderType.MKT;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createIbkrOrders() {
    return new DynamicStructuredTool({
        name: 'ibkr_orders',
        description: 'Place, cancel, or list orders through Interactive Brokers. Requires user approval.',
        schema: OrdersSchema,
        func: async (input) => {
            const api = await getIBApi();

            switch (input.action) {
                case 'place':
                    // Paper/live safety lock — throws on live port/account
                    // unless IBKR_ALLOW_LIVE=true. Cancel and list stay
                    // available in all cases (they only reduce risk).
                    assertOrderingAllowed();
                    return placeOrder(api, input);
                case 'cancel':
                    return cancelOrder(api, input);
                case 'list':
                    return listOpenOrders(api);
            }
        },
    });
}

// ---------------------------------------------------------------------------
// Place order
// ---------------------------------------------------------------------------

async function placeOrder(
    api: import('@stoqey/ib').IBApi,
    input: z.infer<typeof PlaceOrderSchema>,
): Promise<string> {
    // Get next valid order ID from IBKR
    const orderId = await getNextValidOrderId(api);

    const contract: Contract = {
        symbol: input.ticker.trim().toUpperCase(),
        secType: SecType.STK,
        exchange: input.exchange,
        currency: input.currency,
    };

    const order: Order = {
        orderId,
        action: input.side === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
        totalQuantity: input.quantity,
        orderType: mapOrderType(input.orderType),
        tif: input.timeInForce as typeof TimeInForce[keyof typeof TimeInForce],
        outsideRth: input.outsideRth,
        transmit: input.transmit,
    };

    // Set prices based on order type
    if (input.limitPrice != null) {
        order.lmtPrice = input.limitPrice;
    }
    if (input.stopPrice != null) {
        order.auxPrice = input.stopPrice;
    }
    if (input.trailingAmount != null) {
        order.auxPrice = input.trailingAmount;
    }
    if (input.trailingPercent != null) {
        order.trailingPercent = input.trailingPercent;
    }

    return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            // If we don't get status back, the order was likely submitted
            resolve(
                formatToolResult({
                    orderId,
                    status: 'Submitted (no confirmation received within timeout)',
                    ticker: contract.symbol,
                    side: input.side,
                    quantity: input.quantity,
                    orderType: input.orderType,
                    transmitted: input.transmit,
                }),
            );
        }, ORDER_TIMEOUT_MS);

        const onOrderStatus = (
            id: number,
            status: OrderStatus,
            filled: number,
            remaining: number,
            avgFillPrice: number,
            _permId?: number,
            _parentId?: number,
            _lastFillPrice?: number,
            _clientId?: number,
            _whyHeld?: string,
            _mktCapPrice?: number,
        ) => {
            if (id !== orderId) return;
            clearTimeout(timeout);
            cleanup();
            resolve(
                formatToolResult({
                    orderId,
                    status: status as string,
                    filled,
                    remaining,
                    avgFillPrice,
                    ticker: contract.symbol,
                    side: input.side,
                    quantity: input.quantity,
                    orderType: input.orderType,
                    limitPrice: input.limitPrice,
                    stopPrice: input.stopPrice,
                    transmitted: input.transmit,
                }),
            );
        };

        const onOpenOrder = (
            id: number,
            _contract: Contract,
            _order: Order,
            orderState: OrderState,
        ) => {
            if (id !== orderId) return;
            // If not yet resolved by orderStatus, use openOrder event
            if (orderState.status === OrderStatus.PreSubmitted ||
                orderState.status === OrderStatus.Submitted) {
                clearTimeout(timeout);
                cleanup();
                resolve(
                    formatToolResult({
                        orderId,
                        status: orderState.status as string,
                        warningText: orderState.warningText,
                        commission: orderState.commission,
                        initMarginChange: orderState.initMarginChange,
                        maintMarginChange: orderState.maintMarginChange,
                        ticker: contract.symbol,
                        side: input.side,
                        quantity: input.quantity,
                        orderType: input.orderType,
                        limitPrice: input.limitPrice,
                        stopPrice: input.stopPrice,
                        transmitted: input.transmit,
                    }),
                );
            }
        };

        const onError = (err: Error, code: number, id: number) => {
            if (id !== orderId && id !== -1) return;
            if (isNonFatalIbkrError(code)) return;
            clearTimeout(timeout);
            cleanup();
            reject(new Error(`[IBKR] Order error ${code}: ${err.message}`));
        };

        function cleanup() {
            api.off(EventName.orderStatus, onOrderStatus);
            api.off(EventName.openOrder, onOpenOrder);
            api.off(EventName.error, onError);
        }

        api.on(EventName.orderStatus, onOrderStatus);
        api.on(EventName.openOrder, onOpenOrder);
        api.on(EventName.error, onError);

        api.placeOrder(orderId, contract, order);
    });
}

// ---------------------------------------------------------------------------
// Cancel order
// ---------------------------------------------------------------------------

async function cancelOrder(
    api: import('@stoqey/ib').IBApi,
    input: z.infer<typeof CancelOrderSchema>,
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve(
                formatToolResult({
                    orderId: input.orderId,
                    status: 'Cancel requested (no confirmation within timeout)',
                }),
            );
        }, ORDER_TIMEOUT_MS);

        const onOrderStatus = (
            id: number,
            status: OrderStatus,
            filled: number,
            remaining: number,
            avgFillPrice: number,
        ) => {
            if (id !== input.orderId) return;
            if (
                status === OrderStatus.Cancelled ||
                status === OrderStatus.ApiCancelled ||
                status === OrderStatus.PendingCancel
            ) {
                clearTimeout(timeout);
                cleanup();
                resolve(
                    formatToolResult({
                        orderId: input.orderId,
                        status: status as string,
                        filled,
                        remaining,
                        avgFillPrice,
                    }),
                );
            }
        };

        const onError = (err: Error, code: number, id: number) => {
            if (id !== input.orderId && id !== -1) return;
            if (isNonFatalIbkrError(code)) return;
            clearTimeout(timeout);
            cleanup();
            reject(new Error(`[IBKR] Cancel error ${code}: ${err.message}`));
        };

        function cleanup() {
            api.off(EventName.orderStatus, onOrderStatus);
            api.off(EventName.error, onError);
        }

        api.on(EventName.orderStatus, onOrderStatus);
        api.on(EventName.error, onError);

        api.cancelOrder(input.orderId);
    });
}

// ---------------------------------------------------------------------------
// List open orders
// ---------------------------------------------------------------------------

interface OpenOrderEntry {
    orderId: number;
    symbol: string;
    secType: string;
    action: string;
    quantity: number;
    orderType: string;
    limitPrice?: number;
    auxPrice?: number;
    status?: string;
    filled?: number;
    remaining?: number;
}

async function listOpenOrders(api: import('@stoqey/ib').IBApi): Promise<string> {
    const orders: OpenOrderEntry[] = [];

    return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve(formatToolResult({ orders, partial: true }));
        }, ORDER_TIMEOUT_MS);

        const onOpenOrder = (
            orderId: number,
            contract: Contract,
            order: Order,
            orderState: OrderState,
        ) => {
            orders.push({
                orderId,
                symbol: contract.symbol ?? '',
                secType: contract.secType ?? '',
                action: order.action ?? '',
                quantity: order.totalQuantity ?? 0,
                orderType: order.orderType ?? '',
                limitPrice: order.lmtPrice,
                auxPrice: order.auxPrice,
                status: orderState.status,
                filled: undefined,
                remaining: undefined,
            });
        };

        const onOpenOrderEnd = () => {
            clearTimeout(timeout);
            cleanup();
            resolve(
                formatToolResult({
                    openOrderCount: orders.length,
                    orders,
                }),
            );
        };

        const onError = (err: Error, code: number, id: number) => {
            // Only catch global errors (id = -1) for open order requests
            if (id !== -1) return;
            if (isNonFatalIbkrError(code)) return;
            clearTimeout(timeout);
            cleanup();
            reject(new Error(`[IBKR] Open orders error ${code}: ${err.message}`));
        };

        function cleanup() {
            api.off(EventName.openOrder, onOpenOrder);
            api.off(EventName.openOrderEnd, onOpenOrderEnd);
            api.off(EventName.error, onError);
        }

        api.on(EventName.openOrder, onOpenOrder);
        api.on(EventName.openOrderEnd, onOpenOrderEnd);
        api.on(EventName.error, onError);

        api.reqAllOpenOrders();
    });
}

// ---------------------------------------------------------------------------
// Next valid order ID helper
// ---------------------------------------------------------------------------

export function getNextValidOrderId(api: import('@stoqey/ib').IBApi): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            // Fallback: use allocReqId() which won't collide with IBKR's IDs
            // in practice, but is less safe for order placement
            resolve(allocReqId() + 100_000);
        }, 5_000);

        const onNextValidId = (orderId: number) => {
            clearTimeout(timeout);
            cleanup();
            resolve(orderId);
        };

        const onError = (err: Error, code: number) => {
            if (code === -1) {
                clearTimeout(timeout);
                cleanup();
                reject(new Error(`[IBKR] Cannot get next valid order ID: ${err.message}`));
            }
        };

        function cleanup() {
            api.off(EventName.nextValidId, onNextValidId);
            api.off(EventName.error, onError);
        }

        api.on(EventName.nextValidId, onNextValidId);
        api.on(EventName.error, onError);

        api.reqIds();
    });
}
