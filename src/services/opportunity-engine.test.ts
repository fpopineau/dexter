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

describe('trigger defaults (REQ-TRIG-001 — live-loop WP1: bar 60, cap 30)', () => {
    const saved = { score: process.env.OPP_TRIGGER_SCORE, cap: process.env.OPP_TRIGGER_MAX_PER_DAY };
    const restore = () => {
        if (saved.score === undefined) delete process.env.OPP_TRIGGER_SCORE; else process.env.OPP_TRIGGER_SCORE = saved.score;
        if (saved.cap === undefined) delete process.env.OPP_TRIGGER_MAX_PER_DAY; else process.env.OPP_TRIGGER_MAX_PER_DAY = saved.cap;
    };

    test('unset env → bar 60 and 30 triggers/day (the 55-66 mover class reaches evaluation)', async () => {
        const { triggerScore, triggerMaxPerDay } = await import('./opportunity-engine.js');
        delete process.env.OPP_TRIGGER_SCORE;
        delete process.env.OPP_TRIGGER_MAX_PER_DAY;
        try {
            expect(triggerScore()).toBe(60);
            expect(triggerMaxPerDay()).toBe(30);
        } finally { restore(); }
    });

    test('env overrides still bind; garbage falls back to the new defaults', async () => {
        const { triggerScore, triggerMaxPerDay } = await import('./opportunity-engine.js');
        try {
            process.env.OPP_TRIGGER_SCORE = '75';
            process.env.OPP_TRIGGER_MAX_PER_DAY = '10';
            expect(triggerScore()).toBe(75);
            expect(triggerMaxPerDay()).toBe(10);
            process.env.OPP_TRIGGER_SCORE = 'high';
            process.env.OPP_TRIGGER_MAX_PER_DAY = '-3';
            expect(triggerScore()).toBe(60);
            expect(triggerMaxPerDay()).toBe(30);
        } finally { restore(); }
    });
});

describe('large-cap lane helpers (REQ-SCAN-006)', () => {
    test('largeCapScansFor keeps only the directional gainer/loser scans of a plan', async () => {
        const { largeCapScansFor } = await import('./opportunity-engine.js');
        const scans = [
            { code: 'TOP_PERC_GAIN', direction: 'long' as const },
            { code: 'HOT_BY_VOLUME', direction: 'none' as const },
            { code: 'TOP_PERC_LOSE', direction: 'short' as const },
        ];
        expect(largeCapScansFor(scans as never)).toEqual([scans[0], scans[2]] as never);
    });

    test('scanFamilyOf strips the LARGECAP: prefix so a large-cap sighting corroborates nothing by itself', async () => {
        const { scanFamilyOf } = await import('./opportunity-engine.js');
        expect(scanFamilyOf('TOP_PERC_GAIN')).toBe('gainer');
        expect(scanFamilyOf('LARGECAP:TOP_PERC_GAIN')).toBe('gainer');
        expect(scanFamilyOf('LARGECAP:TOP_PERC_LOSE')).toBe('loser');
        expect(scanFamilyOf('WATCHLIST_SENTINEL')).toBe('WATCHLIST_SENTINEL');
        expect(scanFamilyOf('COMPLEX:SOXL')).toBe('COMPLEX:SOXL');
    });

    test('selectReservedAdmissions: unadmitted rows carrying the tag, best scan rank first, bounded by max', async () => {
        const { selectReservedAdmissions } = await import('./opportunity-engine.js');
        const rows = [
            { symbol: 'MU', sources: ['LARGECAP:TOP_PERC_GAIN'], rank: 7 },
            { symbol: 'NVDA', sources: ['TOP_PERC_GAIN', 'LARGECAP:TOP_PERC_GAIN'], rank: 1 },
            { symbol: 'ASML', sources: ['LARGECAP:TOP_PERC_GAIN'], rank: 3 },
            { symbol: 'ARM', sources: ['LARGECAP:TOP_PERC_GAIN'], rank: 12 },
            { symbol: 'XYZ', sources: ['TOP_PERC_GAIN'], rank: 2 },
        ];
        const picked = selectReservedAdmissions(rows, new Set(['NVDA']), 'LARGECAP:', 2).map((r) => r.symbol);
        expect(picked).toEqual(['ASML', 'MU']);
        expect(selectReservedAdmissions(rows, new Set(['NVDA', 'MU', 'ASML', 'ARM']), 'LARGECAP:', 5)).toEqual([]);
    });

    test('large-cap lane knobs: on by default, $10B floor, reserve 5; env overrides; garbage falls back', async () => {
        const { largeCapLaneEnabled, largeCapMinUsd, largeCapReserve } = await import('./opportunity-engine.js');
        const saved = { a: process.env.OPP_LARGECAP_LANE, b: process.env.OPP_LARGECAP_MIN_USD, c: process.env.OPP_LARGECAP_RESERVE };
        try {
            delete process.env.OPP_LARGECAP_LANE; delete process.env.OPP_LARGECAP_MIN_USD; delete process.env.OPP_LARGECAP_RESERVE;
            expect(largeCapLaneEnabled()).toBe(true);
            expect(largeCapMinUsd()).toBe(10e9);
            expect(largeCapReserve()).toBe(5);
            process.env.OPP_LARGECAP_LANE = 'false'; process.env.OPP_LARGECAP_MIN_USD = '5000000000'; process.env.OPP_LARGECAP_RESERVE = '3';
            expect(largeCapLaneEnabled()).toBe(false);
            expect(largeCapMinUsd()).toBe(5e9);
            expect(largeCapReserve()).toBe(3);
            process.env.OPP_LARGECAP_MIN_USD = 'big'; process.env.OPP_LARGECAP_RESERVE = '-1';
            expect(largeCapMinUsd()).toBe(10e9);
            expect(largeCapReserve()).toBe(5);
        } finally {
            if (saved.a === undefined) delete process.env.OPP_LARGECAP_LANE; else process.env.OPP_LARGECAP_LANE = saved.a;
            if (saved.b === undefined) delete process.env.OPP_LARGECAP_MIN_USD; else process.env.OPP_LARGECAP_MIN_USD = saved.b;
            if (saved.c === undefined) delete process.env.OPP_LARGECAP_RESERVE; else process.env.OPP_LARGECAP_RESERVE = saved.c;
        }
    });
});

describe('planForNow — the pre-close phase is the last hour before the CLOSE (review 2026-09-06, second pass)', () => {
    test('full day: 12:30 ET is midday, 15:05 ET is pre-close; half-day 2026-11-27: 12:30 ET is already pre-close', async () => {
        const { planForNow } = await import('./opportunity-engine.js');
        expect(planForNow(new Date(Date.UTC(2026, 8, 10, 16, 30, 0))).phase).toBe('midday');     // Thu 12:30 ET (EDT)
        expect(planForNow(new Date(Date.UTC(2026, 8, 10, 19, 5, 0))).phase).toBe('pre-close');   // Thu 15:05 ET
        expect(planForNow(new Date(Date.UTC(2026, 10, 27, 17, 30, 0))).phase).toBe('pre-close'); // Fri 12:30 ET (EST), close 13:00
        expect(planForNow(new Date(Date.UTC(2026, 10, 27, 16, 30, 0))).phase).toBe('midday');    // Fri 11:30 ET
    });
});
