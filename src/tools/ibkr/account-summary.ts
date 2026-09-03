/**
 * Shared account-summary requester (leak fix, 2026-09-03).
 *
 * IBKR caps the number of CONCURRENT account-summary subscriptions per
 * client and answers an overflow with error 322 ("maximum number of
 * account summary requests exceeded; desubscribe to previous request
 * first"). Dexter had two independent implementations — the daily-loss
 * guard (polling NetLiq every ~60 s) and the account tool (dashboard
 * overview, `positions`, `pnl`) — each allocating its own reqId. Under a
 * slow Gateway every request holds its subscription for the full 10 s
 * timeout, so the pollers overlap, stack, and eventually exhaust the cap;
 * the leaked subscriptions also hold Gateway-side state, feeding the
 * ~2.9 GB/day heap growth measured 2026-08-31 → 09-03.
 *
 * This module makes the request path leak-proof:
 *   - SINGLE-FLIGHT per tag set: concurrent callers share one live
 *     subscription instead of opening N (the actual cap-exhaustion fix);
 *   - EXACTLY-ONCE settle: the cancel + listener detach run once, on
 *     whichever of end/error/timeout arrives first;
 *   - the cancel is always attempted, including when the request itself
 *     throws synchronously (disconnect mid-call), so no subscription is
 *     ever abandoned server-side.
 *
 * Rows are returned raw (account/tag/value/currency) — filtering and
 * shaping belong to the callers, which need different views.
 */

import { EventName, type IBApi } from '@stoqey/ib';
import { allocReqId, isNonFatalIbkrError } from './connection.js';

export interface AccountSummaryRow {
    account: string;
    tag: string;
    value: string;
    currency: string;
}

/** In-flight requests keyed by tag set — the single-flight window. */
const inFlight = new Map<string, Promise<AccountSummaryRow[]>>();

/** Test hook: forget in-flight sharing between suites. */
export function __resetAccountSummaryForTests(): void {
    inFlight.clear();
}

function requestOnce(api: IBApi, tags: string, timeoutMs: number): Promise<AccountSummaryRow[]> {
    const reqId = allocReqId();
    const rows: AccountSummaryRow[] = [];
    return new Promise<AccountSummaryRow[]>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // Detach BEFORE cancelling: a cancel that synchronously emits
            // an end/error event must not re-enter this handler chain.
            api.off(EventName.accountSummary, onSummary);
            api.off(EventName.accountSummaryEnd, onEnd);
            api.off(EventName.error, onError);
            // The cancel is the whole point of this module — never let it
            // throw its way out of the settle path.
            try { api.cancelAccountSummary(reqId); } catch { /* connection already gone */ }
            fn();
        };
        const onSummary = (id: number, account: string, tag: string, value: string, currency?: string) => {
            if (id !== reqId) return;
            rows.push({ account, tag, value, currency: currency ?? '' });
        };
        const onEnd = (id: number) => {
            if (id !== reqId) return;
            settle(() => resolve(rows));
        };
        const onError = (err: Error, code: number, id: number) => {
            if (id !== reqId) return;
            if (isNonFatalIbkrError(code)) return;
            settle(() => reject(new Error(`[account-summary] error ${code}: ${err.message}`)));
        };
        // A timeout resolves with WHAT ARRIVED (partial), matching the
        // previous behaviour of both call sites; the subscription is still
        // cancelled, which is what stops the leak.
        const timer = setTimeout(() => settle(() => resolve(rows)), timeoutMs);
        api.on(EventName.accountSummary, onSummary);
        api.on(EventName.accountSummaryEnd, onEnd);
        api.on(EventName.error, onError);
        try {
            api.reqAccountSummary(reqId, 'All', tags);
        } catch (err) {
            settle(() => reject(new Error(`[account-summary] request failed synchronously: ${err instanceof Error ? err.message : String(err)}`)));
        }
    });
}

/**
 * Request the given account-summary tags, sharing any request already in
 * flight for the same tag set. Always resolves or rejects with the
 * subscription cancelled.
 */
export function requestAccountSummary(api: IBApi, tags: string, timeoutMs: number): Promise<AccountSummaryRow[]> {
    const existing = inFlight.get(tags);
    if (existing) return existing;
    const p = requestOnce(api, tags, timeoutMs).finally(() => {
        // Only clear if still ours: a later request may already own the key.
        if (inFlight.get(tags) === p) inFlight.delete(tags);
    });
    inFlight.set(tags, p);
    return p;
}
