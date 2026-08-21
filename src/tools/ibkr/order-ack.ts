/**
 * Order acknowledgement watching (WP1, REMEDIATION-2026-08-20).
 *
 * The broker's first reaction to a placed order — openOrder, orderStatus,
 * or an error carrying the order id — is the earliest moment "the order
 * exists" stops being an assumption. This module arms listeners BEFORE
 * placement (events can beat the next await) and settles when every
 * watched leg has reacted, when any leg is rejected, or on timeout.
 *
 * A timeout is NOT a rejection: TWS under load acknowledges late, and the
 * order may well be working — callers must treat 'unconfirmed' as
 * "verify", never as "retry" (a blind retry is how one intent becomes two
 * positions).
 */

import { EventName, type IBApi, type Order } from '@stoqey/ib';
import { isNonFatalIbkrError } from './connection.js';

export interface LegAckState {
    orderId: number;
    /** The broker reacted to this order (openOrder or orderStatus). */
    acked: boolean;
    /** The order FILLED completely (review 2026-08-21: acknowledgement is
     *  not flatness — risk-reducing flows gate on THIS, not on acked). */
    filled: boolean;
    /** IBKR's connection-independent order id, when the reaction carried it. */
    permId: number | null;
    rejection: { code: number | null; reason: string } | null;
}

export interface OrderAckWatch {
    /** Resolve when every leg reached `until` ('acked' default, or
     *  'filled'), any leg rejected, or after timeoutMs. Always resolves
     *  (never rejects); listeners are removed on settle. */
    settle(timeoutMs: number, until?: 'acked' | 'filled'): Promise<LegAckState[]>;
    /** Remove listeners without settling (error-path cleanup). */
    dispose(): void;
}

/** Arm acknowledgement listeners for `orderIds`. Call BEFORE placeOrder. */
export function watchOrderAcks(api: IBApi, orderIds: number[]): OrderAckWatch {
    const states = new Map<number, LegAckState>(
        orderIds.map((id) => [id, { orderId: id, acked: false, filled: false, permId: null, rejection: null }]),
    );
    let onSettled: (() => void) | null = null;
    let untilMode: 'acked' | 'filled' = 'acked';

    // A single rejection settles immediately: a refused parent means the
    // children will never react (they were never transmitted), so waiting
    // for them only burns the timeout.
    const done = () =>
        [...states.values()].some((s) => s.rejection !== null) ||
        [...states.values()].every((s) => (untilMode === 'filled' ? s.filled : s.acked));
    const check = () => { if (onSettled && done()) onSettled(); };

    const onOrderStatus = (id: number, status: string, filled: number, remaining: number, _avg: number, permId?: number) => {
        const s = states.get(id);
        if (!s) return;
        if (typeof permId === 'number' && permId > 0) s.permId = permId;
        // Review 2026-08-21: a terminal status INSIDE the ack window is a
        // rejection-equivalent, not an acknowledgement — IBKR reports some
        // refusals as 'Inactive'/'Cancelled' without an error event.
        if (status === 'Cancelled' || status === 'ApiCancelled' || status === 'Inactive') {
            s.rejection ??= { code: null, reason: `order went ${status} immediately after placement` };
        } else {
            s.acked = true;
            if (status === 'Filled' && remaining === 0 && filled > 0) s.filled = true;
        }
        check();
    };
    const onOpenOrder = (id: number, _contract: unknown, order: Order, orderState?: { status?: string }) => {
        const s = states.get(id);
        if (!s) return;
        // Review 2026-08-21: the accompanying OrderState can carry the
        // refusal ('Inactive') that no error event reports.
        const st = orderState?.status;
        if (st === 'Inactive' || st === 'Cancelled' || st === 'ApiCancelled') {
            s.rejection ??= { code: null, reason: `openOrder reported state ${st}` };
        } else {
            s.acked = true;
        }
        if (s.permId === null && typeof order?.permId === 'number' && order.permId > 0) s.permId = order.permId;
        check();
    };
    const onError = (err: Error, code: number, reqId: number) => {
        const s = states.get(reqId);
        if (!s) return;
        if (isNonFatalIbkrError(code)) return;
        s.rejection = { code: Number.isFinite(code) ? code : null, reason: err?.message ?? String(err) };
        check();
    };

    api.on(EventName.orderStatus, onOrderStatus);
    api.on(EventName.openOrder, onOpenOrder);
    api.on(EventName.error, onError);

    const dispose = () => {
        api.off(EventName.orderStatus, onOrderStatus);
        api.off(EventName.openOrder, onOpenOrder);
        api.off(EventName.error, onError);
    };

    return {
        dispose,
        settle(timeoutMs: number, until: 'acked' | 'filled' = 'acked'): Promise<LegAckState[]> {
            untilMode = until;
            return new Promise<LegAckState[]>((resolve) => {
                const timer = setTimeout(finish, timeoutMs);
                function finish() {
                    clearTimeout(timer);
                    onSettled = null;
                    dispose();
                    resolve([...states.values()]);
                }
                onSettled = finish;
                check(); // events may have settled everything already
            });
        },
    };
}

/** How a cancel request actually ended at the broker. 'filled' means the
 *  cancel LOST the race — the order executed, and the caller is holding a
 *  position change it did not intend. */
export type CancelOutcome = 'cancelled' | 'filled' | 'unconfirmed';

/** IBKR error codes that mean "that order is not working anymore" — for a
 *  cancel, that is success (10147/10148: order to cancel not found /
 *  already cancelled). */
const CANCEL_GONE_CODES = new Set([10147, 10148]);

/**
 * Cancel an order and wait for the broker to CONFIRM it (round-4 review,
 * 2026-08-21: every cancel used to be request-and-forget — "cancelled" in
 * a report meant "we asked", and a target/stop/close could fill during
 * the 15-minute healing-sweep gap while the book said it was gone).
 * Listeners armed before the request; always resolves.
 */
export function confirmCancel(api: IBApi, orderId: number, timeoutMs: number): Promise<CancelOutcome> {
    return new Promise<CancelOutcome>((resolve) => {
        let settled = false;
        const finish = (outcome: CancelOutcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            api.off(EventName.orderStatus, onOrderStatus);
            api.off(EventName.error, onError);
            resolve(outcome);
        };
        const onOrderStatus = (id: number, status: string, filled: number, remaining: number) => {
            if (id !== orderId) return;
            if (status === 'Cancelled' || status === 'ApiCancelled' || status === 'Inactive') finish('cancelled');
            else if (status === 'Filled' && remaining === 0 && filled > 0) finish('filled');
        };
        const onError = (_err: Error, code: number, reqId: number) => {
            if (reqId !== orderId) return;
            if (CANCEL_GONE_CODES.has(code)) finish('cancelled');
            // Other errors: keep waiting — a real status may still arrive,
            // and the timeout bounds the wait either way.
        };
        const timer = setTimeout(() => finish('unconfirmed'), timeoutMs);
        api.on(EventName.orderStatus, onOrderStatus);
        api.on(EventName.error, onError);
        try {
            api.cancelOrder(orderId);
        } catch {
            finish('unconfirmed');
        }
    });
}
