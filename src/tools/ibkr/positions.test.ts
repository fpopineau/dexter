import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { EventName } from '@stoqey/ib';
import { __resetPositionsForTests, requestPositions } from './positions.js';

// Contention incident 2026-09-04: reqPositions opens ONE stream per
// client, and dexter had two independent subscribers — each cancel tore
// down the other's stream, so every adoption sweep timed out for hours
// (reconciliation INCOMPLETE, close gate shut) while a fresh client
// fetched positions in 17 ms.

class FakeApi extends EventEmitter {
    reqs = 0;
    cancels = 0;
    mode: 'end' | 'silent' | 'throw' = 'end';
    reqPositions(): void {
        if (this.mode === 'throw') throw new Error('not connected');
        this.reqs++;
        if (this.mode === 'end') {
            queueMicrotask(() => {
                this.emit(EventName.position, 'DU1', { symbol: 'MU', secType: 'STK', currency: 'USD' }, 10, 88.5);
                this.emit(EventName.position, 'DU1', { symbol: 'GHOST', secType: 'STK', currency: 'USD' }, 0, 0);
                this.emit(EventName.positionEnd);
            });
        }
    }
    cancelPositions(): void { this.cancels++; }
}

describe('requestPositions (one stream per client — sharing is correctness)', () => {
    test('concurrent callers share ONE stream; zero-quantity ghosts are dropped', async () => {
        __resetPositionsForTests();
        const api = new FakeApi();
        const [a, b, c] = await Promise.all([
            requestPositions(api as never), requestPositions(api as never), requestPositions(api as never),
        ]);
        expect(api.reqs).toBe(1);
        expect(api.cancels).toBe(1);
        expect(a.complete).toBe(true);
        expect(a.positions).toEqual([
            { account: 'DU1', symbol: 'MU', secType: 'STK', exchange: '', currency: 'USD', quantity: 10, avgCost: 88.5 },
        ]);
        expect(b).toEqual(a);
        expect(c).toEqual(a);
    });

    test('a timeout reports INCOMPLETE (never "the account is flat") and still cancels', async () => {
        __resetPositionsForTests();
        const api = new FakeApi();
        api.mode = 'silent';
        const snap = await requestPositions(api as never, 40);
        expect(snap).toEqual({ positions: [], complete: false });
        expect(api.cancels).toBe(1);
        expect(api.listenerCount(EventName.position)).toBe(0);
        expect(api.listenerCount(EventName.positionEnd)).toBe(0);
        expect(api.listenerCount(EventName.error)).toBe(0);
    });

    test('a synchronous request throw rejects and leaves nothing armed', async () => {
        __resetPositionsForTests();
        const api = new FakeApi();
        api.mode = 'throw';
        await expect(requestPositions(api as never)).rejects.toThrow(/failed synchronously/);
        expect(api.listenerCount(EventName.position)).toBe(0);
        expect(api.cancels).toBe(1);
    });

    test('the shared slot clears on settle: the next call opens a fresh stream', async () => {
        __resetPositionsForTests();
        const api = new FakeApi();
        await requestPositions(api as never);
        await requestPositions(api as never);
        expect(api.reqs).toBe(2);
        expect(api.cancels).toBe(2);
    });

    test('a broker error settles once and detaches (no double-settle)', async () => {
        __resetPositionsForTests();
        const api = new FakeApi();
        api.mode = 'silent';
        const p = requestPositions(api as never, 5_000);
        api.emit(EventName.error, new Error('boom'), 504, -1);
        await expect(p).rejects.toThrow(/positions error 504/);
        expect(api.cancels).toBe(1);
        expect(api.listenerCount(EventName.error)).toBe(0);
    });
});
