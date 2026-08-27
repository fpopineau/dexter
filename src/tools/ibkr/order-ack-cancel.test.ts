import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { EventName } from '@stoqey/ib';
import { classifyCancelRejection, confirmCancel, watchOrderAcks } from './order-ack.js';

// Round-5 review (2026-08-21): confirmCancel mapped IBKR 10148 to
// 'cancelled'. 10148 is "cannot be cancelled, state: <X>" — most often
// because the order FILLED. That mislabel could hide a filled entry as
// cancelled at EOD, announce runner mode after the target filled, and
// miscount post-close cleanup. These are the first tests of the helper.

class FakeApi extends EventEmitter {
    /** Broker reaction to the cancel request; default silence. */
    onCancel: ((id: number) => void) | null = null;
    cancelOrder(id: number): void {
        if (this.onCancel) this.onCancel(id);
    }
}

describe('classifyCancelRejection', () => {
    test('10147 (order not found) is a successful cancel — nothing is working', () => {
        expect(classifyCancelRejection(10147, 'OrderId 42 that needs to be cancelled is not found.')).toBe('cancelled');
    });
    test('10148 with a Filled state is FILLED, never cancelled', () => {
        expect(classifyCancelRejection(10148, 'OrderId 42 that needs to be cancelled cannot be cancelled, state: Filled.')).toBe('filled');
    });
    test('10148 localized (French TWS: Rempli) is still FILLED', () => {
        expect(classifyCancelRejection(10148, "L'ordre 42 ne peut pas être annulé, état: Rempli.")).toBe('filled');
    });
    test('10148 with a Cancelled state is cancelled', () => {
        expect(classifyCancelRejection(10148, 'cannot be cancelled, state: Cancelled.')).toBe('cancelled');
    });
    test('10148 with an unknown state is not-cancellable — never assumed gone', () => {
        expect(classifyCancelRejection(10148, 'cannot be cancelled, state: PendingSubmit.')).toBe('not-cancellable');
    });
    test('161 (not in a cancellable state) is not-cancellable', () => {
        expect(classifyCancelRejection(161, 'Cancel attempted when order is not in a cancellable state.')).toBe('not-cancellable');
    });
    test('unrelated codes do not classify', () => {
        expect(classifyCancelRejection(2109, 'order held while securities are located')).toBeNull();
    });
});

describe('confirmCancel', () => {
    test('Cancelled status confirms', async () => {
        const api = new FakeApi();
        api.onCancel = (id) => queueMicrotask(() => api.emit(EventName.orderStatus, id, 'Cancelled', 0, 0, 0));
        expect(await confirmCancel(api as never, 7, 200)).toBe('cancelled');
    });
    test('PendingCancel alone does NOT confirm — timeout says unconfirmed', async () => {
        const api = new FakeApi();
        api.onCancel = (id) => queueMicrotask(() => api.emit(EventName.orderStatus, id, 'PendingCancel', 0, 5, 0));
        expect(await confirmCancel(api as never, 7, 100)).toBe('unconfirmed');
    });
    test("Inactive does NOT confirm a cancel — IBKR uses it for invalid/rejected/HELD orders (round 6)", async () => {
        const api = new FakeApi();
        api.onCancel = (id) => queueMicrotask(() => api.emit(EventName.orderStatus, id, 'Inactive', 0, 5, 0));
        expect(await confirmCancel(api as never, 7, 200)).toBe('not-cancellable');
    });
    test('a fill during the cancel is reported as filled', async () => {
        const api = new FakeApi();
        api.onCancel = (id) => queueMicrotask(() => api.emit(EventName.orderStatus, id, 'Filled', 5, 0, 101.5));
        expect(await confirmCancel(api as never, 7, 200)).toBe('filled');
    });
    test('error 10148 state Filled is reported as filled', async () => {
        const api = new FakeApi();
        api.onCancel = (id) =>
            queueMicrotask(() => api.emit(EventName.error, new Error('cannot be cancelled, state: Filled'), 10148, id));
        expect(await confirmCancel(api as never, 7, 200)).toBe('filled');
    });
    test('error 10148 unknown state is not-cancellable', async () => {
        const api = new FakeApi();
        api.onCancel = (id) =>
            queueMicrotask(() => api.emit(EventName.error, new Error('cannot be cancelled, state: PreSubmitted'), 10148, id));
        expect(await confirmCancel(api as never, 7, 200)).toBe('not-cancellable');
    });
    test('broker silence is unconfirmed', async () => {
        const api = new FakeApi();
        expect(await confirmCancel(api as never, 7, 100)).toBe('unconfirmed');
    });
    test('events for other order ids are ignored', async () => {
        const api = new FakeApi();
        api.onCancel = () => {
            queueMicrotask(() => api.emit(EventName.orderStatus, 999, 'Cancelled', 0, 0, 0));
            queueMicrotask(() => api.emit(EventName.error, new Error('state: Filled'), 10148, 999));
        };
        expect(await confirmCancel(api as never, 7, 100)).toBe('unconfirmed');
    });
});

describe('watchOrderAcks vs warning 399 (incident 2026-08-27 — dawn placements read as rejections)', () => {
    test('a 399 order warning does not reject; the ack settles acked on PreSubmitted', async () => {
        const api = new FakeApi();
        const watch = watchOrderAcks(api as never, [11]);
        // IBKR's queued-for-the-open warning arrives BEFORE any status —
        // the old classification turned it into a rejection and auto-exec
        // marked every pre-market dawn proposal 'failed' at placement.
        api.emit(EventName.error, new Error('Votre ordre ne sera pas placé à l’échange avant que 2026-08-27 09:30:00 US/Eastern.'), 399, 11);
        api.emit(EventName.orderStatus, 11, 'PreSubmitted', 0, 8, 0, 77001);
        const legs = await watch.settle(500);
        expect(legs[0].rejection).toBeNull();
        expect(legs[0].acked).toBe(true);
        expect(legs[0].permId).toBe(77001);
    });

    test('a REAL rejection code still rejects immediately', async () => {
        const api = new FakeApi();
        const watch = watchOrderAcks(api as never, [12]);
        api.emit(EventName.error, new Error('Order rejected - reason: margin'), 201, 12);
        const legs = await watch.settle(500);
        expect(legs[0].rejection?.code).toBe(201);
        expect(legs[0].acked).toBe(false);
    });

    test('the status-path refusal detection is untouched: Inactive after a 399 still rejects', async () => {
        const api = new FakeApi();
        const watch = watchOrderAcks(api as never, [13]);
        api.emit(EventName.error, new Error('Order Message: some warning'), 399, 13);
        api.emit(EventName.orderStatus, 13, 'Inactive', 0, 8, 0, 0);
        const legs = await watch.settle(500);
        expect(legs[0].rejection?.reason).toContain('Inactive');
    });
});
