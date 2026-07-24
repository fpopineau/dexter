import { describe, expect, test } from 'bun:test';
import { etDatePlus, parseNasdaqEarnings } from './earnings-calendar.js';

const NASDAQ_FIXTURE = {
    data: {
        asOf: 'Mon, Jul 27, 2026',
        rows: [
            { symbol: 'AZN', name: 'AstraZeneca PLC', time: 'time-pre-market', epsForecast: '$2.50', marketCap: '$263,458,548,902', noOfEsts: '2' },
            { symbol: 'WELL', name: 'Welltower Inc.', time: 'time-after-hours', epsForecast: '$1.28', marketCap: '$174,396,164,873' },
            { symbol: 'XYZQ', name: 'No Time Corp', time: 'time-not-supplied', epsForecast: '', marketCap: '' },
            { name: 'Broken row without symbol', time: 'time-pre-market' },
        ],
    },
};

describe('parseNasdaqEarnings', () => {
    test('maps rows, normalizes timing, drops broken entries', () => {
        const entries = parseNasdaqEarnings(NASDAQ_FIXTURE);
        expect(entries.length).toBe(3);
        expect(entries[0]).toEqual({
            symbol: 'AZN', name: 'AstraZeneca PLC', time: 'pre-market',
            epsForecast: '$2.50', marketCap: '$263,458,548,902',
        });
        expect(entries[1].time).toBe('after-hours');
        expect(entries[2].time).toBe('unknown');
        expect(entries[2].epsForecast).toBeNull();
    });

    test('unknown shapes never throw', () => {
        expect(parseNasdaqEarnings(null)).toEqual([]);
        expect(parseNasdaqEarnings({})).toEqual([]);
        expect(parseNasdaqEarnings({ data: { rows: 'nope' } })).toEqual([]);
    });
});

describe('etDatePlus', () => {
    test('formats ET dates and adds days across month boundaries', () => {
        // 2026-07-31 23:00 UTC = 19:00 ET Jul 31
        const d = new Date('2026-07-31T23:00:00Z');
        expect(etDatePlus(0, d)).toBe('2026-07-31');
        expect(etDatePlus(1, d)).toBe('2026-08-01');
    });

    test('UTC date ahead of ET date resolves to the ET side', () => {
        // 2026-07-25 01:00 UTC = Jul 24 21:00 ET
        const d = new Date('2026-07-25T01:00:00Z');
        expect(etDatePlus(0, d)).toBe('2026-07-24');
    });
});
