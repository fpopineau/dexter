import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { EventName, OrderAction } from '@stoqey/ib';
import { entryActionFor, selectEntryLegToCancel } from './stale-entry-sweeper.js';

describe('selectEntryLegToCancel (REQ-ENTRY-003 — only the verified parent, never the children)', () => {
    const book = (orders: Array<{ orderId: number; orderRef: string | null }>, complete = true) => ({ orders, complete });

    test('finds the parent by its WP1 orderRef and ignores the exit legs', () => {
        const id = selectEntryLegToCancel('P-1A2B', book([
            { orderId: 501, orderRef: 'P-1A2B:entry' },
            { orderId: 502, orderRef: 'P-1A2B:tp' },
            { orderId: 503, orderRef: 'P-1A2B:stop' },
        ]));
        expect(id).toBe(501);
    });

    test('parent gone (filled / cancelled / never acked) → nothing to cancel, children untouched', () => {
        expect(selectEntryLegToCancel('P-1A2B', book([
            { orderId: 502, orderRef: 'P-1A2B:tp' },
            { orderId: 503, orderRef: 'P-1A2B:stop' },
        ]))).toBeNull();
    });

    test('another proposal\'s parent, a manual order, or a foreign ref is never selected', () => {
        expect(selectEntryLegToCancel('P-1A2B', book([
            { orderId: 601, orderRef: 'P-9F00:entry' },
            { orderId: 602, orderRef: null },
            { orderId: 603, orderRef: 'my-manual-buy' },
        ]))).toBeNull();
    });

    test('an INCOMPLETE broker view cancels nothing (a parent we cannot see is a parent we do not cancel)', () => {
        expect(selectEntryLegToCancel('P-1A2B', book([
            { orderId: 501, orderRef: 'P-1A2B:entry' },
        ], false))).toBeNull();
    });

    test('id matching is case-normalized like the store', () => {
        expect(selectEntryLegToCancel('p-1a2b', book([{ orderId: 7, orderRef: 'P-1A2B:entry' }]))).toBe(7);
    });

    test('entry side: a long enters by BUYING, a short by SELLING', () => {
        expect(entryActionFor('long')).toBe(OrderAction.BUY);
        expect(entryActionFor('short')).toBe(OrderAction.SELL);
    });
});

describe('cancelEntryLegCore — the full path on a fake broker (review 2026-08-23, item 4)', () => {
    class FakeIb extends EventEmitter {
        cancelled: number[] = [];
        book: Array<{ id: number; symbol: string; ref: string }> = [];
        /** Broker reaction to a cancel: [status, filled]. */
        onCancel: (id: number) => [string, number] = () => ['Cancelled', 0];
        reqAllOpenOrders(): void {
            queueMicrotask(() => {
                for (const o of this.book) {
                    this.emit(EventName.openOrder, o.id, { symbol: o.symbol }, {
                        action: 'BUY', orderType: 'STP LMT', tif: 'DAY', orderRef: o.ref,
                        account: 'DU1', totalQuantity: 10,
                    });
                }
                this.emit(EventName.openOrderEnd);
            });
        }
        cancelOrder(id: number): void {
            this.cancelled.push(id);
            const [status, filled] = this.onCancel(id);
            queueMicrotask(() => this.emit(EventName.orderStatus, id, status, filled, 0, 0));
        }
    }
    const proposal = { id: 'P-1A2B', symbol: 'CANC', direction: 'long' } as never;

    test('clean cancel: only the verified parent is cancelled; children untouched', async () => {
        const { cancelEntryLegCore } = await import('./stale-entry-sweeper.js');
        const fake = new FakeIb();
        fake.book = [
            { id: 501, symbol: 'CANC', ref: 'P-1A2B:entry' },
            // exit-side children exist on the SELL side and never even enter
            // the BUY-side book — but a same-side stray must survive too:
            { id: 509, symbol: 'CANC', ref: 'P-9F00:entry' },
        ];
        expect(await cancelEntryLegCore(fake as never, proposal, 'test')).toBe(true);
        expect(fake.cancelled).toEqual([501]); // never the other proposal's parent
    });

    test('Cancelled WITH filled>0 is a live partial position, never a clean sweep', async () => {
        const { cancelEntryLegCore } = await import('./stale-entry-sweeper.js');
        const fake = new FakeIb();
        fake.book = [{ id: 502, symbol: 'CANC', ref: 'P-1A2B:entry' }];
        fake.onCancel = () => ['Cancelled', 4];
        expect(await cancelEntryLegCore(fake as never, proposal, 'test')).toBe(false);
        expect(fake.cancelled).toEqual([502]); // the cancel went out — the RESULT is what must stay honest
    });

    test('parent already gone from the book: nothing cancelled at all', async () => {
        const { cancelEntryLegCore } = await import('./stale-entry-sweeper.js');
        const fake = new FakeIb();
        fake.book = []; // filled or expired — the tracker owns whatever happened
        expect(await cancelEntryLegCore(fake as never, proposal, 'test')).toBe(false);
        expect(fake.cancelled).toEqual([]);
    });
});
