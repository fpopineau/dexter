import { describe, expect, test } from 'bun:test';
import {
    computeReactionStats,
    inferOlderReportDates,
    parseEarningsSurprise,
    parseNasdaqDate,
    ibkrDailyTimeToIso,
    type DailyCloseBar,
    type ReportDate,
} from './earnings-reactions.js';
import { midPrice, nearestStrike, pickExpiration } from '@/tools/ibkr/implied-move.js';

// ---------------------------------------------------------------------------
// Synthetic bar builder: flat $100 tape with injected earnings gaps.
// ---------------------------------------------------------------------------

/** Trading days (Mon–Fri) starting 2025-01-06, flat 100/100 bars. */
function flatBars(days: number): DailyCloseBar[] {
    const bars: DailyCloseBar[] = [];
    const d = new Date('2025-01-06T12:00:00Z');
    while (bars.length < days) {
        const dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6) {
            bars.push({ date: d.toISOString().slice(0, 10), open: 100, close: 100 });
        }
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return bars;
}

/**
 * Apply a reaction at index i (gap% at open, move% at close vs the prior
 * close) and carry the new level forward — a real tape does not un-gap the
 * next morning, and the reaction-day picker relies on that.
 */
function inject(bars: DailyCloseBar[], i: number, gapPct: number, closePct: number): void {
    const level = bars[i - 1].close;
    bars[i] = {
        ...bars[i],
        open: level * (1 + gapPct / 100),
        close: level * (1 + closePct / 100),
    };
    for (let j = i + 1; j < bars.length; j++) {
        bars[j] = { ...bars[j], open: bars[i].close, close: bars[i].close };
    }
}

describe('computeReactionStats', () => {
    test('AMC print: the reaction is read on the day AFTER the report date', () => {
        const bars = flatBars(30);
        inject(bars, 11, 6, 8); // gap +6%, closes +8% — the day after bars[10]
        const stats = computeReactionStats('TEST', bars, [
            { date: bars[10].date, verified: true, epsSurprisePct: 4 },
        ]);
        expect(stats.n).toBe(1);
        expect(stats.prints[0].reactionDate).toBe(bars[11].date);
        expect(stats.prints[0].gapPct).toBeCloseTo(6, 1);
        expect(stats.prints[0].closeMovePct).toBeCloseTo(8, 1);
        expect(stats.upCount).toBe(1);
    });

    test('BMO print: the reaction is read on the report date itself', () => {
        const bars = flatBars(30);
        inject(bars, 10, -7, -9);
        const stats = computeReactionStats('TEST', bars, [
            { date: bars[10].date, verified: true },
        ]);
        expect(stats.prints[0].reactionDate).toBe(bars[10].date);
        expect(stats.prints[0].closeMovePct).toBeCloseTo(-9, 1);
        expect(stats.downCount).toBe(1);
    });

    test('evidence bar: 8 prints at 7/8 up meets long, not short', () => {
        const bars = flatBars(420);
        const reports: ReportDate[] = [];
        for (let q = 0; q < 8; q++) {
            const i = 20 + q * 45;
            inject(bars, i, q === 3 ? -4 : 3, q === 3 ? -5 : 4); // one down print
            reports.push({ date: bars[i].date, verified: q < 4 });
        }
        const stats = computeReactionStats('TEST', bars, reports);
        expect(stats.n).toBe(8);
        expect(stats.nVerified).toBe(4);
        expect(stats.upCount).toBe(7);
        expect(stats.upConsistencyPct).toBeCloseTo(87.5, 1);
        expect(stats.meetsBarLong).toBe(true);
        expect(stats.meetsBarShort).toBe(false);
    });

    test('7 prints never meet the bar, whatever the consistency', () => {
        const bars = flatBars(400);
        const reports: ReportDate[] = [];
        for (let q = 0; q < 7; q++) {
            const i = 20 + q * 45;
            inject(bars, i, 3, 4);
            reports.push({ date: bars[i].date, verified: true });
        }
        const stats = computeReactionStats('TEST', bars, reports);
        expect(stats.n).toBe(7);
        expect(stats.upConsistencyPct).toBe(100);
        expect(stats.meetsBarLong).toBe(false);
    });

    test('worst adverse takes the worse of gap and close, per side', () => {
        const bars = flatBars(200);
        // Print A: gaps down -12% but recovers to close -2% → long adverse -12.
        inject(bars, 20, -12, -2);
        // Print B: gaps up +3 but closes -6 → long adverse -6, short adverse +3.
        inject(bars, 70, 3, -6);
        // Print C: clean up move → short adverse +9.
        inject(bars, 120, 5, 9);
        const stats = computeReactionStats('TEST', bars, [
            { date: bars[20].date, verified: true },
            { date: bars[70].date, verified: true },
            { date: bars[120].date, verified: true },
        ]);
        expect(stats.worstAdverseForLongPct).toBeCloseTo(12, 1);
        expect(stats.worstAdverseForShortPct).toBeCloseTo(9, 1);
        expect(stats.avgAbsMovePct).toBeCloseTo((2 + 6 + 9) / 3, 1);
        // Asymmetry stats: ups {+9}, downs {−2, −6}, signed mean +0.33.
        expect(stats.avgUpMovePct).toBeCloseTo(9, 1);
        expect(stats.avgDownMovePct).toBeCloseTo(4, 1);
        expect(stats.meanMovePct).toBeCloseTo(1 / 3, 1);
    });

    test('asymmetry beats hit rate: 1 up / 2 down can still be a positive-EV record', () => {
        // The SMCI-critique example shape: rare but huge up prints, frequent
        // small down prints. Consistency says "avoid long" (33%), the signed
        // mean says the record pays a long holder — both must be visible so
        // neither is mistaken for the whole story.
        const bars = flatBars(200);
        inject(bars, 20, 30, 40);   // one +40% print
        inject(bars, 70, -2, -3);   // two small negatives
        inject(bars, 120, -3, -5);
        const stats = computeReactionStats('TEST', bars, [
            { date: bars[20].date, verified: true },
            { date: bars[70].date, verified: true },
            { date: bars[120].date, verified: true },
        ]);
        expect(stats.upConsistencyPct).toBeCloseTo(33.33, 1);
        expect(stats.meanMovePct).toBeCloseTo((40 - 3 - 5) / 3, 1); // +10.67 per print
        expect(stats.avgUpMovePct).toBeCloseTo(40, 1);
        expect(stats.avgDownMovePct).toBeCloseTo(4, 1);
        expect(stats.meetsBarLong).toBe(false); // the admission bar still refuses — policy, not EV
    });

    test('duplicate report dates and unmatchable dates are dropped', () => {
        const bars = flatBars(30);
        inject(bars, 11, 6, 8);
        const stats = computeReactionStats('TEST', bars, [
            { date: bars[10].date, verified: true },
            { date: bars[10].date, verified: true },     // duplicate
            { date: '2010-01-01', verified: true },       // before history
        ]);
        expect(stats.n).toBe(1);
    });
});

