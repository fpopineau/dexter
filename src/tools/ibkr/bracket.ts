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

import type { Contract, IBApi, Order } from '@stoqey/ib';
import { OrderAction, OrderType, SecType, TimeInForce } from '@stoqey/ib';
import { logger } from '@/utils';
import { assertAccountsVerified, getIBApi, getVerifiedSingleAccount } from './connection.js';
import { confirmCancel, watchOrderAcks } from './order-ack.js';
import { withOrderLock } from './order-lock.js';
import { getNextValidOrderId } from './orders.js';
import { getRiskRules } from './risk-rules.js';
import { isValidQuantity } from '@/services/position-sizer.js';
import { intradayEntryCutoffReached, isMarketHalfDay } from '@/utils/market-hours.js';

/** How long placement waits for the broker's first reaction per bracket.
 *  TWS acks in tens of ms on a healthy link; 4s absorbs a loaded gateway
 *  without stalling the accept path noticeably. */
export const BRACKET_ACK_TIMEOUT_MS = 4_000;

export interface BracketRequest {
    symbol: string;
    direction: 'long' | 'short';
    quantity: number;
    /** 'LMT' places the entry at entryPrice; 'MKT' enters at market;
     *  'STP_LMT' is a momentum entry — triggers at entryPrice and fills up
     *  to entryLimitPrice (enters WITH strength instead of on a pullback). */
    entryType: 'LMT' | 'MKT' | 'STP_LMT';
    entryPrice?: number;
    /** STP_LMT only: the limit cap for the triggered entry. */
    entryLimitPrice?: number;
    stopPrice: number;
    targetPrice: number;
    outsideRth?: boolean;
    tif?: 'DAY' | 'GTC';
    exchange?: string;
    currency?: string;
    /** Stable reference stamped as orderRef "<refId>:<leg>" on every leg
     *  (WP1) — normally the proposal id. Correlates broker state back to
     *  the DB across reconnects, where client order ids reset. */
    refId?: string;
}

export interface BracketAck {
    /** 'acknowledged': every leg got a broker reaction. 'rejected': a leg
     *  errored — the placement is dead and all legs were cancel-swept.
     *  'unconfirmed': silence inside the window — the orders may well be
     *  working; VERIFY, never blind-retry. */
    outcome: 'acknowledged' | 'unconfirmed' | 'rejected';
    /** permIds aligned [parent, takeProfit, stop]; null where unseen. */
    permIds: Array<number | null>;
    rejection?: { orderId: number; code: number | null; reason: string };
    /** Round-5 review: legs of a rejected placement whose cancel the
     *  broker did NOT confirm dead ("#id outcome"). Empty = every leg
     *  confirmed cancelled; callers must not claim "nothing is working"
     *  when this is non-empty. */
    sweepResidues?: string[];
}

export interface BracketResult {
    parentOrderId: number;
    takeProfitOrderId: number;
    stopOrderId: number;
    ocaGroup: string;
    symbol: string;
    direction: 'long' | 'short';
    quantity: number;
    entryType: 'LMT' | 'MKT' | 'STP_LMT';
    entryPrice?: number;
    stopPrice: number;
    targetPrice: number;
    ack: BracketAck;
}

