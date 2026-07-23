import { describe, expect, test } from 'bun:test';
import { parseCloseSymbols } from './proposal-commands.js';

describe('parseCloseSymbols', () => {
    test('single and multi-symbol forms parse, with separators and dedup', () => {
        expect(parseCloseSymbols('MU')).toEqual(['MU']);
        expect(parseCloseSymbols('MU, NVDA and SMCI')).toEqual(['MU', 'NVDA', 'SMCI']);
        expect(parseCloseSymbols('mu nvda smci')).toEqual(['MU', 'NVDA', 'SMCI']);
        expect(parseCloseSymbols('BRK.B, MU, MU')).toEqual(['BRK.B', 'MU']);
    });

    test('non-ticker phrasing falls through (null) instead of guessing', () => {
        expect(parseCloseSymbols('the positions')).toBeNull();   // 'positions' > 6 chars
        expect(parseCloseSymbols('everything')).toBeNull();
        expect(parseCloseSymbols('')).toBeNull();
        expect(parseCloseSymbols('MU NVDA SMCI TSLA BANC AAPL MSFT AMZN META')).toBeNull(); // > 8 = suspicious
    });
});
