import { describe, expect, test } from 'bun:test';
import { continuationLevels } from './proposal-executor.js';
import { ENTRY_CONFIRM_FRACTION } from './proposal-risk-gate.js';

describe('continuationLevels (the SMCI chase-refusal fix, 2026-08-12)', () => {
    test('long: trigger a QUARTER-STOP above the live price, stop distance preserved, fresh 2:1, tick-aligned', () => {
        // The live case: proposed 35.91/35.21/37.31, refused with last 36.75.
        // Stop distance 0.70 → confirmation quantum max(0.1%, 0.25×0.70) = 0.175.
        const l = continuationLevels({ direction: 'long', entry: 35.91, stop: 35.21 }, 36.75, 2);
        expect(l).not.toBeNull();
        expect(l!.entry).toBeCloseTo(36.93, 2); // ceil(36.75 + 0.175)
        expect(l!.entry - 36.75).toBeGreaterThanOrEqual(ENTRY_CONFIRM_FRACTION * 0.70 - 1e-9);
        // Review 2026-08-21 (round 3): geometry is built FROM THE LIMIT CAP
        // (the worst permitted fill) — the gate judges it there, so a
        // trigger-based 2:1 was ~1.56R at the cap and always refused.
        expect(l!.stop).toBeCloseTo(l!.entryLimit - 0.70, 2); // 0.70 preserved from the cap
        const dist = l!.entryLimit - l!.stop;
        expect(l!.target - l!.entryLimit).toBeGreaterThanOrEqual(2 * dist - 0.011); // 2:1 AT THE CAP
        for (const v of [l!.entry, l!.entryLimit, l!.stop, l!.target]) {
            expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6); // tick grid
        }
        expect(l!.entryLimit).toBeGreaterThan(l!.entry);
    });

    test('the confirmation quantum is NOT microstructure noise: never the old 0.1% when the stop is wider', () => {
        // Old geometry re-entered 4 cents up — "don't chase at 36.75" became
        // "chase at 36.79". A false breakout there costs a full 1R. The
        // trigger must demand movement on the scale of the trade's own noise
        // calibration (the stop distance).
        const l = continuationLevels({ direction: 'long', entry: 35.91, stop: 35.21 }, 36.75, 2);
        expect(l!.entry).toBeGreaterThan(36.79); // strictly beyond the old noise trigger
    });

    test('tight stops fall back to the 0.1% floor', () => {
        // Stop distance 0.04 → 0.25×0.04 = 0.01 < 0.1% of 36.75 (0.037):
        // the floor governs, matching the old behavior for tight geometry.
        const l = continuationLevels({ direction: 'long', entry: 36.71, stop: 36.67 }, 36.75, 2);
        expect(l!.entry).toBeCloseTo(Math.ceil((36.75 + 0.03675) * 100) / 100, 2);
    });

    test('short: mirrored below the market with the same confirmation quantum', () => {
        const l = continuationLevels({ direction: 'short', entry: 40, stop: 41 }, 38.5, 2);
        expect(l).not.toBeNull();
        expect(38.5 - l!.entry).toBeGreaterThanOrEqual(ENTRY_CONFIRM_FRACTION * 1.0 - 0.011);
        expect(l!.stop).toBeGreaterThan(l!.entry);
        expect(l!.target).toBeLessThan(l!.entry);
        expect(l!.entryLimit).toBeLessThan(l!.entry);
    });

    test('degenerate inputs → null (no entry, zero stop distance, bad price, short trigger through zero)', () => {
        expect(continuationLevels({ direction: 'long', entry: null, stop: 35 }, 36, 2)).toBeNull();
        expect(continuationLevels({ direction: 'long', entry: 35, stop: 35 }, 36, 2)).toBeNull();
        expect(continuationLevels({ direction: 'long', entry: 35, stop: 34 }, 0, 2)).toBeNull();
        // A wide short stop on a sub-dollar price would put the trigger ≤ 0.
        expect(continuationLevels({ direction: 'short', entry: 1.0, stop: 3.0 }, 0.4, 2)).toBeNull();
    });
});
