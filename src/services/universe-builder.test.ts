import { describe, expect, test } from 'bun:test';
import {
    computeCaps,
    getUniverse,
    isPlainCommonStock,
    parseCikMap,
    parseNasdaqListed,
    parseOtherListed,
    parseSharesConcept,
    type UniverseStore,
} from './universe-builder.js';

describe('listing directory parsers', () => {
    const NASDAQ_FIXTURE = [
        'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
        'AAAP|Pacer Barings CLO Market Flex ETF|G|N|N|100|Y|N',
        'AACB|Artius II Acquisition Inc. - Class A Ordinary Shares|G|N|D|100|N|N',
        'NVDA|NVIDIA Corporation - Common Stock|Q|N|N|100|N|N',
        'ZAZZT|Test Issue Co|G|Y|N|100|N|N',
        'ACABW|Acme Acquisition Corp - Warrant|G|N|N|100|N|N',
        'File Creation Time: 0707202522:30|||||||',
    ].join('\n');

    const OTHER_FIXTURE = [
        'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
        'A|Agilent Technologies, Inc. Common Stock|N|A|N|100|N|A',
        'SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY',
        'BC.PRA|Brunswick Corp Preferred|N|BCpA|N|100|N|BC-A',
        'GME|GameStop Corporation Common Stock|N|GME|N|100|N|GME',
    ].join('\n');

    test('nasdaqlisted: keeps common stock, drops ETFs, test issues, warrants', () => {
        const rows = parseNasdaqListed(NASDAQ_FIXTURE);
        const symbols = rows.map((r) => r.symbol);
        expect(symbols).toContain('NVDA');
        expect(symbols).toContain('AACB');
        expect(symbols).not.toContain('AAAP');   // ETF flag
        expect(symbols).not.toContain('ZAZZT');  // test issue
        expect(symbols).not.toContain('ACABW');  // warrant by name
        expect(rows.find((r) => r.symbol === 'NVDA')?.exchange).toBe('NASDAQ');
    });

    test('otherlisted: keeps common stock, drops ETFs and dotted symbols', () => {
        const rows = parseOtherListed(OTHER_FIXTURE);
        const symbols = rows.map((r) => r.symbol);
        expect(symbols).toEqual(['A', 'GME']);
        expect(rows[0].exchange).toBe('N');
    });

    test('isPlainCommonStock symbol shape rules', () => {
        expect(isPlainCommonStock('AAPL', 'Apple Inc. Common Stock')).toBe(true);
        expect(isPlainCommonStock('BRK.A', 'Berkshire')).toBe(false);
        expect(isPlainCommonStock('TOOLONG', 'X')).toBe(false);
        expect(isPlainCommonStock('ABC', 'Something Depositary Shares')).toBe(false);
        expect(isPlainCommonStock('ABC', 'Acme 8% Notes due 2031')).toBe(false);
    });
});

describe('EDGAR parsers', () => {
    test('parseCikMap extracts ticker→CIK', () => {
        const map = parseCikMap({
            '0': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
            '1': { cik_str: 320193, ticker: 'aapl', title: 'Apple Inc.' },
        });
        expect(map.get('NVDA')).toBe(1045810);
        expect(map.get('AAPL')).toBe(320193);
    });

    test('parseSharesConcept picks the most recent report', () => {
        const parsed = parseSharesConcept({
            units: {
                shares: [
                    { end: '2025-10-17', val: 15_100_000_000 },
                    { end: '2026-01-16', val: 15_037_000_000 },
                    { end: '2024-01-01', val: 0 }, // invalid, ignored
                ],
            },
        });
        expect(parsed).toEqual({ shares: 15_037_000_000, asOf: '2026-01-16' });
    });

    test('parseSharesConcept returns null on missing concept', () => {
        expect(parseSharesConcept({})).toBeNull();
        expect(parseSharesConcept({ units: { shares: [] } })).toBeNull();
    });
});

describe('cap computation and band filter', () => {
    function store(): UniverseStore {
        return {
            directoryAt: 0,
            updatedAt: 0,
            entries: {
                BIG: { symbol: 'BIG', name: 'Big Corp', exchange: 'N', shares: 1e9, lastClose: 100 },      // 100B
                MID: { symbol: 'MID', name: 'Mid Corp', exchange: 'N', shares: 50e6, lastClose: 60 },      // 3B
                MIDLO: { symbol: 'MIDLO', name: 'Mid Low', exchange: 'Q', shares: 100e6, lastClose: 12 },  // 1.2B
                SMALL: { symbol: 'SMALL', name: 'Small Co', exchange: 'A', shares: 20e6, lastClose: 10 },  // 200M
                NOCAP: { symbol: 'NOCAP', name: 'No Data', exchange: 'N' },
            },
        };
    }

    test('computeCaps multiplies shares × close', () => {
        const s = store();
        expect(computeCaps(s)).toBe(4);
        expect(s.entries.MID.capUsd).toBe(3_000_000_000);
        expect(s.entries.NOCAP.capUsd).toBeUndefined();
    });

    test('getUniverse filters the 1–5B band, largest first', () => {
        const s = store();
        computeCaps(s);
        const band = getUniverse(s, { minCapUsd: 1e9, maxCapUsd: 5e9 });
        expect(band.map((e) => e.symbol)).toEqual(['MID', 'MIDLO']);
    });

    test('includeUnknown pulls in unprobed entries', () => {
        const s = store();
        computeCaps(s);
        const withUnknown = getUniverse(s, { minCapUsd: 1e9, maxCapUsd: 5e9, includeUnknown: true });
        expect(withUnknown.map((e) => e.symbol)).toContain('NOCAP');
    });
});
