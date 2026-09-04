/**
 * Shared positions requester (contention fix, 2026-09-04).
 *
 * `reqPositions` opens a per-CLIENT stream ended by `cancelPositions` —
 * it is not a request/response pair, and IBKR supports exactly one such
 * stream per client. Dexter had TWO independent implementations (the
 * position-actions fetch used by triage/sweeps/dashboard, and the
 * account tool's `positions` view), so a second subscriber's cancel tore
 * down the first's stream and the loser timed out. Measured 2026-09-04:
 * every adoption sweep failing for hours (reconciliation INCOMPLETE →
 * close gate shut) while a FRESH client fetched positions in 17 ms —
 * proof the Gateway was healthy and the contention was ours.
 *
 * Single-flight is therefore not an optimisation here but a correctness
 * requirement: with one stream per client, concurrent callers MUST share
 * it. Per-request hardening (review-36/37) is preserved: settle exactly
 * once, detach listeners BEFORE cancelling (a cancel can synchronously
 * emit positionEnd), and always attempt the cancel — including when the
 * request throws synchronously.
 */

import { EventName, type Contract, type IBApi } from '@stoqey/ib';
import { isNonFatalIbkrError } from './connection.js';

export interface PositionRow {
    account: string;
    symbol: string;
    secType: string;
    exchange: string;
    currency: string;
    /** Signed: positive = long, negative = short. */
    quantity: number;
    avgCost: number;
}

/** Resolved rows plus whether the broker actually said "end" — a timeout
 *  yields whatever arrived, and callers that must not act on a partial
 *  book (close/protect verification) check `complete`. */
export interface PositionsSnapshot {
    positions: PositionRow[];
    complete: boolean;
}

let inFlight: Promise<PositionsSnapshot> | null = null;

/** Test hook: forget in-flight sharing between suites. */
export function __resetPositionsForTests(): void {
    inFlight = null;
}

function requestOnce(api: IBApi, timeoutMs: number): Promise<PositionsSnapshot> {
    const positions: PositionRow[] = [];
    return new Promise<PositionsSnapshot>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            api.off(EventName.position, onPosition);
            api.off(EventName.positionEnd, onEnd);
            api.off(EventName.error, onError);
            try { api.cancelPositions(); } catch { /* connection already gone */ }
            fn();
        };
        const onPosition = (account: string, contract: Contract, pos: number, avgCost?: number) => {
            if (pos === 0) return; // zero-quantity ghost rows are not holdings
            positions.push({
                account,
                symbol: contract.symbol ?? '',
                secType: String(contract.secType ?? ''),
                exchange: contract.exchange ?? contract.primaryExch ?? '',
                currency: contract.currency ?? '',
                quantity: pos,
                avgCost: avgCost ?? 0,
            });
        };
        const onEnd = () => settle(() => resolve({ positions, complete: true }));
        const onError = (err: Error, code: number, id: number) => {
            if (id !== -1) return; // positions errors carry no reqId
            if (isNonFatalIbkrError(code)) return;
            settle(() => reject(new Error(`positions error ${code}: ${err.message}`)));
        };
        const timer = setTimeout(() => settle(() => resolve({ positions, complete: false })), timeoutMs);
        api.on(EventName.position, onPosition);
        api.on(EventName.positionEnd, onEnd);
        api.on(EventName.error, onError);
        try {
            api.reqPositions();
        } catch (err) {
            settle(() => reject(new Error(`positions request failed synchronously: ${err instanceof Error ? err.message : String(err)}`)));
        }
    });
}

/**
 * The account's positions. Concurrent callers share ONE broker stream —
 * mandatory, not optional: a second stream on the same client kills the
 * first.
 */
export function requestPositions(api: IBApi, timeoutMs = 10_000): Promise<PositionsSnapshot> {
    if (inFlight) return inFlight;
    const p = requestOnce(api, timeoutMs).finally(() => {
        if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
}
