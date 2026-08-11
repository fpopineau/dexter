import { describe, expect, test } from 'bun:test';
import { triggerEligibility } from './opportunity-engine.js';

const BASE = {
    onBreadthWatchlist: false,
    threshold: 75,
    breadthRelief: 10,
    reactorReliefPts: 10,
    deepMargin: 5,
    depth: 10,
};

describe('triggerEligibility (top-3 / deep window / reactor windows)', () => {
    test('top-3 non-reactors trigger at the base threshold (historical window)', () => {
        for (const idx of [0, 1, 2]) {
            expect(triggerEligibility({ ...BASE, idx, isReactor: false }))
                .toEqual({ eligible: true, effectiveThreshold: 75 });
        }
    });

    test('deep window: non-reactors at positions 3..9 must clear threshold + margin — the ABCL/LINC fix', () => {
        // ABCL scored 83 and LINC 84 from rank 4+ under top-3-only: never
        // fired despite beating the 75 bar. At margin 5 (bar 80) both fire.
        const g = triggerEligibility({ ...BASE, idx: 4, isReactor: false });
        expect(g.eligible).toBe(true);
        expect(g.effectiveThreshold).toBe(80);
        expect(83).toBeGreaterThanOrEqual(g.effectiveThreshold); // ABCL
        expect(84).toBeGreaterThanOrEqual(g.effectiveThreshold); // LINC
    });

    test('depth costs conviction: the deep bar is above the top-3 bar', () => {
        const top = triggerEligibility({ ...BASE, idx: 0, isReactor: false });
        const deep = triggerEligibility({ ...BASE, idx: 9, isReactor: false });
        expect(deep.effectiveThreshold).toBeGreaterThan(top.effectiveThreshold);
    });

    test('reactors keep their relief through the whole depth (the TEAM lesson)', () => {
        for (const idx of [0, 5, 9]) {
            expect(triggerEligibility({ ...BASE, idx, isReactor: true }))
                .toEqual({ eligible: true, effectiveThreshold: 65 });
        }
    });

    test('nobody triggers at or beyond the depth', () => {
        expect(triggerEligibility({ ...BASE, idx: 10, isReactor: true }).eligible).toBe(false);
        expect(triggerEligibility({ ...BASE, idx: 10, isReactor: false }).eligible).toBe(false);
    });

    test('breadth relief applies in the top-3 window but NOT in the deep window', () => {
        const top = triggerEligibility({ ...BASE, idx: 1, isReactor: false, onBreadthWatchlist: true });
        expect(top.effectiveThreshold).toBe(65); // 75 − 10 relief
        const deep = triggerEligibility({ ...BASE, idx: 5, isReactor: false, onBreadthWatchlist: true });
        expect(deep.effectiveThreshold).toBe(80); // relieving AND deepening would reopen the noise
    });

    test('reactors take the better of breadth relief and reactor relief', () => {
        const g = triggerEligibility({ ...BASE, idx: 2, isReactor: true, onBreadthWatchlist: true, breadthRelief: 15 });
        expect(g.effectiveThreshold).toBe(60); // min(75−15, 75−10)
    });

    test('a negative margin disables the deep window (the old top-3-only rule)', () => {
        expect(triggerEligibility({ ...BASE, idx: 4, isReactor: false, deepMargin: -1 }).eligible).toBe(false);
        // Top-3 and reactors are unaffected by the disable.
        expect(triggerEligibility({ ...BASE, idx: 2, isReactor: false, deepMargin: -1 }).eligible).toBe(true);
        expect(triggerEligibility({ ...BASE, idx: 6, isReactor: true, deepMargin: -1 }).eligible).toBe(true);
    });

    test('margin 0 = deep window at the base threshold', () => {
        expect(triggerEligibility({ ...BASE, idx: 4, isReactor: false, deepMargin: 0 }))
            .toEqual({ eligible: true, effectiveThreshold: 75 });
    });
});
