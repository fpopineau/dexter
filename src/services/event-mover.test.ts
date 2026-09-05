import { describe, expect, test } from 'bun:test';
import { moverAlertEligible, sentinelDirection, SIGNIFICANCE, significanceSuppressed, significanceTerm } from './event-mover.js';

describe('significanceTerm (REQ-SCAN-004 — ATR-normalised move replaces the raw-percent boost)', () => {
    test('the chipmaker case: +4.1% on a 1.6%-ATR name is ~2.6 ATRs and outranks a +12% 3x ETF at 1.2 ATRs', () => {
        const mu = significanceTerm(4.1, 1.6);   // sig 2.56 → 8 × 2.56 ≈ 20
        const soxl = significanceTerm(12, 10);   // sig 1.2 → 8 × 1.2 ≈ 10
        expect(mu).toBeGreaterThan(soxl);
        expect(mu).toBe(20);
        expect(soxl).toBe(10);
    });

    test('monotone in the ATR multiple, capped, and zero below one ATR', () => {
        expect(significanceTerm(0.9, 1)).toBe(0);                       // under one ATR
        expect(significanceTerm(1.0, 1)).toBe(SIGNIFICANCE.pointsPerAtr);
        expect(significanceTerm(2.0, 1)).toBe(2 * SIGNIFICANCE.pointsPerAtr);
        expect(significanceTerm(110, 5)).toBe(SIGNIFICANCE.cap);         // the MRNA case still saturates
        expect(significanceTerm(3.0, 1)).toBe(24);                       // 8 × 3 — just under the cap
        expect(significanceTerm(3.2, 1)).toBe(SIGNIFICANCE.cap);         // 25.6 → capped
    });

    test('misaligned moves, unmeasured moves and unusable ATRs contribute nothing', () => {
        expect(significanceTerm(-8, 2)).toBe(0);      // moved AGAINST the candidate's direction
        expect(significanceTerm(null, 2)).toBe(0);
        expect(significanceTerm(8, null)).toBe(0);
        expect(significanceTerm(8, 0)).toBe(0);
        expect(significanceTerm(8, -1)).toBe(0);
    });
});

describe('significanceSuppressed (REQ-SCAN-005 — do not promote what the extension gate refuses, except fresh reporters in hour one)', () => {
    test('suppressed once the implied extension exceeds max_extension_atr; not before', () => {
        expect(significanceSuppressed({ impliedExtension: 3.5, maxExtensionAtr: 3, isReactor: false, minutesSinceOpen: 120 })).toBe(true);
        expect(significanceSuppressed({ impliedExtension: 2.9, maxExtensionAtr: 3, isReactor: false, minutesSinceOpen: 120 })).toBe(false);
        expect(significanceSuppressed({ impliedExtension: null, maxExtensionAtr: 3, isReactor: false, minutesSinceOpen: 120 })).toBe(false);
    });

    test('a reactor (fresh print) is EXEMPT during the first 60 minutes of the regular session only', () => {
        expect(significanceSuppressed({ impliedExtension: 3.5, maxExtensionAtr: 3, isReactor: true, minutesSinceOpen: 12 })).toBe(false);
        expect(significanceSuppressed({ impliedExtension: 3.5, maxExtensionAtr: 3, isReactor: true, minutesSinceOpen: 59 })).toBe(false);
        expect(significanceSuppressed({ impliedExtension: 3.5, maxExtensionAtr: 3, isReactor: true, minutesSinceOpen: 60 })).toBe(true);
        expect(significanceSuppressed({ impliedExtension: 3.5, maxExtensionAtr: 3, isReactor: true, minutesSinceOpen: -30 })).toBe(true); // pre-market: no exemption
        expect(significanceSuppressed({ impliedExtension: 3.5, maxExtensionAtr: 3, isReactor: true, minutesSinceOpen: null })).toBe(true);
    });
});

describe('sentinelDirection (watchlist admission lane, 2026-08-19)', () => {
    test('the live case: COIN +10.2% / MSTR +12.1% admit as longs at the 5% bar', () => {
        expect(sentinelDirection(10.2, 5)).toBe('long');
        expect(sentinelDirection(12.1, 5)).toBe('long');
    });

    test('drops admit as shorts; small moves and missing data admit nothing', () => {
        expect(sentinelDirection(-7.4, 5)).toBe('short');
        expect(sentinelDirection(4.9, 5)).toBeNull();
        expect(sentinelDirection(-4.9, 5)).toBeNull();
        expect(sentinelDirection(null, 5)).toBeNull();
    });
});

describe('moverAlertEligible (deterministic pre-market channel)', () => {
    const base = { dayMovePct: 41, rvol: 8, phase: 'pre-open', alreadyAlerted: false, minPct: 15, minRvol: 2 };

    test('an aligned pre-market mover with volume alerts once', () => {
        expect(moverAlertEligible(base)).toBe(true);
        expect(moverAlertEligible({ ...base, alreadyAlerted: true })).toBe(false);
    });

    test('after the open the trigger pipeline is the channel — no mover alerts', () => {
        expect(moverAlertEligible({ ...base, phase: 'open-drive' })).toBe(false);
        expect(moverAlertEligible({ ...base, phase: 'midday' })).toBe(false);
    });

    test('small moves and thin tapes stay quiet; unknown RVOL fails open (scanner volume floor backstops)', () => {
        expect(moverAlertEligible({ ...base, dayMovePct: 12 })).toBe(false);
        expect(moverAlertEligible({ ...base, rvol: 0.5 })).toBe(false);
        expect(moverAlertEligible({ ...base, rvol: null })).toBe(true);
        expect(moverAlertEligible({ ...base, dayMovePct: null })).toBe(false);
    });
});
