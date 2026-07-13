import { describe, expect, test } from 'bun:test';
import { computeRealizedPnl, isIbNumber } from './outcome-tracker.js';

describe('computeRealizedPnl', () => {
    test('long win: (exit − entry) × qty', () => {
        expect(computeRealizedPnl('long', 10, 100, 110)).toBe(100);
    });

    test('long loss', () => {
        expect(computeRealizedPnl('long', 10, 100, 95)).toBe(-50);
    });

    test('short win: (entry − exit) × qty', () => {
        expect(computeRealizedPnl('short', 10, 100, 90)).toBe(100);
    });

    test('short loss', () => {
        expect(computeRealizedPnl('short', 10, 100, 105)).toBe(-50);
    });

    test('rounds to cents', () => {
        expect(computeRealizedPnl('long', 3, 10.111, 10.222)).toBe(0.33);
    });

    test('flat exit is zero', () => {
        expect(computeRealizedPnl('long', 100, 50, 50)).toBe(0);
    });
});

describe('isIbNumber (IBKR unset-sentinel filtering)', () => {
    test('accepts normal numbers', () => {
        expect(isIbNumber(0)).toBe(true);
        expect(isIbNumber(-12.5)).toBe(true);
    });

    test('rejects the IBKR unset sentinel (~1.7977e308)', () => {
        expect(isIbNumber(1.7976931348623157e308)).toBe(false);
    });

    test('rejects undefined, null, NaN and infinities', () => {
        expect(isIbNumber(undefined)).toBe(false);
        expect(isIbNumber(null)).toBe(false);
        expect(isIbNumber(Number.NaN)).toBe(false);
        expect(isIbNumber(Number.POSITIVE_INFINITY)).toBe(false);
    });
});
