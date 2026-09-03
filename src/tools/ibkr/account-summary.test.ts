import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { EventName } from '@stoqey/ib';
import { __resetAccountSummaryForTests, requestAccountSummary } from './account-summary.js';

// Leak incident 2026-09-03: IBKR answered error 322 ("maximum number of
// account summary requests exceeded") because the guard's poller, the
// dashboard overview and the sampler each opened their own subscription
// and held it for the full timeout under a slow Gateway. These pin the
// two properties that stop it: ONE subscription per concurrent burst,
// and a cancel that always happens.

class FakeApi extends EventEmitter {
    requests: Array<{ reqId: number; tags: string }> = [];
    cancels: number[] = [];
    /** Broker reaction: 'end' (normal), 'silent' (timeout), 'throw'. */
    mode: 'end' | 'silent' | 'throw' = 'end';
    reqAccountSummary(reqId: number, _group: string, tags: string): void {
        if (this.mode === 'throw') throw new Error('not connected');
        this.requests.push({ reqId, tags });
        if (this.mode === 'end') {
            queueMicrotask(() => {
                this.emit(EventName.accountSummary, reqId, 'DU1', 'NetLiquidation', '12345.67', 'EUR');
                this.emit(EventName.accountSummaryEnd, reqId);
            });
        }
    }
    cancelAccountSummary(reqId: number): void {
        this.cancels.push(reqId);
    }
}

describe('requestAccountSummary (subscription leak fix)', () => {
    test('concurrent callers share ONE subscription and one cancel', async () => {
        __resetAccountSummaryForTests();
        const api = new FakeApi();
        const [a, b, c] = await Promise.all([
            requestAccountSummary(api as never, 'NetLiquidation', 1_000),
            requestAccountSummary(api as never, 'NetLiquidation', 1_000),
            requestAccountSummary(api as never, 'NetLiquidation', 1_000),
        ]);
        // The cap-exhaustion fix: three callers, one broker subscription.
        expect(api.requests.length).toBe(1);
        expect(api.cancels.length).toBe(1);
        expect(api.cancels[0]).toBe(api.requests[0].reqId);
        expect(a[0].value).toBe('12345.67');
        expect(a[0].currency).toBe('EUR');
        expect(b).toEqual(a);
        expect(c).toEqual(a);
    });

    test('a later request after settling opens a NEW subscription (no stale sharing)', async () => {
        __resetAccountSummaryForTests();
        const api = new FakeApi();
        await requestAccountSummary(api as never, 'NetLiquidation', 1_000);
        await requestAccountSummary(api as never, 'NetLiquidation', 1_000);
        expect(api.requests.length).toBe(2);
        expect(api.cancels.length).toBe(2);
        expect(new Set(api.cancels).size).toBe(2); // each its own reqId
    });

    test('a TIMEOUT still cancels — the leak path that exhausted the cap', async () => {
        __resetAccountSummaryForTests();
        const api = new FakeApi();
        api.mode = 'silent';
        const rows = await requestAccountSummary(api as never, 'NetLiquidation', 50);
        expect(rows).toEqual([]); // partial: nothing arrived
        expect(api.cancels).toEqual([api.requests[0].reqId]);
        // Listeners must be gone too, or the next request double-handles.
        expect(api.listenerCount(EventName.accountSummary)).toBe(0);
        expect(api.listenerCount(EventName.accountSummaryEnd)).toBe(0);
        expect(api.listenerCount(EventName.error)).toBe(0);
    });

    test('a synchronous request throw rejects immediately and leaves nothing armed', async () => {
        __resetAccountSummaryForTests();
        const api = new FakeApi();
        api.mode = 'throw';
        await expect(requestAccountSummary(api as never, 'NetLiquidation', 1_000))
            .rejects.toThrow(/failed synchronously.*not connected/);
        expect(api.listenerCount(EventName.accountSummary)).toBe(0);
        // The cancel is attempted even though the request never landed —
        // a subscription the broker DID open must not be abandoned.
        expect(api.cancels.length).toBe(1);
    });

    test('an error settles once: one cancel, no double-settle', async () => {
        __resetAccountSummaryForTests();
        const api = new FakeApi();
        api.mode = 'silent';
        const p = requestAccountSummary(api as never, 'NetLiquidation', 5_000);
        const reqId = api.requests[0].reqId;
        api.emit(EventName.error, new Error('boom'), 321, reqId);
        await expect(p).rejects.toThrow(/error 321/);
        expect(api.cancels).toEqual([reqId]);
        // A second error CANNOT re-settle: the handler is already detached
        // (asserted directly — emitting again would just hit Node's
        // no-listener 'error' semantics, testing the emitter, not us).
        expect(api.listenerCount(EventName.error)).toBe(0);
        expect(api.listenerCount(EventName.accountSummaryEnd)).toBe(0);
    });

    test('different tag sets do not share (the guard and the tool ask for different things)', async () => {
        __resetAccountSummaryForTests();
        const api = new FakeApi();
        await Promise.all([
            requestAccountSummary(api as never, 'NetLiquidation', 1_000),
            requestAccountSummary(api as never, 'NetLiquidation,TotalCashValue', 1_000),
        ]);
        expect(api.requests.map((r) => r.tags).sort())
            .toEqual(['NetLiquidation', 'NetLiquidation,TotalCashValue']);
        expect(api.cancels.length).toBe(2);
    });
});
