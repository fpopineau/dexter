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
