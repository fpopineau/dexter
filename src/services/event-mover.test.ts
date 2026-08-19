import { describe, expect, test } from 'bun:test';
import { eventMoverBoost, moverAlertEligible, sentinelDirection } from './event-mover.js';

describe('eventMoverBoost (MRNA 2026-08-19: +110% ranked below index ETFs)', () => {
    test('the MRNA case: a huge aligned move gets the full +25 — top-3 becomes unavoidable', () => {
        expect(eventMoverBoost(93.4, 10)).toBe(25);
    });

    test('boost is the move itself between the floor and the cap', () => {
        expect(eventMoverBoost(10, 10)).toBe(10);
        expect(eventMoverBoost(17.4, 10)).toBe(17);
        expect(eventMoverBoost(25, 10)).toBe(25);
    });

    test('ordinary moves, misaligned moves, and unmeasured candidates get nothing', () => {
        expect(eventMoverBoost(9.9, 10)).toBe(0);
        expect(eventMoverBoost(-40, 10)).toBe(0); // moved AGAINST the candidate's direction
        expect(eventMoverBoost(null, 10)).toBe(0);
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
