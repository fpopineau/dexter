import { describe, expect, test } from 'bun:test';
import { validateBracketRequest, type BracketRequest } from './bracket.js';

function longLmt(overrides: Partial<BracketRequest> = {}): BracketRequest {
    return {
        symbol: 'AAPL',
        direction: 'long',
        quantity: 10,
        entryType: 'LMT',
        entryPrice: 100,
        stopPrice: 95,
        targetPrice: 110,
        ...overrides,
    };
}

describe('bracket request validation', () => {
    test('valid long LMT bracket passes', () => {
        expect(() => validateBracketRequest(longLmt())).not.toThrow();
    });

    test('valid short LMT bracket passes', () => {
        expect(() =>
            validateBracketRequest(longLmt({ direction: 'short', stopPrice: 105, targetPrice: 90 })),
        ).not.toThrow();
    });

    test('valid long MKT bracket passes (stop below target)', () => {
        expect(() =>
            validateBracketRequest(longLmt({ entryType: 'MKT', entryPrice: undefined })),
        ).not.toThrow();
    });

    test('zero or fractional quantity is refused', () => {
        expect(() => validateBracketRequest(longLmt({ quantity: 0 }))).toThrow(/positive integer/);
        expect(() => validateBracketRequest(longLmt({ quantity: 1.5 }))).toThrow(/positive integer/);
    });

    test('LMT without entryPrice is refused', () => {
        expect(() => validateBracketRequest(longLmt({ entryPrice: undefined }))).toThrow(/entryPrice is required/);
    });

    test('long with stop above entry is refused', () => {
        expect(() => validateBracketRequest(longLmt({ stopPrice: 101 }))).toThrow(/stopPrice must be below entry/);
    });

    test('long with target below entry is refused', () => {
        expect(() => validateBracketRequest(longLmt({ targetPrice: 99 }))).toThrow(/targetPrice must be above entry/);
    });

    test('short LMT with stop below entry is refused', () => {
        expect(() =>
            validateBracketRequest(longLmt({ direction: 'short', stopPrice: 95, targetPrice: 90 })),
        ).toThrow(/stopPrice must be above entry/);
    });

    test('short MKT with target above stop is refused', () => {
        expect(() =>
            validateBracketRequest(
                longLmt({ direction: 'short', entryType: 'MKT', entryPrice: undefined, stopPrice: 100, targetPrice: 110 }),
            ),
        ).toThrow(/targetPrice must be below stopPrice/);
    });

    test('non-positive stop or target is refused', () => {
        expect(() => validateBracketRequest(longLmt({ stopPrice: 0 }))).toThrow(/must be positive/);
        expect(() => validateBracketRequest(longLmt({ targetPrice: -5 }))).toThrow(/must be positive/);
    });
});
