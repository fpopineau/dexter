import { describe, expect, test } from 'bun:test';
import { parseEquitySeries, portfolioDrawdown } from './equity-series.js';

describe('equity series (REQ-VAL-006 — portfolio drawdown from marked NetLiq)', () => {
    const H = 3_600_000;
    const t0 = Date.UTC(2026, 7, 24, 14, 0, 0); // 2026-08-24 10:00 ET

    test('parse drops torn/invalid lines and sorts by time', () => {
        const text = [
            JSON.stringify({ ts: t0 + H, netLiq: 11_700 }),
            '{"ts": 1, "netLiq": ', // torn write
            JSON.stringify({ ts: t0, netLiq: 11_650 }),
            JSON.stringify({ ts: t0 + 2 * H, netLiq: 0 }), // impossible mark
            'garbage',
        ].join('\n');
        const s = parseEquitySeries(text);
        expect(s.map((x) => x.netLiq)).toEqual([11_650, 11_700]);
    });

    test('peak-to-trough sees the intraday trough the closed-trade curve misses', () => {
        // Equity climbs to 12,000, dives to 11,100 while positions are open,
        // recovers to 11,900 by the close. Closed-trade P&L would read the
        // day as flat-ish; marked drawdown is 7.5%.
        const series = [
            { ts: t0, netLiq: 11_700 },
            { ts: t0 + H, netLiq: 12_000 },
            { ts: t0 + 2 * H, netLiq: 11_100 },
            { ts: t0 + 3 * H, netLiq: 11_900 },
        ];
        const dd = portfolioDrawdown(series, t0)!;
        expect(dd.maxDdPct).toBeCloseTo(7.5, 5);
        expect(dd.peak).toBe(12_000);
        expect(dd.trough).toBe(11_100);
        expect(dd.samples).toBe(4);
        expect(dd.days.size).toBe(1);
    });

    test('window bounds: pre-window highs are another epoch; empty window → null', () => {
        const series = [
            { ts: t0 - 5 * H, netLiq: 13_000 }, // before the epoch — must not seed the peak
            { ts: t0, netLiq: 11_700 },
            { ts: t0 + H, netLiq: 11_500 },
        ];
        const dd = portfolioDrawdown(series, t0)!;
        expect(dd.maxDdPct).toBeCloseTo(100 * (200 / 11_700), 2); // metric rounds to 0.01%
        expect(portfolioDrawdown(series, t0 + 10 * H)).toBeNull();
    });

    test('a new high resets the trough; drawdown is measured from the latest peak', () => {
        const series = [
            { ts: t0, netLiq: 100 },
            { ts: t0 + H, netLiq: 90 },      // dd 10%
            { ts: t0 + 2 * H, netLiq: 120 }, // new peak
            { ts: t0 + 3 * H, netLiq: 114 }, // dd 5% from 120
        ];
        expect(portfolioDrawdown(series, t0)!.maxDdPct).toBeCloseTo(10, 5);
    });
});

