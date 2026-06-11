/**
 * Bracket order placement — parent entry + take-profit limit + stop-loss,
 * linked via parentId and an OCA group so the two exits cancel each other.
 *
 * Transmit semantics follow the IBKR convention: parent and take-profit are
 * sent with transmit=false; the final stop order carries transmit=true,
 * which atomically transmits the whole bracket.
 *
 * Callers are responsible for the safety gates (assertOrderingAllowed,
 * assertDailyLossOk) — this module only knows how to build the orders.
 */

import type { Contract, Order } from '@stoqey/ib';
import { OrderAction, OrderType, SecType, TimeInForce } from '@stoqey/ib';
import { logger } from '@/utils';
import { getIBApi } from './connection.js';
import { getNextValidOrderId } from './orders.js';

export interface BracketRequest {
    symbol: string;
    direction: 'long' | 'short';
    quantity: number;
    /** 'LMT' places the entry at entryPrice; 'MKT' enters at market. */
    entryType: 'LMT' | 'MKT';
    entryPrice?: number;
    stopPrice: number;
    targetPrice: number;
    outsideRth?: boolean;
    tif?: 'DAY' | 'GTC';
    exchange?: string;
    currency?: string;
}

export interface BracketResult {
    parentOrderId: number;
    takeProfitOrderId: number;
    stopOrderId: number;
    ocaGroup: string;
    symbol: string;
    direction: 'long' | 'short';
    quantity: number;
    entryType: 'LMT' | 'MKT';
    entryPrice?: number;
    stopPrice: number;
    targetPrice: number;
}

function validate(req: BracketRequest): void {
    if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
        throw new Error('[bracket] quantity must be a positive integer');
    }
    if (req.entryType === 'LMT' && !(req.entryPrice && req.entryPrice > 0)) {
        throw new Error('[bracket] entryPrice is required for LMT entries');
    }
    if (!(req.stopPrice > 0) || !(req.targetPrice > 0)) {
        throw new Error('[bracket] stopPrice and targetPrice must be positive');
    }
    const ref = req.entryType === 'LMT' ? req.entryPrice! : (req.direction === 'long' ? req.targetPrice : req.stopPrice);
    if (req.direction === 'long') {
        if (!(req.stopPrice < ref)) throw new Error('[bracket] long: stopPrice must be below entry');
        if (!(req.targetPrice > (req.entryType === 'LMT' ? req.entryPrice! : req.stopPrice))) {
            throw new Error('[bracket] long: targetPrice must be above entry');
        }
    } else {
        if (req.entryType === 'LMT') {
            if (!(req.stopPrice > req.entryPrice!)) throw new Error('[bracket] short: stopPrice must be above entry');
            if (!(req.targetPrice < req.entryPrice!)) throw new Error('[bracket] short: targetPrice must be below entry');
        } else if (!(req.targetPrice < req.stopPrice)) {
            throw new Error('[bracket] short: targetPrice must be below stopPrice');
        }
    }
}

/**
 * Place a bracket (entry + OCA exits). Resolves once the three orders have
 * been handed to the API with sequential ids; fills are asynchronous and
 * tracked by IBKR itself.
 */
export async function placeBracketOrder(req: BracketRequest): Promise<BracketResult> {
    validate(req);

    const api = await getIBApi();
    const parentId = await getNextValidOrderId(api);
    const takeProfitId = parentId + 1;
    const stopId = parentId + 2;
    const ocaGroup = `dexter-${req.symbol}-${parentId}`;

    const contract: Contract = {
        symbol: req.symbol.trim().toUpperCase(),
        secType: SecType.STK,
        exchange: req.exchange ?? 'SMART',
        currency: req.currency ?? 'USD',
    };

    const entryAction = req.direction === 'long' ? OrderAction.BUY : OrderAction.SELL;
    const exitAction = req.direction === 'long' ? OrderAction.SELL : OrderAction.BUY;
    const tif = (req.tif ?? 'DAY') as typeof TimeInForce[keyof typeof TimeInForce];

    const parent: Order = {
        orderId: parentId,
        action: entryAction,
        totalQuantity: req.quantity,
        orderType: req.entryType === 'LMT' ? OrderType.LMT : OrderType.MKT,
        ...(req.entryType === 'LMT' ? { lmtPrice: req.entryPrice } : {}),
        tif,
        outsideRth: req.outsideRth ?? false,
        transmit: false,
    };

    const takeProfit: Order = {
        orderId: takeProfitId,
        parentId,
        action: exitAction,
        totalQuantity: req.quantity,
        orderType: OrderType.LMT,
        lmtPrice: req.targetPrice,
        tif,
        ocaGroup,
        ocaType: 1, // cancel remaining orders in group on fill
        transmit: false,
    };

    const stop: Order = {
        orderId: stopId,
        parentId,
        action: exitAction,
        totalQuantity: req.quantity,
        orderType: OrderType.STP,
        auxPrice: req.stopPrice,
        tif,
        ocaGroup,
        ocaType: 1,
        transmit: true, // transmits the whole bracket atomically
    };

    api.placeOrder(parentId, contract, parent);
    api.placeOrder(takeProfitId, contract, takeProfit);
    api.placeOrder(stopId, contract, stop);

    logger.info(
        `[bracket] placed ${req.direction} ${req.quantity} ${contract.symbol} ` +
        `(${req.entryType}${req.entryPrice ? `@${req.entryPrice}` : ''}, stop ${req.stopPrice}, target ${req.targetPrice}, ` +
        `ids ${parentId}/${takeProfitId}/${stopId})`,
    );

    return {
        parentOrderId: parentId,
        takeProfitOrderId: takeProfitId,
        stopOrderId: stopId,
        ocaGroup,
        symbol: contract.symbol!,
        direction: req.direction,
        quantity: req.quantity,
        entryType: req.entryType,
        entryPrice: req.entryPrice,
        stopPrice: req.stopPrice,
        targetPrice: req.targetPrice,
    };
}
