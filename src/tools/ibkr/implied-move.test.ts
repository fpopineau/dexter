import { describe, expect, test } from 'bun:test';
import { applyOptionTick, midPrice, nearestStrike, pickExpiration } from './implied-move.js';

describe('applyOptionTick — live AND delayed tick ids land in the same slots', () => {
    test('live ids (1/2/4/9)', () => {
        const t: Parameters<typeof applyOptionTick>[0] = {};
        applyOptionTick(t, 1, 0.83);
        applyOptionTick(t, 2, 0.95);
        applyOptionTick(t, 4, 0.9);
        applyOptionTick(t, 9, 0.6);
        expect(t).toEqual({ bid: 0.83, ask: 0.95, last: 0.9, close: 0.6 });
    });

    test('delayed ids (66/67/68/75) — the no-OPRA path, probe-verified 2026-08-13 on SMCI', () => {
        // Verbatim probe ticks: SMCI 39C 20260814 under market data type 3.
        const t: Parameters<typeof applyOptionTick>[0] = {};
        applyOptionTick(t, 66, 0.83);
        applyOptionTick(t, 67, 0.95);
        applyOptionTick(t, 68, 0.9);
        applyOptionTick(t, 75, 0.6);
        expect(t).toEqual({ bid: 0.83, ask: 0.95, last: 0.9, close: 0.6 });
        expect(midPrice(t)).toBeCloseTo(0.89, 4); // both sides → mid
    });

    test('junk prices and unrelated fields are ignored', () => {
        const t: Parameters<typeof applyOptionTick>[0] = {};
        applyOptionTick(t, 66, 0);
        applyOptionTick(t, 66, -1);   // IBKR "no data" sentinel
        applyOptionTick(t, 72, 3.4);  // delayed high — not a quote slot
        applyOptionTick(t, 73, 0.65); // delayed low
        expect(t).toEqual({});
    });
});

describe('midPrice fallbacks', () => {
    test('mid when both sides, else last, else close, else null', () => {
        expect(midPrice({ bid: 1, ask: 1.2 })).toBeCloseTo(1.1, 6);
        expect(midPrice({ last: 0.9 })).toBe(0.9);
        expect(midPrice({ close: 0.6 })).toBe(0.6);
        expect(midPrice({})).toBeNull();
        expect(midPrice({ bid: 1.3, ask: 1.2, last: 0.9 })).toBe(0.9); // crossed book → distrust, use last
    });
});

describe('expiration / strike selection', () => {
    test('nearest expiration ON/AFTER the reaction date', () => {
        expect(pickExpiration(['20260807', '20260814', '20260821'], '2026-08-14')).toBe('20260814');
        expect(pickExpiration(['20260807'], '2026-08-14')).toBeNull();
    });

    test('nearest strike to spot, ties to the lower strike', () => {
        expect(nearestStrike([35, 37.5, 39, 40], 39.16)).toBe(39);
        expect(nearestStrike([], 39.16)).toBeNull();
    });
});
