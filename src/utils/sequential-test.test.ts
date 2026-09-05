import { describe, expect, test } from 'bun:test';
import {
    bandLine,
    constantsHash,
    dailyDifferenceBounds,
    evaluateLook,
    hardStopDue,
    ladderEligibility,
    lookBoundaryReached,
    netRForRow,
    runningStats,
    SEQ_CONSTANTS,
    spearman,
    stepDownDue,
    type RTrade,
} from './sequential-test.js';

function trades(rs: number[], opts: { days?: number; band?: '60-74' | '75+' | null } = {}): RTrade[] {
    const days = opts.days ?? Math.max(5, Math.ceil(rs.length / 3));
    return rs.map((r, i) => ({
        id: `P-${String(i).padStart(4, '0')}`,
        entryDay: `2026-09-${String(10 + (i % days)).padStart(2, '0')}`,
        closedAt: 1_000_000 + i * 60_000, // close order = array order
        netR: r,
        netUsd: r * 30,
        band: opts.band ?? '60-74',
        tradeClass: 'intraday' as const,
        strategyId: 'intraday' as const,
        score: 60 + (i % 40),
    }));
}

describe('SEQ_CONSTANTS are the pre-registered numbers and hash stably', () => {
    test('looks 25/50/75/100 with OBF-style confidences; reject at 95% UCB; PF 1.3; 5% stops; rungs 0.25→1.0', () => {
        expect(SEQ_CONSTANTS.looks).toEqual([25, 50, 75, 100]);
        expect(SEQ_CONSTANTS.lookConfidences).toEqual([0.99, 0.975, 0.96, 0.95]);
        expect(SEQ_CONSTANTS.rejectConfidence).toBe(0.95);
        expect(SEQ_CONSTANTS.minProfitFactor).toBe(1.3);
        expect(SEQ_CONSTANTS.hardStopDrawdown).toBe(0.05);
        expect(SEQ_CONSTANTS.ladder.rungs).toEqual([0.25, 0.5, 0.75, 1.0]);
        expect(SEQ_CONSTANTS.ladder.stepUpAt).toEqual([25, 50, 100]);
        expect(SEQ_CONSTANTS.ladder.stepDownDrawdown).toBe(0.05);
        expect(SEQ_CONSTANTS.promotion).toEqual({ minTrades: 30, minDays: 10 });
        expect(SEQ_CONSTANTS.band).toEqual({ name: '60-74', minTrades: 20 });
        expect(constantsHash()).toMatch(/^[0-9a-f]{12}$/);
        expect(constantsHash()).toBe(constantsHash());
    });
});

describe('netRForRow (REQ-SEQ-001 — net USD over |fill − stop| × qty; missing basis is an anomaly, never zero)', () => {
    test('a filled long with a stop and commissions', () => {
        expect(netRForRow({ realizedPnl: 60, commissions: 2, entryFillPrice: 100, stop: 97, quantity: 10 })).toBeCloseTo(58 / 30, 6);
        expect(netRForRow({ realizedPnl: -30, commissions: 2, entryFillPrice: 100, stop: 97, quantity: 10 })).toBeCloseTo(-32 / 30, 6);
    });

    test('null when the fill, the stop distance, the quantity or the commissions are missing', () => {
        expect(netRForRow({ realizedPnl: 60, commissions: 2, entryFillPrice: null, stop: 97, quantity: 10 })).toBeNull();
        expect(netRForRow({ realizedPnl: 60, commissions: 2, entryFillPrice: 100, stop: 100, quantity: 10 })).toBeNull();
        expect(netRForRow({ realizedPnl: 60, commissions: 2, entryFillPrice: 100, stop: 97, quantity: 0 })).toBeNull();
        expect(netRForRow({ realizedPnl: 60, commissions: null, entryFillPrice: 100, stop: 97, quantity: 10 })).toBeNull();
    });
});

describe('lookBoundaryReached (REQ-SEQ-002 — a look fires once, when n first reaches a boundary)', () => {
    test('returns the boundaries reached and not yet done, in order', () => {
        expect(lookBoundaryReached(24, [])).toEqual([]);
        expect(lookBoundaryReached(25, [])).toEqual([25]);
        expect(lookBoundaryReached(30, [25])).toEqual([]);
        expect(lookBoundaryReached(52, [25])).toEqual([50]);
        expect(lookBoundaryReached(120, [25])).toEqual([50, 75, 100]);
    });
});

