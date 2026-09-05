import { describe, expect, test } from 'bun:test';
import {
    detectCupAndHandle,
    detectFlatBase,
    detectPatterns,
    detectPullbackInUptrend,
    type DailyBar,
} from './pattern-detectors.js';

/** Build daily bars from a close series: tight candles around each close. */
function mkBars(closes: number[], volumes?: number[]): DailyBar[] {
    return closes.map((c, i) => ({
        time: `202601${String(i + 1).padStart(2, '0')}`, // synthetic, ordering only
        open: c * 0.998,
        high: c * 1.008,
        low: c * 0.992,
        close: c,
        volume: volumes?.[i] ?? 1_000_000,
    }));
}

const rise = (from: number, to: number, n: number) =>
    Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

describe('pullback-in-uptrend', () => {
    test('detects an orderly pullback to the 20-day EMA on drying volume', () => {
        // 100 days rising 50 → 100, then 6 days pulling back ~6% on low volume.
        const closes = [...rise(50, 100, 100), 98, 97, 96, 95.5, 95, 94.5];
        const vols = closes.map((_, i) => (i >= closes.length - 5 ? 500_000 : 1_000_000));
        const m = detectPullbackInUptrend(mkBars(closes, vols));
        expect(m).not.toBeNull();
        expect(m!.pattern).toBe('pullback-in-uptrend');
        expect(m!.score).toBeGreaterThanOrEqual(70);
        expect(m!.pivot).toBeCloseTo(100 * 1.008, 0); // the 20d high
        expect(m!.suggestedStop).toBeLessThan(94.5);
        expect(m!.note).toContain('pullback to EMA20');
        // REQ-LANE-005: versioned, and below the pivot = waiting for the trigger
        expect(m!.detectorVersion).toBe('v1');
        expect(m!.state).toBe('pivot-ready');
    });

    test('rejects a downtrend and a too-deep pullback', () => {
        const down = mkBars(rise(100, 60, 110));
        expect(detectPullbackInUptrend(down)).toBeNull();
        // 20% collapse after the rise is a broken trend, not a pullback
        const deep = [...rise(50, 100, 100), 95, 90, 85, 82, 80, 79];
        expect(detectPullbackInUptrend(mkBars(deep))).toBeNull();
    });
});

describe('flat-base', () => {
    test('detects a tight range near highs after an advance', () => {
        // 60 days rising 50 → 100, then 30 days flat 96–100 on half volume.
        const flat = Array.from({ length: 30 }, (_, i) => 98 + (i % 2 ? 1 : -1));
        const closes = [...rise(50, 100, 60), ...flat];
        const vols = closes.map((_, i) => (i >= 60 ? 500_000 : 1_100_000));
        const m = detectFlatBase(mkBars(closes, vols));
        expect(m).not.toBeNull();
        expect(m!.pattern).toBe('flat-base');
        expect(m!.suggestedEntry).toBeGreaterThan(m!.pivot);
        expect(m!.suggestedStop).toBeLessThan(m!.pivot);
        expect(m!.note).toContain('base');
    });

    test('rejects a wide choppy range', () => {
        const chop = Array.from({ length: 30 }, (_, i) => 85 + (i % 4) * 6); // ~20% swings
        const closes = [...rise(50, 100, 60), ...chop];
        expect(detectFlatBase(mkBars(closes))).toBeNull();
    });
});

describe('cup-and-handle', () => {
    /** Left rim 100 → rounded bottom → right rim ~99 → shallow handle. */
    function cupCloses(depthPct = 0.25): number[] {
        const pre = rise(70, 100, 55);                       // advance into the left rim (122 bars total ≥ the 120 minimum)
        const bottom = 100 * (1 - depthPct);
        const down = Array.from({ length: 30 }, (_, i) =>
            100 - (100 - bottom) * Math.sin(((i + 1) / 30) * (Math.PI / 2)));
        const up = Array.from({ length: 30 }, (_, i) =>
            bottom + (99 - bottom) * Math.sin(((i + 1) / 30) * (Math.PI / 2)));
        const handle = [98, 97.2, 96.5, 96, 96.3, 96.8, 97];  // drifting, upper half
        return [...pre, ...down, ...up, ...handle];
    }

    test('detects a classic 25% cup with a shallow handle', () => {
        const closes = cupCloses(0.25);
        const vols = closes.map((_, i) => (i >= closes.length - 7 ? 500_000 : 1_000_000));
        const m = detectCupAndHandle(mkBars(closes, vols));
        expect(m).not.toBeNull();
        expect(m!.pattern).toBe('cup-and-handle');
        expect(m!.pivot).toBeGreaterThan(96);
        expect(m!.suggestedStop).toBeLessThan(96.5);
        expect(m!.note).toContain('cup');
    });

    test('review 2026-09-06 finding 14: the pivot is fixed before the last bar; a last close at/above it is breakout-confirmed, below it pivot-ready', () => {
        const base = cupCloses(0.25); // handle [98, 97.2, 96.5, 96, 96.3, 96.8, 97] → pivot = high of the first handle bar (98 × 1.008)
        const ready = detectCupAndHandle(mkBars(base))!;
        expect(ready.state).toBe('pivot-ready');
        expect(ready.pivot).toBeCloseTo(98 * 1.008, 2);
        // the last bar closes through the pivot (99.5 > 98.78), still under the 2 % ceiling over the right rim
        const confirmed = detectCupAndHandle(mkBars([...base.slice(0, -1), 99.5]))!;
        expect(confirmed).not.toBeNull();
        expect(confirmed.state).toBe('breakout-confirmed');
        expect(confirmed.pivot).toBeCloseTo(98 * 1.008, 2); // the pivot did not move with the confirming bar
        // a last bar that pokes above the pivot but closes below it is NOT confirmed
        const poke = detectCupAndHandle(mkBars([...base.slice(0, -1), 98.5]))!; // high 99.29 > pivot, close 98.5 < 98.78
        expect(poke.state).toBe('pivot-ready');
    });

    test('rejects a crash too deep to be a cup', () => {
        expect(detectCupAndHandle(mkBars(cupCloses(0.5)))).toBeNull();
    });

    test('rejects when the handle has fallen away from the pivot', () => {
        const closes = [...cupCloses(0.25)];
        // handle collapses toward the middle of the cup
        closes.splice(closes.length - 7, 7, 95, 92, 90, 88, 87, 86, 85);
        expect(detectCupAndHandle(mkBars(closes))).toBeNull();
    });
});

describe('detectPatterns', () => {
    test('too little history returns no matches, never throws', () => {
        expect(detectPatterns(mkBars(rise(50, 60, 30)))).toEqual([]);
    });
});
