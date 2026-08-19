import { describe, expect, test } from 'bun:test';
import { eventMoverBoost, moverAlertEligible } from './event-mover.js';

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