/** Structural validation of a bracket request (exported for tests). */
export function validateBracketRequest(req: BracketRequest): void {
    // Whole shares, or IBKR 0.0001-share fractions when the active rules
    // profile enables fractional trading. All three legs carry the same
    // explicit quantity, so the bracket stays atomic either way.
    if (!isValidQuantity(req.quantity, getRiskRules().fractional_shares)) {
        throw new Error('[bracket] quantity must be a positive whole number of shares, or a 0.0001-resolution fraction when fractional_shares is enabled');
    }
    if (req.entryType === 'LMT' && !(req.entryPrice && req.entryPrice > 0)) {
        throw new Error('[bracket] entryPrice is required for LMT entries');
    }
    if (req.entryType === 'STP_LMT') {
        if (!(req.entryPrice && req.entryPrice > 0) || !(req.entryLimitPrice && req.entryLimitPrice > 0)) {
            throw new Error('[bracket] STP_LMT entries require entryPrice (trigger) and entryLimitPrice (cap)');
        }
        if (req.direction === 'long' && !(req.entryLimitPrice >= req.entryPrice)) {
            throw new Error('[bracket] long STP_LMT: entryLimitPrice must be at or above the trigger');
        }
        if (req.direction === 'short' && !(req.entryLimitPrice <= req.entryPrice)) {
            throw new Error('[bracket] short STP_LMT: entryLimitPrice must be at or below the trigger');
        }
    }
    if (!(req.stopPrice > 0) || !(req.targetPrice > 0)) {
        throw new Error('[bracket] stopPrice and targetPrice must be positive');
    }
    // LMT and STP_LMT both carry an entry reference price (the limit or the
    // trigger); only MKT lacks one.
    const hasEntryRef = req.entryType !== 'MKT';
    const ref = hasEntryRef ? req.entryPrice! : (req.direction === 'long' ? req.targetPrice : req.stopPrice);
    if (req.direction === 'long') {
        if (!(req.stopPrice < ref)) throw new Error('[bracket] long: stopPrice must be below entry');
        if (!(req.targetPrice > (hasEntryRef ? req.entryPrice! : req.stopPrice))) {
            throw new Error('[bracket] long: targetPrice must be above entry');
        }
    } else {
        if (hasEntryRef) {
            if (!(req.stopPrice > req.entryPrice!)) throw new Error('[bracket] short: stopPrice must be above entry');
            if (!(req.targetPrice < req.entryPrice!)) throw new Error('[bracket] short: targetPrice must be below entry');
        } else if (!(req.targetPrice < req.stopPrice)) {
            throw new Error('[bracket] short: targetPrice must be below stopPrice');
        }
    }
}

/**
 * Place a bracket (entry + OCA exits). Resolves after the broker's first
 * reaction (or the ack window closing): the result's `ack` field says
 * whether the bracket is acknowledged, rejected (legs cancel-swept), or
 * unconfirmed (WP1 — before this, "placed" meant "handed to the API").
 */
export async function placeBracketOrder(req: BracketRequest): Promise<BracketResult> {
    validateBracketRequest(req);
    // The whole id-grant → three placeOrder calls sequence must be atomic
    // vs any other placement (ids N, N+1, N+2 are assumed contiguous).
    return withOrderLock(async () => {
        // Review-22 P1: the intraday cutoff is RE-CHECKED here, under the
        // SAME lock the EOD triage holds for its final snapshots — an
        // accept that passed the executor's early check at 15:51 and then
        // spent minutes in its gates cannot place a DAY bracket AFTER the
        // triage snapshot sequence: either this placement's lock section
        // runs first (the snapshots see the order), or triage ran first
        // and this recheck refuses. Central so EVERY bracket caller is
        // covered. Test-gated (wall clock), like the executor's gate.
        if (process.env.NODE_ENV !== 'test' && (req.tif ?? 'DAY') !== 'GTC') {
            const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            const closeMin = isMarketHalfDay(todayIso) ? 13 * 60 : 16 * 60;
            if (intradayEntryCutoffReached(nowEt.getHours() * 60 + nowEt.getMinutes(), closeMin)) {
                throw new Error(
                    '[session-gate] intraday entries are CLOSED for today (re-checked under the order lock at ' +
                    'placement — the accept outlived the cutoff while its gates ran). Wait for the next session, ' +
                    'or propose a GTC swing through its overnight gates.',
                );
            }
        }
        const api = await getIBApi();
        // Paper/live verification against the ACTUAL account codes — refuses
        // while they are still unknown (fail closed, not fail open).
        await assertAccountsVerified();
        return placeBracketOrderCore(api, getVerifiedSingleAccount(), req, BRACKET_ACK_TIMEOUT_MS);
    });
}

/**
 * The full placement flow against any IBApi-shaped emitter — exported so
 * the phase-1 harness drives ack/reject/timeout without a gateway. Callers
 * hold the order lock and have verified the account.
 */