describe('evaluateLook (REQ-SEQ-002/003)', () => {
    test('ACCEPT: LCB > 0 at the look confidence, net R > 0, PF ≥ 1.3', () => {
        // 20 wins of 1.5 R, 5 losses of 1 R, spread so every entry day nets positive.
        const strong = trades(Array.from({ length: 25 }, (_, i) => (i % 5 === 0 ? -1 : 1.5)), { days: 12 });
        const r = evaluateLook(strong, 25);
        expect(r.decision).toBe('ACCEPT');
        expect(r.lookConfidence).toBe(0.99);
        expect(r.lcb).toBeGreaterThan(0);
        expect(r.profitFactor).toBeGreaterThanOrEqual(1.3);
    });

    test('REJECT: the 95% one-sided UPPER bound is below zero', () => {
        const bad = trades(Array.from({ length: 25 }, (_, i) => (i % 4 === 0 ? 0.5 : -1)), { days: 12 });
        const r = evaluateLook(bad, 25);
        expect(r.decision).toBe('REJECT');
        expect(r.ucb95).toBeLessThan(0);
    });

    test('CONTINUE: mixed evidence — neither bound decides; PF below 1.3 blocks ACCEPT even with a positive LCB', () => {
        const mixed = trades(Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? 1 : -0.9)), { days: 12 });
        expect(evaluateLook(mixed, 25).decision).toBe('CONTINUE');
        // Positive but thin: many small wins, PF just under 1.3.
        const thin = trades(Array.from({ length: 25 }, (_, i) => (i % 5 === 0 ? -2 : 0.6)), { days: 12 });
        const t = evaluateLook(thin, 25);
        expect(t.profitFactor).toBeLessThan(1.3);
        expect(t.decision).not.toBe('ACCEPT');
    });

    test('AUD-12: a look evaluates the PREFIX of the first lookN trades in close order — later closes never change it', () => {
        const good = Array.from({ length: 25 }, (_, i) => (i % 5 === 0 ? -1 : 1.5));
        const withLaterLosses = trades([...good, -3, -3, -3, -3, -3], { days: 12 });
        const look25 = evaluateLook(withLaterLosses, 25);
        expect(look25.n).toBe(25);
        expect(look25.decision).toBe('ACCEPT');
        expect(look25.sumR).toBeCloseTo(evaluateLook(trades(good, { days: 12 }), 25).sumR, 9);
        // the order is by closedAt, not by array position
        const shuffled = [...withLaterLosses].reverse();
        expect(evaluateLook(shuffled, 25).sumR).toBeCloseTo(look25.sumR, 9);
        // two boundaries crossed between runs evaluate two distinct prefixes
        const sixty = trades(Array.from({ length: 60 }, (_, i) => (i < 25 ? 1 : -1)), { days: 20 });
        expect(evaluateLook(sixty, 25).sumR).toBeCloseTo(25, 9);
        expect(evaluateLook(sixty, 50).sumR).toBeCloseTo(0, 9);
    });

    test('later looks use their own confidence (97.5 / 96 / 95) and n below 5 entry days is NOT EVALUABLE', () => {
        const r50 = evaluateLook(trades(Array.from({ length: 50 }, () => 1), { days: 20 }), 50);
        expect(r50.lookConfidence).toBe(0.975);
        const r100 = evaluateLook(trades(Array.from({ length: 100 }, () => 1), { days: 40 }), 100);
        expect(r100.lookConfidence).toBe(0.95);
        const few = evaluateLook(trades(Array.from({ length: 25 }, () => 1), { days: 3 }), 25);
        expect(few.decision).toBe('NOT-EVALUABLE');
    });
});

describe('runningStats (informational between looks)', () => {
    test('n, sum/mean R, PF, next look, labelled informational', () => {
        const s = runningStats(trades([1, -0.5, 2, -1, 0.5]));
        expect(s.n).toBe(5);
        expect(s.sumR).toBeCloseTo(2, 6);
        expect(s.meanR).toBeCloseTo(0.4, 6);
        expect(s.profitFactor).toBeCloseTo(3.5 / 1.5, 6);
        expect(s.nextLook).toBe(25);
        expect(s.informational).toBe(true);
        expect(runningStats(trades(Array.from({ length: 60 }, () => 1))).nextLook).toBe(75);
        expect(runningStats(trades(Array.from({ length: 100 }, () => 1))).nextLook).toBeNull();
    });
});

describe('dailyDifferenceBounds (REQ-SEQ-006 — shadow variant vs incumbent on the same days)', () => {
    test('a variant that beats the incumbent every day has LCB > 0; a coin flip does not; too few days → null', () => {
        const days = Array.from({ length: 12 }, (_, i) => `2026-09-${String(10 + i).padStart(2, '0')}`);
        const inc = new Map(days.map((d) => [d, 0.5]));
        const better = new Map(days.map((d) => [d, 1.2]));
        const b = dailyDifferenceBounds(better, inc)!;
        expect(b.lcb).toBeGreaterThan(0);
        expect(b.days).toBe(12);
        const flip = new Map(days.map((d, i) => [d, i % 2 ? 1.5 : -0.5]));
        expect(dailyDifferenceBounds(flip, inc)!.lcb).toBeLessThan(0.7);
        expect(dailyDifferenceBounds(new Map(days.slice(0, 3).map((d) => [d, 1])), inc)).toBeNull();
        // a variant day with no rows counts as 0 on that incumbent day
        const sparse = new Map(days.slice(0, 6).map((d) => [d, 3]));
        expect(dailyDifferenceBounds(sparse, inc)!.days).toBe(12);
    });
});