describe('exposureCoverageGaps (review 2026-08-23 — the series must prove it was WATCHING)', () => {
    // 2026-08-24 is a Monday. Build ET-wall-clock instants via a helper:
    // 14:00 UTC = 10:00 ET (EDT).
    const et = (day: number, h: number, m: number) => Date.UTC(2026, 7, day, h + 4, m, 0);
    const s = (ts: number) => ({ ts, netLiq: 11_700 });
    const every5 = (day: number, fromH: number, fromM: number, toH: number, toM: number) => {
        const out = [];
        for (let t = et(day, fromH, fromM); t <= et(day, toH, toM); t += 5 * 60_000) out.push(s(t));
        return out;
    };

    test('full-day coverage at 5-min cadence passes', async () => {
        const { exposureCoverageGaps } = await import('@/utils/equity-series-math.js');
        const series = every5(24, 9, 30, 16, 0);
        const v = exposureCoverageGaps(series, [{ from: et(24, 9, 40), to: et(24, 15, 50), label: 'P-A' }]);
        expect(v).toEqual([]);
    });

    test('a sampler that slept through the trough and woke after recovery is caught', async () => {
        const { exposureCoverageGaps } = await import('@/utils/equity-series-math.js');
        // Exposure all day; samples only 15:00-16:00 (boot after recovery).
        const series = every5(24, 15, 0, 16, 0);
        const v = exposureCoverageGaps(series, [{ from: et(24, 9, 35), to: et(24, 15, 55), label: 'P-B' }]);
        expect(v.some((x) => x.includes('was unobserved'))).toBe(true);
    });

    test('a mid-day outage over the max gap flags; the exposed window is clipped to the actual entry/exit', async () => {
        const { exposureCoverageGaps } = await import('@/utils/equity-series-math.js');
        // Gap 11:00 → 13:00 while exposed → violation.
        const gappy = [...every5(24, 9, 30, 11, 0), ...every5(24, 13, 0, 16, 0)];
        const v = exposureCoverageGaps(gappy, [{ from: et(24, 10, 0), to: et(24, 15, 0), label: 'P-C' }]);
        expect(v.some((x) => x.includes('sampling gap'))).toBe(true);
        // An afternoon-only exposure owes only the afternoon: morning-less
        // series still covers it.
        const afternoon = every5(24, 14, 0, 16, 0);
        expect(exposureCoverageGaps(afternoon, [{ from: et(24, 14, 10), to: et(24, 15, 45), label: 'P-D' }])).toEqual([]);
    });

    test('weekend days inside a multi-day hold owe nothing; the exposed weekdays owe the EXTENDED session', async () => {
        const { exposureCoverageGaps } = await import('@/utils/equity-series-math.js');
        // Hold Fri 2026-08-21 15:00 → Mon 2026-08-24 10:00. The overnight
        // gap materializes at 04:00 ET Monday — coverage owes Friday
        // 15:05-20:00 and Monday 04:00-10:00, nothing on Sat/Sun.
        const covered = [...every5(21, 15, 0, 20, 0), ...every5(24, 4, 0, 10, 30)];
        expect(exposureCoverageGaps(covered, [{ from: et(21, 15, 5), to: et(24, 10, 0), label: 'P-E' }])).toEqual([]);
        // An RTH-only sampler misses the pre-market gap window → violation
        // (this exact blindness passed the old RTH-scoped coverage).
        const rthOnly = [...every5(21, 15, 0, 16, 0), ...every5(24, 9, 30, 10, 30)];
        const v = exposureCoverageGaps(rthOnly, [{ from: et(21, 15, 5), to: et(24, 10, 0), label: 'P-E' }]);
        expect(v.length).toBeGreaterThan(0);
        expect(v.join(' ')).toContain('unobserved');
    });
});

describe('calendar-aware coverage (review 2026-08-23)', () => {
    const et = (day: number, h: number, m: number) => Date.UTC(2026, 7, day, h + 4, m, 0);
    const s = (ts: number) => ({ ts, netLiq: 11_700 });
    const every5 = (day: number, fromH: number, fromM: number, toH: number, toM: number) => {
        const out = [];
        for (let t = et(day, fromH, fromM); t <= et(day, toH, toM); t += 5 * 60_000) out.push(s(t));
        return out;
    };

    test('a closed holiday owes nothing; a half-day owes only to its early close; unknown days refuse certification', async () => {
        const { exposureCoverageGaps } = await import('@/utils/equity-series-math.js');
        // Tue 2026-08-25 declared a holiday by the stub: a hold spanning it
        // owes Mon tail + Wed open only.
        const sessions = (spec: Record<string, unknown>) => (day: string) =>
            (spec[day] ?? { startMin: 4 * 60, endMin: 20 * 60 }) as never;
        const holidayStub = sessions({ '2026-08-25': 'closed' });
        const covered = [...every5(24, 4, 0, 20, 0), ...every5(26, 4, 0, 10, 30)];
        expect(exposureCoverageGaps(covered, [{ from: et(24, 9, 40), to: et(26, 10, 0), label: 'P-H' }], 20, holidayStub)).toEqual([]);
        // Same series WITHOUT the holiday stub: Tuesday is owed → violation.
        expect(exposureCoverageGaps(covered, [{ from: et(24, 9, 40), to: et(26, 10, 0), label: 'P-H' }], 20).length).toBeGreaterThan(0);
        // Half-day: session ends 17:00 — sampling to 17:00 suffices.
        const halfStub = sessions({ '2026-08-24': { startMin: 4 * 60, endMin: 17 * 60 } });
        const halfCovered = every5(24, 4, 0, 17, 0);
        expect(exposureCoverageGaps(halfCovered, [{ from: et(24, 4, 5), to: et(24, 16, 55), label: 'P-I' }], 20, halfStub)).toEqual([]);
        // Unknown day: certification refused loudly.
        const unknownStub = sessions({ '2026-08-24': 'unknown' });
        const v = exposureCoverageGaps(halfCovered, [{ from: et(24, 9, 40), to: et(24, 15, 0), label: 'P-J' }], 20, unknownStub);
        expect(v.join(' ')).toContain('maintained market calendar');
    });
});