export async function placeBracketOrderCore(
    api: IBApi,
    account: string,
    req: BracketRequest,
    ackTimeoutMs: number,
): Promise<BracketResult> {
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
    // PROTECTIVE EXITS ARE ALWAYS GTC (review 2026-08-23): a DAY bracket
    // whose position filled used to lose its stop/target at the bell if the
    // gateway was down at the close — the one moment protection matters
    // most. Children attached by parentId stay dormant until the parent
    // fills and die with it if it expires/cancels, so GTC children on a
    // DAY parent add protection after a fill and nothing before it.
    const exitTif = TimeInForce.GTC;
    // Stable correlation key: client order ids reset per connection, but
    // orderRef survives on the broker side — reconciliation matches on it.
    const refBase = req.refId?.trim() || `BRKT-${parentId}`;

    const parent: Order = {
        orderId: parentId,
        account,
        orderRef: `${refBase}:entry`,
        action: entryAction,
        totalQuantity: req.quantity,
        orderType: req.entryType === 'LMT' ? OrderType.LMT
            : req.entryType === 'STP_LMT' ? OrderType.STP_LMT
            : OrderType.MKT,
        ...(req.entryType === 'LMT' ? { lmtPrice: req.entryPrice } : {}),
        ...(req.entryType === 'STP_LMT' ? { auxPrice: req.entryPrice, lmtPrice: req.entryLimitPrice } : {}),
        tif,
        outsideRth: req.outsideRth ?? false,
        transmit: false,
    };

    const takeProfit: Order = {
        orderId: takeProfitId,
        parentId,
        account,
        orderRef: `${refBase}:tp`,
        action: exitAction,
        totalQuantity: req.quantity,
        orderType: OrderType.LMT,
        lmtPrice: req.targetPrice,
        tif: exitTif,
        ocaGroup,
        ocaType: 1, // cancel remaining orders in group on fill
        transmit: false,
    };

    const stop: Order = {
        orderId: stopId,
        parentId,
        account,
        orderRef: `${refBase}:stop`,
        action: exitAction,
        totalQuantity: req.quantity,
        orderType: OrderType.STP,
        auxPrice: req.stopPrice,
        tif: exitTif,
        ocaGroup,
        ocaType: 1,
        transmit: true, // transmits the whole bracket atomically
    };

    // Arm the ack watch BEFORE placement — a fast broker reaction must not
    // slip between placeOrder and the first listener.
    const legIds = [parentId, takeProfitId, stopId];
    const watch = watchOrderAcks(api, legIds);
    try {
        api.placeOrder(parentId, contract, parent);
        api.placeOrder(takeProfitId, contract, takeProfit);
        api.placeOrder(stopId, contract, stop);
    } catch (err) {
        watch.dispose();
        throw err;
    }

    const states = await watch.settle(ackTimeoutMs);
    const byId = new Map(states.map((s) => [s.orderId, s]));
    const rejectedLeg = states.find((s) => s.rejection !== null);
    const ack: BracketAck = rejectedLeg
        ? {
            outcome: 'rejected',
            permIds: legIds.map((id) => byId.get(id)?.permId ?? null),
            rejection: { orderId: rejectedLeg.orderId, code: rejectedLeg.rejection!.code, reason: rejectedLeg.rejection!.reason },
        }
        : {
            outcome: states.every((s) => s.acked) ? 'acknowledged' : 'unconfirmed',
            permIds: legIds.map((id) => byId.get(id)?.permId ?? null),
        };

    if (ack.outcome === 'rejected') {
        // A rejected leg must not leave the others live: a parent without
        // its stop is unprotected exposure; children without a parent are a
        // reversal waiting for a price to print. Round-5 review: the sweep
        // is broker-CONFIRMED — "all legs cancelled" was previously just
        // "we asked", and a surviving child could still fill.
        const residues: string[] = [];
        for (const id of legIds) {
            const outcome = await confirmCancel(api, id, ackTimeoutMs);
            if (outcome !== 'cancelled') residues.push(`#${id} ${outcome}`);
        }
        ack.sweepResidues = residues;
        logger.error(
            `[bracket] ${contract.symbol} REJECTED by broker (order ${ack.rejection!.orderId}, ` +
            `code ${ack.rejection!.code ?? '?'}: ${ack.rejection!.reason}) — ` +
            (residues.length === 0
                ? 'all three legs cancel-swept (confirmed)'
                : `legs NOT confirmed dead: ${residues.join(', ')} — verify in TWS`),
        );
    } else {
        logger.info(
            `[bracket] placed ${req.direction} ${req.quantity} ${contract.symbol} ` +
            `(${req.entryType}${req.entryPrice ? `@${req.entryPrice}` : ''}, stop ${req.stopPrice}, target ${req.targetPrice}, ` +
            `ids ${parentId}/${takeProfitId}/${stopId}, ack ${ack.outcome}` +
            `${ack.permIds[0] ? `, permId ${ack.permIds[0]}` : ''})`,
        );
    }

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
        ack,
    };
}