describe('ladder rules (REQ-LADDER-001/002)', () => {
    test('step-up eligibility at 25/50/100 with net R > 0 and no active stop; capped by the ceiling rung', () => {
        expect(ladderEligibility({ n: 24, sumR: 5, rung: 0.25, stopActive: false })).toEqual({ eligible: false, nextRung: 0.5, milestone: 25, reason: 'n 24 < 25' });
        expect(ladderEligibility({ n: 25, sumR: 5, rung: 0.25, stopActive: false })).toEqual({ eligible: true, nextRung: 0.5, milestone: 25, reason: 'n 25 ≥ 25, net R +5.00, no active stop' });
        expect(ladderEligibility({ n: 25, sumR: -1, rung: 0.25, stopActive: false }).eligible).toBe(false);
        expect(ladderEligibility({ n: 25, sumR: 5, rung: 0.25, stopActive: true }).eligible).toBe(false);
        expect(ladderEligibility({ n: 60, sumR: 5, rung: 0.5, stopActive: false })).toEqual({ eligible: true, nextRung: 0.75, milestone: 50, reason: 'n 60 ≥ 50, net R +5.00, no active stop' });
        expect(ladderEligibility({ n: 60, sumR: 5, rung: 0.75, stopActive: false })).toEqual({ eligible: false, nextRung: 1.0, milestone: 100, reason: 'n 60 < 100' });
        expect(ladderEligibility({ n: 150, sumR: 5, rung: 1.0, stopActive: false })).toEqual({ eligible: false, nextRung: null, milestone: null, reason: 'top rung' });
    });

    test('AUD-09: a rung above the ratified ceiling is never offered (effective risk = min(rung, ceiling))', async () => {
        const { effectiveRiskPct } = await import('./sequential-test.js');
        const capped = ladderEligibility({ n: 60, sumR: 5, rung: 0.5, stopActive: false, ceilingPct: 0.5 });
        expect(capped.eligible).toBe(false);
        expect(capped.reason).toContain('ceiling');
        expect(ladderEligibility({ n: 25, sumR: 5, rung: 0.25, stopActive: false, ceilingPct: 0.5 }).eligible).toBe(true);
        expect(effectiveRiskPct(0.75, 0.5)).toBe(0.5);
        expect(effectiveRiskPct(0.25, 0.5)).toBe(0.25);
    });

    test('stepDownDue at −5% from the last step-up mark; hardStopDue at −5% from the epoch NetLiq', () => {
        expect(stepDownDue(9_500, 10_000)).toBe(true);
        expect(stepDownDue(9_501, 10_000)).toBe(false);
        expect(stepDownDue(9_500, null)).toBe(false);
        expect(hardStopDue(11_400, 12_000)).toBe(true);
        expect(hardStopDue(11_401, 12_000)).toBe(false);
    });
});

describe('bandLine (REQ-SEQ-007) and spearman', () => {
    test('the 60-74 band line and its pre-registered bar (net ≥ 0 once n ≥ 20)', () => {
        const ok = bandLine(trades(Array.from({ length: 22 }, (_, i) => (i % 3 ? 0.5 : -0.4)), { band: '60-74' }));
        expect(ok.n).toBe(22);
        expect(ok.netUsd).toBeGreaterThan(0);
        expect(ok.barMet).toBe(true);
        const neg = bandLine(trades(Array.from({ length: 22 }, () => -0.3), { band: '60-74' }));
        expect(neg.barMet).toBe(false);
        const early = bandLine(trades(Array.from({ length: 10 }, () => -0.3), { band: '60-74' }));
        expect(early.barMet).toBeNull(); // not yet judged
        expect(bandLine(trades([1, 1], { band: '75+' })).n).toBe(0);
    });

    test('spearman: monotone pairs → rho 1; anti → −1; too few → null', () => {
        expect(spearman([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]])!.rho).toBeCloseTo(1, 6);
        expect(spearman([[1, 5], [2, 4], [3, 3], [4, 2], [5, 1]])!.rho).toBeCloseTo(-1, 6);
        expect(spearman([[1, 1], [2, 2]])).toBeNull();
    });
});
