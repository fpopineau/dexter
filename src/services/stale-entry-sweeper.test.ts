import { describe, expect, test } from 'bun:test';
import { OrderAction } from '@stoqey/ib';
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
