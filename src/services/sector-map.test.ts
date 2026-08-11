import { describe, expect, test } from 'bun:test';
import { parseNasdaqSummary } from './sector-map.js';

// Shape captured live from api.nasdaq.com/api/quote/MU/summary (2026-08-11).
const MU_SUMMARY = {
    data: {
        summaryData: {
            Exchange: { label: 'Exchange', value: 'NASDAQ-GS' },
            Sector: { label: 'Sector', value: 'Technology' },
            Industry: { label: 'Industry', value: 'Semiconductors' },
            MarketCap: { label: 'Market Cap', value: '141,563,412,240' },
        },
    },
};

describe('parseNasdaqSummary', () => {
    test('extracts sector and industry from the live shape', () => {
        expect(parseNasdaqSummary(MU_SUMMARY)).toEqual({ sector: 'Technology', industry: 'Semiconductors' });
    });

    test('ETFs and index products (no Sector field) → null, not a guess', () => {
        expect(parseNasdaqSummary({ data: { summaryData: { Exchange: { value: 'NASDAQ' } } } })).toBeNull();
        expect(parseNasdaqSummary({ data: { summaryData: { Sector: { value: '' } } } })).toBeNull();
    });

    test('unknown shapes never throw', () => {
        expect(parseNasdaqSummary(null)).toBeNull();
        expect(parseNasdaqSummary({})).toBeNull();
        expect(parseNasdaqSummary({ data: { summaryData: 'nope' } })).toBeNull();
    });

    test('missing industry degrades to null while the sector stands', () => {
        expect(parseNasdaqSummary({ data: { summaryData: { Sector: { value: 'Energy' } } } }))
            .toEqual({ sector: 'Energy', industry: null });
    });
});
