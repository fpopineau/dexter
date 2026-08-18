import { describe, expect, test } from 'bun:test';
import { assessStopExitFill, barTimeFrameMs, computeRealizedPnl, computeTradeExcursion, decideDayExpiryHold, etFrameMs, isIbNumber, selectManualExitTargets, SUSPECT_FILL_STOP_MULT } from './outcome-tracker.js';

describe('assessStopExitFill (SECZ phantom-fill lesson, 2026-08-13)', () => {
    test('the live case: 6.43 buy-stop filled at 11.918 while the tape traded 5.78 → SUSPECT at ~15.8R through', () => {
        const r = assessStopExitFill('short', 6.083161, 6.43, 11.918442);
        expect(r.suspect).toBe(true);
        expect(r.beyondStopR).toBeCloseTo(15.8, 1);
    });

    test('ordinary stop slippage is not suspect', () => {
        // Long from 10, stop 9.50, filled 9.46 — 8% of the stop distance through.
        const r = assessStopExitFill('long', 10, 9.5, 9.46);
        expect(r.suspect).toBe(false);
        expect(r.beyondStopR).toBeCloseTo(0.1, 1);
    });

    test('price-improved fills (better than the level) are negative and never suspect', () => {
        const r = assessStopExitFill('long', 10, 9.5, 9.55);
        expect(r.suspect).toBe(false);
        expect(r.beyondStopR).toBeLessThan(0);
    });

    test('an honest overnight gap 3R+ through the stop IS flagged — that is review-worthy, not a false positive', () => {
        // Long from 10, stop 9.80 (0.20 dist), gaps to open 9.00: 4R through.
        const r = assessStopExitFill('long', 10, 9.8, 9.0);
        expect(r.suspect).toBe(true);
        expect(r.beyondStopR).toBeCloseTo(4, 1);
        expect(r.beyondStopR).toBeGreaterThan(SUSPECT_FILL_STOP_MULT);
    });

    test('degenerate geometry (zero stop distance, junk fill) never flags', () => {
        expect(assessStopExitFill('long', 10, 10, 5).suspect).toBe(false);
        expect(assessStopExitFill('short', 6, 6.4, 0).suspect).toBe(false);
    });
});

describe('computeTradeExcursion (held-trade MFE/MAE — max_target_atr tuning data)', () => {
    const bars = [
        { high: 103, low: 99 },
        { high: 105, low: 98.5 },
        { high: 101, low: 96 },
    ];

    test('long: MFE = best high above fill, MAE = worst low below, both % of fill', () => {
        const r = computeTradeExcursion('long', 100, bars);
        expect(r.mfePct).toBe(5);  // high 105
        expect(r.maePct).toBe(4);  // low 96
    });

    test('short mirrors: lows are favorable, highs adverse', () => {
        const r = computeTradeExcursion('short', 100, bars);
        expect(r.mfePct).toBe(4);
        expect(r.maePct).toBe(5);
    });

    test('a trade that never went favorable has MFE 0, never negative', () => {
        const r = computeTradeExcursion('long', 100, [{ high: 99.5, low: 97 }]);
        expect(r.mfePct).toBe(0);
        expect(r.maePct).toBe(3);
    });

    test('junk bars are skipped; no usable bars → honest nulls', () => {
        expect(computeTradeExcursion('long', 100, [{ high: undefined, low: 97 }, {}]))
            .toEqual({ mfePct: null, maePct: null });
        expect(computeTradeExcursion('long', 100, [])).toEqual({ mfePct: null, maePct: null });
        expect(computeTradeExcursion('long', 0, bars)).toEqual({ mfePct: null, maePct: null });
    });

    test('percentages round to 2 decimals', () => {
        const r = computeTradeExcursion('long', 3, [{ high: 3.01, low: 2.99 }]);
        expect(r.mfePct).toBe(0.33);
        expect(r.maePct).toBe(0.33);
    });
});

describe('bar/epoch time frame helpers (hold-window slicing)', () => {
    test('intraday bar times parse into the ET-components frame (double space tolerated)', () => {
        const expected = Date.UTC(2026, 7, 5, 7, 40, 0);
        expect(barTimeFrameMs('20260805 07:40:00')).toBe(expected);
        expect(barTimeFrameMs('20260805  07:40:00')).toBe(expected);
    });

    test('daily bars (date only) and garbage → null', () => {
        expect(barTimeFrameMs('20260805')).toBe(null);
        expect(barTimeFrameMs('finished-20260805')).toBe(null);
        expect(barTimeFrameMs(undefined)).toBe(null);
    });

    test('an epoch timestamp lands on the same frame value as its ET bar time', () => {
        // 2026-08-05 11:40 UTC = 07:40 ET (EDT) — the exact equivalence the
        // hold-window filter relies on, independent of the host timezone.
        const epoch = Date.UTC(2026, 7, 5, 11, 40, 0);
        expect(barTimeFrameMs('20260805 07:40:00')).toBe(etFrameMs(epoch));
    });
});

describe('decideDayExpiryHold (EOD-keep transition trigger)', () => {
    const base = {
        reason: 'manual' as const,
        entryFilled: true,
        exitFillKnown: false,
        tif: 'DAY' as const,
        afterBell: true,
    };

    test('DAY bracket, entry filled, no exit fill, at/after the bell → keep the proposal alive', () => {
        expect(decideDayExpiryHold(base)).toBe(true);
    });

    test('a known exit fill means a deliberate close that landed near the bell — not an expiry', () => {
        expect(decideDayExpiryHold({ ...base, exitFillKnown: true })).toBe(false);
    });

    test('GTC brackets never expire at the bell', () => {
        expect(decideDayExpiryHold({ ...base, tif: 'GTC' })).toBe(false);
        expect(decideDayExpiryHold({ ...base, tif: null })).toBe(false);
    });

    test('before the bell it is a mystery manual close, not an expiry', () => {
        expect(decideDayExpiryHold({ ...base, afterBell: false })).toBe(false);
    });

    test('unfilled entries and non-manual reasons never hold', () => {
        expect(decideDayExpiryHold({ ...base, entryFilled: false })).toBe(false);
        expect(decideDayExpiryHold({ ...base, reason: 'stop' })).toBe(false);
        expect(decideDayExpiryHold({ ...base, reason: 'cancelled' })).toBe(false);
    });
});

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
