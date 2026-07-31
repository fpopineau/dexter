import { describe, expect, test } from 'bun:test';
import { computeRealizedPnl, isIbNumber, selectManualExitTargets } from './outcome-tracker.js';

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

describe('selectManualExitTargets (guardian-close P&L attribution)', () => {
    const t = (symbol: string, closed: boolean, entryRecorded: boolean, id: string) =>
        ({ symbol, closed, entryRecorded, id });

    test('picks entry-filled, still-open trades on the symbol only', () => {
        const trades = [
            t('NVDA', false, true, 'a'),   // yes
            t('NVDA', false, false, 'b'),  // entry never filled — nothing to close
            t('NVDA', true, true, 'c'),    // already finalized
            t('MU', false, true, 'd'),     // other symbol
        ];
        expect(selectManualExitTargets(trades, 'NVDA').map((x) => x.id)).toEqual(['a']);
    });

    test('a stacked position (two filled proposals) attributes to both', () => {
        const trades = [t('MU', false, true, 'a'), t('MU', false, true, 'b')];
        expect(selectManualExitTargets(trades, ' mu ').length).toBe(2);
    });

    test('no candidates → empty (the close is untracked, P&L stays honest-unknown)', () => {
        expect(selectManualExitTargets([t('MU', false, true, 'a')], 'NVDA')).toEqual([]);
    });
});
