import { describe, expect, test } from 'bun:test';
import { continuationLevels } from './proposal-executor.js';

describe('continuationLevels (the SMCI chase-refusal fix, 2026-08-12)', () => {
    test('long: trigger just above the live price, stop distance preserved, fresh 2:1, tick-aligned', () => {
        // The live case: proposed 35.91/35.21/37.31, refused with last 36.75.
        const l = continuationLevels({ direction: 'long', entry: 35.91, stop: 35.21 }, 36.75, 2);
        expect(l).not.toBeNull();
        expect(l!.entry).toBeCloseTo(36.79, 2); // ceil(36.75 × 1.001)
        expect(l!.entry).toBeGreaterThan(36.75); // fills only on continued strength
        expect(l!.stop).toBeCloseTo(36.09, 2); // 0.70 stop distance preserved
        const dist = l!.entry - l!.stop;
        expect(l!.target - l!.entry).toBeGreaterThanOrEqual(2 * dist - 0.011); // 2:1 from ROUNDED distance
        for (const v of [l!.entry, l!.entryLimit, l!.stop, l!.target]) {
            expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6); // tick grid
        }
        expect(l!.entryLimit).toBeGreaterThan(l!.entry);
    });

    test('short: mirrored below the market', () => {
        const l = continuationLevels({ direction: 'short', entry: 40, stop: 41 }, 38.5, 2);
        expect(l).not.toBeNull();
        expect(l!.entry).toBeLessThan(38.5);
        expect(l!.stop).toBeGreaterThan(l!.entry);
        expect(l!.target).toBeLessThan(l!.entry);
        expect(l!.entryLimit).toBeLessThan(l!.entry);
    });

    test('degenerate inputs → null (no entry, zero stop distance, bad price)', () => {
        expect(continuationLevels({ direction: 'long', entry: null, stop: 35 }, 36, 2)).toBeNull();
        expect(continuationLevels({ direction: 'long', entry: 35, stop: 35 }, 36, 2)).toBeNull();
        expect(continuationLevels({ direction: 'long', entry: 35, stop: 34 }, 0, 2)).toBeNull();
    });
});
