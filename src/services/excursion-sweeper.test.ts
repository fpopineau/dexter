import { describe, expect, test } from 'bun:test';
import { barsWithinHold } from './excursion-sweeper.js';
import { computeTradeExcursion } from './outcome-tracker.js';

// IBKR intraday bar time format: 'yyyymmdd  HH:MM:SS' (ET components).
const bar = (time: string, high: number, low: number) => ({ time, high, low });

describe('barsWithinHold (WP0.9 — the window is CLOSED on both ends)', () => {
    // 2026-08-14, 5-min bars. Fill 09:35, close 10:00.
    const bars = [
        bar('20260814  09:30:00', 101, 100),
        bar('20260814  09:35:00', 103, 101), // fill bar
        bar('20260814  09:50:00', 105, 102),
        bar('20260814  10:00:00', 104, 99), // close bar
        bar('20260814  10:30:00', 120, 98), // AFTER exit — must not count
    ];
    const fillMs = Date.UTC(2026, 7, 14, 9, 35); // frame-ms convention: ET components on a UTC frame
    const closeMs = Date.UTC(2026, 7, 14, 10, 0);

    test('bars after the exit are excluded — post-exit spikes must not inflate MFE', () => {
        const held = barsWithinHold(bars as never, fillMs, closeMs, 300_000);
        expect(held.map((b) => b.time)).toEqual([
            '20260814  09:35:00',
            '20260814  09:50:00',
            '20260814  10:00:00',
        ]);
        // Long from 102: MFE from the in-hold high 105, NOT the 10:30 120.
        const { mfePct, maePct } = computeTradeExcursion('long', 102, held as never);
        expect(mfePct).toBeCloseTo(2.94, 2);
        expect(maePct).toBeCloseTo(2.94, 2);
    });

    test('the bar containing the fill is included (boundary tolerance of one bar)', () => {
        // Fill at 09:37 falls INSIDE the 09:35 bar.
        const held = barsWithinHold(bars as never, Date.UTC(2026, 7, 14, 9, 37), closeMs, 300_000);
        expect(held[0]?.time).toBe('20260814  09:35:00');
    });
});

describe('legacyCounterfactual (REQ-EXIT-013 — the geometry the take policy replaced)', () => {
    const bar = (time: string, high: number, low: number) => ({ time, high, low, open: low, close: high, volume: 1 } as never);

    test('long: 2×ATR target hit before the 1×ATR stop', async () => {
        const { legacyCounterfactual } = await import('./excursion-sweeper.js');
        // entry 100, ATR 2 → target 104, stop 98.
        const v = legacyCounterfactual('long', 100, 2, [
            bar('20260820 10:00:00', 101, 99),
            bar('20260820 11:00:00', 104.2, 100.5),
        ]);
        expect(v).toBe('target-first');
    });

    test('long: stop touched first wins; both-in-one-bar scores stop-first (conservative)', async () => {
        const { legacyCounterfactual } = await import('./excursion-sweeper.js');
        expect(legacyCounterfactual('long', 100, 2, [
            bar('20260820 10:00:00', 101, 97.9),
            bar('20260820 11:00:00', 105, 100),
        ])).toBe('stop-first');
        expect(legacyCounterfactual('long', 100, 2, [
            bar('20260820 10:00:00', 104.5, 97.5), // touches both — ambiguous
        ])).toBe('stop-first');
    });

    test('short: mirrored levels; nothing touched → neither', async () => {
        const { legacyCounterfactual } = await import('./excursion-sweeper.js');
        // short entry 100, ATR 2 → target 96, stop 102.
        expect(legacyCounterfactual('short', 100, 2, [
            bar('20260820 10:00:00', 101, 95.8),
        ])).toBe('target-first');
        expect(legacyCounterfactual('short', 100, 2, [
            bar('20260820 10:00:00', 101, 99),
        ])).toBe('neither');
        // null highs/lows are skipped, not crashed on
        expect(legacyCounterfactual('short', 100, 2, [
            { time: '20260820 10:00:00', high: undefined, low: undefined } as never,
        ])).toBe('neither');
    });
});

describe('endOfEtDayFrame (post-exit window right edge)', () => {
    test('caps at 20:00 ET of the same frame day', async () => {
        const { endOfEtDayFrame } = await import('./excursion-sweeper.js');
        const day = Math.floor(1_787_000_000_000 / 86_400_000) * 86_400_000;
        const midMorning = day + 10 * 3_600_000;
        expect(endOfEtDayFrame(midMorning)).toBe(day + 20 * 3_600_000);
        // An instant at 20:00 exactly maps to itself.
        expect(endOfEtDayFrame(day + 20 * 3_600_000)).toBe(day + 20 * 3_600_000);
    });
});