describe('inferOlderReportDates', () => {
    test('snaps each quarterly step to the biggest gap in the window', () => {
        const bars = flatBars(420);
        // Real "earnings" gaps roughly every 63 trading days (~1 quarter).
        const gapIdx = [40, 103, 166, 229, 292, 355];
        for (const i of gapIdx) inject(bars, i, 7, 8);
        const newest = bars[355].date;
        const inferred = inferOlderReportDates(bars, newest, 4);
        expect(inferred.length).toBe(4);
        const expected = [292, 229, 166, 103].map((i) => bars[i].date);
        expect(inferred.map((d) => d.date)).toEqual(expected);
        expect(inferred.every((d) => !d.verified)).toBe(true);
    });

    test('stops when history runs out instead of inventing dates', () => {
        const bars = flatBars(80);
        const inferred = inferOlderReportDates(bars, bars[70].date, 6);
        expect(inferred.length).toBeLessThan(6);
    });
});

describe('parsers', () => {
    test('parseNasdaqDate handles M/D/YYYY', () => {
        expect(parseNasdaqDate('7/30/2026')).toBe('2026-07-30');
        expect(parseNasdaqDate('12/5/2025')).toBe('2025-12-05');
        expect(parseNasdaqDate('N/A')).toBeNull();
        expect(parseNasdaqDate(undefined)).toBeNull();
    });

    test('parseEarningsSurprise extracts dated rows newest-first', () => {
        const rows = parseEarningsSurprise({
            data: {
                earningsSurpriseTable: {
                    rows: [
                        { dateReported: '4/30/2026', eps: 2.01, percentageSurprise: '4.7' },
                        { dateReported: '7/30/2026', eps: 1.91, percentageSurprise: '1.6' },
                        { dateReported: 'pending', eps: null },
                    ],
                },
            },
        });
        expect(rows.map((r) => r.date)).toEqual(['2026-07-30', '2026-04-30']);
        expect(rows[0].epsSurprisePct).toBeCloseTo(1.6, 2);
        expect(rows.every((r) => r.verified)).toBe(true);
    });

    test('ibkrDailyTimeToIso', () => {
        expect(ibkrDailyTimeToIso('20260805')).toBe('2026-08-05');
        expect(ibkrDailyTimeToIso('20260805 16:00:00')).toBe('2026-08-05');
    });
});

describe('implied-move pure helpers', () => {
    test('pickExpiration: nearest on/after the reaction date', () => {
        const exps = ['20260807', '20260814', '20260821', 'garbage'];
        expect(pickExpiration(exps, '2026-08-07')).toBe('20260807');
        expect(pickExpiration(exps, '2026-08-08')).toBe('20260814');
        expect(pickExpiration(exps, '2026-09-01')).toBeNull();
    });

    test('nearestStrike: closest to spot, lower on ties', () => {
        expect(nearestStrike([90, 95, 100, 105], 101)).toBe(100);
        expect(nearestStrike([90, 100, 110], 105)).toBe(100);
        expect(nearestStrike([], 100)).toBeNull();
        expect(nearestStrike([100], 0)).toBeNull();
    });

    test('midPrice: bid/ask mid, then last, then close, else null', () => {
        expect(midPrice({ bid: 4, ask: 6 })).toBe(5);
        expect(midPrice({ bid: 4, ask: 6, last: 9 })).toBe(5);
        expect(midPrice({ last: 9 })).toBe(9);
        expect(midPrice({ close: 7 })).toBe(7);
        expect(midPrice({})).toBeNull();
        expect(midPrice({ bid: 6, ask: 4 })).toBeNull(); // crossed garbage
    });
});
