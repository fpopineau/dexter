import { describe, expect, test } from 'bun:test';
import { convertBaseToUsd } from './fx.js';

// WP8: the direction test — EUR base at a rate above parity must GROW the
// USD figure (multiply). The audit's finding was "conservative today, and
// silently inverts below parity": divide would have been the bug class,
// under-sizing above parity and over-sizing below it.
describe('convertBaseToUsd (WP8 — one currency at the boundary)', () => {
    test('EUR above parity grows the USD figure', () => {
        expect(convertBaseToUsd(3_700, 1.08)).toBeCloseTo(3_996, 2);
        expect(convertBaseToUsd(3_700, 1.08)).toBeGreaterThan(3_700);
    });

    test('below parity shrinks it — no silent inversion', () => {
        expect(convertBaseToUsd(3_700, 0.9)).toBeCloseTo(3_330, 2);
        expect(convertBaseToUsd(3_700, 0.9)).toBeLessThan(3_700);
    });

    test('USD identity', () => {
        expect(convertBaseToUsd(1_234.56, 1)).toBe(1_234.56);
    });
});
