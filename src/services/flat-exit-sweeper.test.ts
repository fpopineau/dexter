import { describe, expect, test } from 'bun:test';
import { latchStep, selectOrphanedExits, suspectKey } from './flat-exit-sweeper.js';

// Incident 2026-08-26 (BZ): an account reset wiped a long position but
// left its GTC exits armed; six hours later the target filled against
// the flat account and opened a naked short. These pin the sweeper's
// decision core.

const o = (orderId: number, symbol: string, orderRef: string | null) => ({ orderId, symbol, orderRef });
const p = (symbol: string, quantity: number) => ({ symbol, quantity });

describe('selectOrphanedExits (the BZ decision matrix)', () => {
    test('the BZ scenario: exits resting, no position, no parent → ORPHANED', () => {
        const out = selectOrphanedExits(
            [o(2, 'BZ', 'P-6C90:tp'), o(3, 'BZ', 'P-6C90:stop')],
            [],
        );
        expect(out.get('BZ')).toEqual([2, 3]);
    });

    test('the BNS scenario: dormant children UNDER A WORKING PARENT are not orphans', () => {
        const out = selectOrphanedExits(
            [o(4, 'BNS', 'P-5414:entry'), o(5, 'BNS', 'P-5414:tp'), o(6, 'BNS', 'P-5414:stop')],
            [],
        );
        expect(out.size).toBe(0);
    });

    test('a held position keeps its exits — either sign', () => {
        const orders = [o(2, 'BZ', 'P-6C90:tp'), o(3, 'BZ', 'P-6C90:stop')];
        expect(selectOrphanedExits(orders, [p('BZ', 134)]).size).toBe(0);
        expect(selectOrphanedExits(orders, [p('BZ', -134)]).size).toBe(0);
        // A ZERO-quantity row is broker for "flat" — not a holding.
        expect(selectOrphanedExits(orders, [p('BZ', 0)]).get('BZ')).toEqual([2, 3]);
    });

    test('FOREIGN orders are never selected — the staged TWS bell-expiry bracket must survive', () => {
        const out = selectOrphanedExits(
            [o(90, 'F', null), o(91, 'F', ''), o(92, 'F', 'my-manual-bracket'), o(93, 'F', 'close-F')],
            [],
        );
        expect(out.size).toBe(0);
    });

    test('protect- refs (adopted-position exits) are dexter exits and sweep when flat', () => {
        const out = selectOrphanedExits(
            [o(11, 'BRK.B', 'protect-BRK.B:stop'), o(12, 'BRK.B', 'protect-BRK.B:tp')],
            [p('MU', 10)], // an unrelated holding changes nothing
        );
        expect(out.get('BRK.B')).toEqual([11, 12]);
    });

    test('per-symbol isolation: one orphan does not condemn a healthy neighbor', () => {
        const out = selectOrphanedExits(
            [o(2, 'BZ', 'P-6C90:tp'), o(21, 'MU', 'P-AAAA:tp'), o(22, 'MU', 'P-AAAA:stop')],
            [p('MU', 10)],
        );
        expect(out.get('BZ')).toEqual([2]);
        expect(out.has('MU')).toBe(false);
    });
});

describe('two-tick latch (transient states never cancel)', () => {
    test('first sighting arms, identical second sighting confirms', () => {
        const suspects = new Map([['BZ', [2, 3]]]);
        const first = latchStep(new Set(), suspects);
        expect(first.confirmed).toEqual([]);
        const second = latchStep(first.next, suspects);
        expect(second.confirmed).toEqual([['BZ', [2, 3]]]);
    });

    test('a CHANGED id set re-latches from zero — the situation moved, re-observe', () => {
        const first = latchStep(new Set(), new Map([['BZ', [2, 3]]]));
        const second = latchStep(first.next, new Map([['BZ', [3]]])); // one leg vanished (fill? cancel?)
        expect(second.confirmed).toEqual([]);
    });

    test('suspect identity is order-insensitive', () => {
        expect(suspectKey('BZ', [3, 2])).toBe(suspectKey('BZ', [2, 3]));
    });
});
