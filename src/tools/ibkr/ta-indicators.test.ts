import { describe, expect, test } from 'bun:test';
import { computeAll, volumeAnalysis, vwap, type OHLCV } from './ta-indicators.js';
import { computeSignalScore, indicatorCoverage } from './signal-scorer.js';

// WP10 (REMEDIATION-2026-08-20): the first tests the indicator layer has
// ever had — the layer carrying the audit's VWAP/RVOL/MACD findings.

const last = (a: number[]) => a[a.length - 1];

describe('vwap — session reset (the 10-day cumulative anchor is dead)', () => {
    test('a new session key resets the accumulation', () => {
        // Day 1: price 100 everywhere → vwap 100. Day 2: price 200 —
        // a session-reset vwap is 200; the old cumulative blended ~150.
        const high = [101, 101, 201, 201];
        const low = [99, 99, 199, 199];
        const close = [100, 100, 200, 200];
        const volume = [1_000, 1_000, 1_000, 1_000];
        const times = ['20260810  09:35:00', '20260810  09:40:00', '20260811  09:35:00', '20260811  09:40:00'];
        const withReset = vwap(high, low, close, volume, times).vwap;
        expect(last(withReset)).toBeCloseTo(200, 6);
        // Without times: old whole-window behavior (single-session callers).
        const withoutTimes = vwap(high, low, close, volume).vwap;
        expect(last(withoutTimes)).toBeCloseTo(150, 6);
    });

    test('ISO bar times reset sessions too (backtest format)', () => {
        const v = vwap([101, 201], [99, 199], [100, 200], [1000, 1000],
            ['2026-08-10 09:35:00', '2026-08-11 09:35:00']).vwap;
        expect(last(v)).toBeCloseTo(200, 6);
    });
});

describe('volumeAnalysis — time-of-day RVOL, prior-window z-score', () => {
    test('the open bar is judged against PRIOR opens, not the prior afternoon', () => {
        // 4 sessions, 2 bars each: opens trade 10_000, afternoons 1_000.
        // Session 5's open at 30_000 is 3× the PRIOR OPENS' mean — the old
        // rolling window compared it against mostly-afternoon bars.
        const volume: number[] = [];
        const times: string[] = [];
        for (let d = 10; d <= 13; d++) {
            volume.push(10_000, 1_000);
            times.push(`202608${d}  09:35:00`, `202608${d}  15:55:00`);
        }
        volume.push(30_000);
        times.push('20260814  09:35:00');
        const { rvol } = volumeAnalysis(volume, 4, times);
        expect(last(rvol)).toBeCloseTo(3.0, 6);
    });

    test('current bar is EXCLUDED from its own baseline (no self-damping)', () => {
        // Without times: prior-20 fallback. 20 bars at 1_000, then 3_000:
        // the old inclusive window read 3000/1100 ≈ 2.73; prior-only = 3.0.
        const volume = [...Array(20).fill(1_000), 3_000];
        const { rvol, zScore } = volumeAnalysis(volume, 20);
        expect(last(rvol)).toBeCloseTo(3.0, 6);
        // Zero-variance baseline → z guarded to 0 (never ±Infinity).
        expect(last(zScore)).toBe(0);
    });

    test('z-score measures the burst against the PRIOR window', () => {
        // Varied baseline (alternating 900/1100, mean 1000, std 100);
        // burst 2_000 → z = (2000-1000)/100 = 10 against priors only.
        const base = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 900 : 1_100));
        const { zScore } = volumeAnalysis([...base, 2_000], 20);
        expect(last(zScore)).toBeCloseTo(10, 5);
    });
});

describe('coverage caps the composite (missing data is not a 46)', () => {
    const N = 60;
    const flatOhlcv = (): OHLCV => ({
        time: Array.from({ length: N }, (_, i) => `20260814  ${String(9 + Math.floor(i / 12)).padStart(2, '0')}:${String((i % 12) * 5).padStart(2, '0')}:00`),
        open: Array(N).fill(100),
        high: Array(N).fill(101),
        low: Array(N).fill(99),
        close: Array(N).fill(100),
        volume: Array(N).fill(10_000),
    });

    test('zero-history symbol scores ~0, not neutral', () => {
        const empty: OHLCV = { time: [], open: [], high: [], low: [], close: [], volume: [] };
        const ind = computeAll(empty);
        expect(indicatorCoverage(ind)).toBe(0);
        const r = computeSignalScore('EMPTY', 'long', '5 mins', ind, empty);
        expect(r.compositeScore).toBe(0);
        expect(r.coverage).toBe(0);
    });

    test('full-history symbol is uncapped and reports full coverage', () => {
        const ohlcv = flatOhlcv();
        const ind = computeAll(ohlcv);
        const r = computeSignalScore('FULL', 'long', '5 mins', ind, ohlcv);
        expect(r.coverage).toBeGreaterThan(0.8);
        expect(r.compositeScore).toBeGreaterThan(20); // neutral-ish flat tape, NOT zero
    });
});
