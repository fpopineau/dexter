import { describe, expect, test } from 'bun:test';
import { scanVolumeFloor, triggerEligibility } from './opportunity-engine.js';

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

describe('trigger staleness refusal (WP10 — stale data fires nothing)', () => {
    const BASE = {
        idx: 0, isReactor: false, onBreadthWatchlist: false,
        threshold: 75, breadthRelief: 10, reactorReliefPts: 10, deepMargin: 5, depth: 10,
    };
    test('a stale candidate is ineligible at ANY rank, reactor or not', () => {
        expect(triggerEligibility({ ...BASE, stale: true }).eligible).toBe(false);
        expect(triggerEligibility({ ...BASE, idx: 0, isReactor: true, stale: true }).eligible).toBe(false);
    });
    test('fresh candidates are unaffected', () => {
        expect(triggerEligibility({ ...BASE, stale: false }).eligible).toBe(true);
    });
});

describe('scanVolumeFloor (scan-coverage slice A — the volume floor is session-aware)', () => {
    const restore: Record<string, string | undefined> = {
        OPP_SCAN_VOLUME_FLOOR: process.env.OPP_SCAN_VOLUME_FLOOR,
        OPP_SCAN_VOLUME_FLOOR_PREMARKET: process.env.OPP_SCAN_VOLUME_FLOOR_PREMARKET,
    };
    const reset = () => {
        for (const [k, v] of Object.entries(restore)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };

    test('pre-open uses the pre-market floor; every regular phase keeps the 500K bar', () => {
        reset();
        delete process.env.OPP_SCAN_VOLUME_FLOOR;
        delete process.env.OPP_SCAN_VOLUME_FLOOR_PREMARKET;
        // The session-blind 500K floor at 07:00 ET starved pre-open scans
        // to mega-liquid names (1 of 21 independent-screener movers seen).
        expect(scanVolumeFloor('pre-open')).toBe(100_000);
        for (const phase of ['open-drive', 'midday', 'pre-close', 'idle'] as const) {
            expect(scanVolumeFloor(phase)).toBe(500_000);
        }
    });

    test('env overrides bind per session, and garbage falls back to defaults', () => {
        try {
            process.env.OPP_SCAN_VOLUME_FLOOR_PREMARKET = '250000';
            process.env.OPP_SCAN_VOLUME_FLOOR = '750000';
            expect(scanVolumeFloor('pre-open')).toBe(250_000);
            expect(scanVolumeFloor('midday')).toBe(750_000);
            process.env.OPP_SCAN_VOLUME_FLOOR_PREMARKET = 'not-a-number';
            expect(scanVolumeFloor('pre-open')).toBe(100_000);
            // Negative floors are nonsense, not zero-is-disabled semantics.
            process.env.OPP_SCAN_VOLUME_FLOOR = '-5';
            expect(scanVolumeFloor('open-drive')).toBe(500_000);
        } finally {
            reset();
        }
    });
});
