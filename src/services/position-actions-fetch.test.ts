import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { EventName, OrderAction } from '@stoqey/ib';
import { fetchOpenOrdersFor, fetchPositions } from './position-actions.js';

// Review-36 (Jest force-exit root cause): reqPositions/reqAllOpenOrders
// throwing SYNCHRONOUSLY (a fake without the method; production: a
// disconnect mid-shutdown) rejected through the executor throw with the
// 10s timeout and the listeners still armed — cleanup never ran, and
// Jest force-killed workers over the orphaned timers. The wrappers must
// settle immediately and leave ZERO residual listeners.

class ThrowingApi extends EventEmitter {
    reqPositions(): void { throw new Error('not connected'); }
    reqAllOpenOrders(): void { throw new Error('not connected'); }
    cancelPositions(): void { /* cleanup path calls this — must not throw */ }
}

// Review-37: cancellation that SYNCHRONOUSLY re-emits positionEnd during
// cleanup. With the old cancel-before-detach order this re-entered
// cleanup (stack overflow) and resolved [] through onEnd even though the
// request had thrown (reviewer-reproduced).
class ReentrantCancelApi extends EventEmitter {
    cancels = 0;
    reqPositions(): void { throw new Error('not connected'); }
    cancelPositions(): void {
        this.cancels++;
        this.emit(EventName.positionEnd);
    }
}

describe('fetch wrappers on a synchronously-throwing api (review-36)', () => {
    test('fetchPositions rejects NOW with the cause, every listener detached', async () => {
        const api = new ThrowingApi();
        const started = Date.now();
        await expect(fetchPositions(api as never)).rejects.toThrow(/failed synchronously.*not connected/);
        // Settled via the catch path, not the 10-second timeout.
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(api.listenerCount(EventName.position)).toBe(0);
        expect(api.listenerCount(EventName.positionEnd)).toBe(0);
        expect(api.listenerCount(EventName.error)).toBe(0);
    });

    test('fetchOpenOrdersFor resolves NOW as an incomplete view, every listener detached', async () => {
        const api = new ThrowingApi();
        const started = Date.now();
        const view = await fetchOpenOrdersFor(api as never, 'AAPL', OrderAction.SELL);
        // Fail-closed partiality is the contract — never rejection:
        // consumers already refuse to act on complete: false.
        expect(view).toEqual({ orders: [], complete: false });
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(api.listenerCount(EventName.openOrder)).toBe(0);
        expect(api.listenerCount(EventName.openOrderEnd)).toBe(0);
    });

    test('review-37: a synchronously-emitting cancelPositions cannot flip the rejection into an empty resolve', async () => {
        const api = new ReentrantCancelApi();
        await expect(fetchPositions(api as never)).rejects.toThrow(/failed synchronously/);
        // Idempotent cleanup: cancellation executes exactly once, and the
        // re-emitted positionEnd finds no listeners to resurrect onEnd.
        expect(api.cancels).toBe(1);
        expect(api.listenerCount(EventName.position)).toBe(0);
        expect(api.listenerCount(EventName.positionEnd)).toBe(0);
        expect(api.listenerCount(EventName.error)).toBe(0);
    });
});
