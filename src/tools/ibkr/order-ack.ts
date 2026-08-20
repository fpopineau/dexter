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
    /** IBKR's connection-independent order id, when the reaction carried it. */
    permId: number | null;
    rejection: { code: number | null; reason: string } | null;
}

export interface OrderAckWatch {
    /** Resolve when all legs reacted, any leg rejected, or after timeoutMs.
     *  Always resolves (never rejects); listeners are removed on settle. */
    settle(timeoutMs: number): Promise<LegAckState[]>;
    /** Remove listeners without settling (error-path cleanup). */
    dispose(): void;
}

/** Arm acknowledgement listeners for `orderIds`. Call BEFORE placeOrder. */
export function watchOrderAcks(api: IBApi, orderIds: number[]): OrderAckWatch {
    const states = new Map<number, LegAckState>(
        orderIds.map((id) => [id, { orderId: id, acked: false, permId: null, rejection: null }]),
    );
    let onSettled: (() => void) | null = null;

    // A single rejection settles immediately: a refused parent means the
    // children will never react (they were never transmitted), so waiting
    // for them only burns the timeout.
    const done = () =>
        [...states.values()].some((s) => s.rejection !== null) ||
        [...states.values()].every((s) => s.acked);
    const check = () => { if (onSettled && done()) onSettled(); };

    const onOrderStatus = (id: number, _status: string, _filled: number, _remaining: number, _avg: number, permId?: number) => {
        const s = states.get(id);
        if (!s) return;
        s.acked = true;
        if (typeof permId === 'number' && permId > 0) s.permId = permId;
        check();
    };
    const onOpenOrder = (id: number, _contract: unknown, order: Order) => {
        const s = states.get(id);
        if (!s) return;
        s.acked = true;
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
        settle(timeoutMs: number): Promise<LegAckState[]> {
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
