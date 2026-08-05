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

    test('zero or fractional quantity is refused on the whole-share (paper) profile', () => {
        expect(() => validateBracketRequest(longLmt({ quantity: 0 }))).toThrow(/whole number/);
        expect(() => validateBracketRequest(longLmt({ quantity: 1.5 }))).toThrow(/fraction/);
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

    test('valid long STP_LMT (momentum) bracket passes', () => {
        expect(() => validateBracketRequest(longLmt({
            entryType: 'STP_LMT', entryPrice: 102.2, entryLimitPrice: 102.8, stopPrice: 99.4, targetPrice: 106.8,
        }))).not.toThrow();
    });

    test('STP_LMT without a limit cap is refused', () => {
        expect(() => validateBracketRequest(longLmt({ entryType: 'STP_LMT', entryPrice: 102.2, entryLimitPrice: undefined })))
            .toThrow(/require entryPrice \(trigger\) and entryLimitPrice/);
    });

    test('long STP_LMT with cap below trigger is refused', () => {
        expect(() => validateBracketRequest(longLmt({ entryType: 'STP_LMT', entryPrice: 102.2, entryLimitPrice: 101.5 })))
            .toThrow(/at or above the trigger/);
    });

    test('non-positive stop or target is refused', () => {
        expect(() => validateBracketRequest(longLmt({ stopPrice: 0 }))).toThrow(/must be positive/);
        expect(() => validateBracketRequest(longLmt({ targetPrice: -5 }))).toThrow(/must be positive/);
    });
});

describe('fractional bracket quantities (profile-driven)', () => {
    test('decimal quantity valid on the live profile, refused on paper', async () => {
        const { setAccountProfile } = await import('./risk-rules.js');
        const req = {
            parentOrderId: 1, takeProfitOrderId: 2, stopOrderId: 3, ocaGroup: 'g',
            symbol: 'MSFT', direction: 'long' as const, quantity: 1.48,
            entryType: 'LMT' as const, entryPrice: 500, stopPrice: 490, targetPrice: 520,
        };
        try {
            setAccountProfile('live'); // risk-rules.live.yaml → fractional_shares: true
            expect(() => validateBracketRequest(req)).not.toThrow();
            setAccountProfile('paper');
            expect(() => validateBracketRequest(req)).toThrow(/fraction/);
            expect(() => validateBracketRequest({ ...req, quantity: 2 })).not.toThrow();
        } finally {
            setAccountProfile('paper');
        }
    });
});
