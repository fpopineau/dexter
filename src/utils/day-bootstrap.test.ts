import { describe, expect, test } from 'bun:test';
import { dayBlockBootstrapLcb, mulberry32 } from './day-bootstrap.js';

describe('day-block bootstrap (REQ-VAL-003)', () => {
    test('deterministic: same seed, same bound', () => {
        const days = new Map([
            ['d1', [10, -5]], ['d2', [3]], ['d3', [-2, 8]], ['d4', [1, 1]], ['d5', [-4, 6]],
        ]);
        const a = dayBlockBootstrapLcb(days)!;
        const b = dayBlockBootstrapLcb(days)!;
        expect(a.lcb).toBe(b.lcb);
        expect(a.days).toBe(5);
        expect(a.replicates).toBe(1000);
    });

    test('uniformly positive days give a positive LCB; a fat losing day drags it negative', () => {
        const good = new Map([
            ['d1', [5, 8]], ['d2', [3, 2]], ['d3', [6]], ['d4', [4, 1]], ['d5', [7, 2]],
        ]);
        expect(dayBlockBootstrapLcb(good)!.lcb).toBeGreaterThan(0);
        // Positive SAMPLE mean carried by one day — the exact pattern the
        // bound exists to catch: replicates that miss d1 go deeply negative.
        const fragile = new Map([
            ['d1', [100]], ['d2', [-8, -6]], ['d3', [-5]], ['d4', [-7, -4]], ['d5', [-6]],
        ]);
        const total = [...fragile.values()].flat();
        expect(total.reduce((s, v) => s + v, 0)).toBeGreaterThan(0); // sample mean positive…
        expect(dayBlockBootstrapLcb(fragile)!.lcb).toBeLessThan(0);  // …the bound is not fooled
    });

    test('fewer than minDays distinct days is not evaluable', () => {
        const two = new Map([['d1', [5]], ['d2', [3]]]);
        expect(dayBlockBootstrapLcb(two)).toBeNull();
        expect(dayBlockBootstrapLcb(two, { minDays: 2 })).not.toBeNull();
    });

    test('mulberry32 emits a stable [0,1) stream', () => {
        const r = mulberry32(42);
        const seq = [r(), r(), r()];
        const r2 = mulberry32(42);
        expect([r2(), r2(), r2()]).toEqual(seq);
        for (const v of seq) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
    });
});
