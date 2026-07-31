import { describe, expect, test } from 'bun:test';
import { decideReportedRecently, etDatePlus, parseNasdaqEarnings, previousTradingDate, type EarningsEntry } from './earnings-calendar.js';

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

describe('previousTradingDate', () => {
    // 2026-07-31 12:00 UTC is a Friday; ET is Thursday..Friday — pin exact
    // instants to avoid TZ ambiguity in assertions.
    test('a Tuesday looks back to Monday', () => {
        // 2026-07-28 15:00 UTC = Tuesday 11:00 ET
        expect(previousTradingDate(new Date('2026-07-28T15:00:00Z'))).toBe('2026-07-27');
    });

    test('a Monday looks back over the weekend to Friday', () => {
        // 2026-07-27 15:00 UTC = Monday 11:00 ET
        expect(previousTradingDate(new Date('2026-07-27T15:00:00Z'))).toBe('2026-07-24');
    });
});

describe('decideReportedRecently (extension-guard earnings-gap exception)', () => {
    const entry = (symbol: string, time: string): EarningsEntry =>
        ({ symbol, name: symbol, time, epsForecast: null, marketCap: null });

    test('yesterday after-hours report → true (the MSFT Jul 30 shape)', () => {
        expect(decideReportedRecently({
            symbol: 'MSFT',
            todayEntries: [],
            prevEntries: [entry('MSFT', 'after-hours')],
        })).toBe(true);
    });

    test('today pre-market report → true', () => {
        expect(decideReportedRecently({
            symbol: 'MU',
            todayEntries: [entry('MU', 'pre-market')],
            prevEntries: [],
        })).toBe(true);
    });

    test("today AFTER-HOURS report does NOT count — it hasn't happened yet during RTH", () => {
        expect(decideReportedRecently({
            symbol: 'NVDA',
            todayEntries: [entry('NVDA', 'after-hours')],
            prevEntries: [],
        })).toBe(false);
    });

    test("yesterday PRE-MARKET report does not count — that gap was yesterday's", () => {
        expect(decideReportedRecently({
            symbol: 'ORCL',
            todayEntries: [],
            prevEntries: [entry('ORCL', 'pre-market')],
        })).toBe(false);
    });

    test('unknown timing counts on both sides (Nasdaq omits the slot often)', () => {
        expect(decideReportedRecently({
            symbol: 'ABC', todayEntries: [entry('ABC', 'unknown')], prevEntries: [],
        })).toBe(true);
        expect(decideReportedRecently({
            symbol: 'ABC', todayEntries: [], prevEntries: [entry('ABC', 'unknown')],
        })).toBe(true);
    });

    test('unavailable data → null (guard stays strict), unless the other day already says true', () => {
        expect(decideReportedRecently({ symbol: 'X', todayEntries: null, prevEntries: [] })).toBe(null);
        expect(decideReportedRecently({ symbol: 'X', todayEntries: [], prevEntries: null })).toBe(null);
        expect(decideReportedRecently({
            symbol: 'X', todayEntries: [entry('X', 'pre-market')], prevEntries: null,
        })).toBe(true);
    });

    test('not on either calendar with both days available → false', () => {
        expect(decideReportedRecently({
            symbol: 'AEHR',
            todayEntries: [entry('MSFT', 'pre-market')],
            prevEntries: [entry('MU', 'after-hours')],
        })).toBe(false);
    });

    test('symbol matching is case/whitespace-insensitive', () => {
        expect(decideReportedRecently({
            symbol: ' msft ', todayEntries: [entry('MSFT', 'pre-market')], prevEntries: [],
        })).toBe(true);
    });
});
