import { describe, expect, test } from 'bun:test';
import { buildEntryContext, minutesSinceOpenEt, sessionVwapFromBars } from './entry-context.js';

describe('buildEntryContext (2026-08-18 entry-audit instrumentation)', () => {
    test('long: every field signed toward the chase side', () => {
        const c = buildEntryContext({
            direction: 'long', ref: 110, dailyAtr: 5, ema10: 100, prevClose: 104, vwap: 108, minutesSinceOpen: 17,
        });
        expect(c.extensionAtr).toBe(2);              // (110 − 100) / 5
        expect(c.vwapDistPct).toBeCloseTo(1.85, 2);  // (110 − 108) / 108
        expect(c.dayMovePct).toBeCloseTo(5.77, 2);   // (110 − 104) / 104
        expect(c.minutesSinceOpen).toBe(17);
    });

    test('short mirrors the signs: below the mean = positive extension', () => {
        const c = buildEntryContext({
            direction: 'short', ref: 90, dailyAtr: 5, ema10: 100, prevClose: 96, vwap: 92, minutesSinceOpen: 0,
        });
        expect(c.extensionAtr).toBe(2);              // (100 − 90) / 5
        expect(c.vwapDistPct).toBeCloseTo(2.17, 2);  // (92 − 90) / 92
        expect(c.dayMovePct).toBeCloseTo(6.25, 2);   // (96 − 90) / 96
    });

    test('missing inputs leave honest nulls, never guesses', () => {
        expect(buildEntryContext({ direction: 'long', ref: 100 })).toEqual({
            extensionAtr: null, vwapDistPct: null, dayMovePct: null, minutesSinceOpen: null,
        });
        // Degenerate reference price: only the clock survives.
        expect(buildEntryContext({ direction: 'long', ref: 0, minutesSinceOpen: 5 }).minutesSinceOpen).toBe(5);
    });
});

describe('sessionVwapFromBars', () => {
    test('volume-weights bar WAPs', () => {
        expect(sessionVwapFromBars([
            { WAP: 10, volume: 100 },
            { WAP: 12, volume: 300 },
        ])).toBeCloseTo(11.5, 4);
    });

    test('typical price stands in for a missing WAP; zero-volume bars are skipped', () => {
        expect(sessionVwapFromBars([
            { high: 12, low: 10, close: 11, volume: 100 }, // typical (12+10+11)/3 = 11
            { WAP: 13, volume: 0 },                        // no volume — skipped
        ])).toBeCloseTo(11, 4);
    });

    test('no usable bars → null, never a price guess', () => {
        expect(sessionVwapFromBars([])).toBe(null);
        expect(sessionVwapFromBars([{ WAP: 10 }])).toBe(null);
    });
});

describe('minutesSinceOpenEt', () => {
    test('open, pre-market, and the triage slot — DST-correct via the ET frame', () => {
        // 2026-08-18 is EDT: 13:30 UTC = 09:30 ET.
        expect(minutesSinceOpenEt(new Date(Date.UTC(2026, 7, 18, 13, 30)))).toBe(0);
        expect(minutesSinceOpenEt(new Date(Date.UTC(2026, 7, 18, 12, 0)))).toBe(-90);
        expect(minutesSinceOpenEt(new Date(Date.UTC(2026, 7, 18, 19, 52)))).toBe(382); // 15:52 ET
    });
});
