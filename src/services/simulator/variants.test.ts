import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES } from '@/tools/ibkr/risk-rules.js';
import { activeVariants, sizeAtRung, VARIANTS_V1, variantByName, type SimSource, type VariantContext } from './variants.js';

const T0 = Date.UTC(2026, 8, 10, 14, 0, 0);
const ctx: VariantContext = { rules: { ...DEFAULT_RULES, take_atr_mult: 1.5, take_floor_pct: 3, take_cap_pct: 10 }, flatAtFor: () => T0 + 3 * 3_600_000, laneFlatAtFor: () => T0 + 20 * 3_600_000 };

function proposal(overrides: Partial<SimSource> = {}): SimSource {
    return {
        kind: 'proposal', id: 'P-0001', symbol: 'MU', direction: 'long', entryType: 'LMT', entry: 100, entryLimit: null,
        stop: 97, target: 106, quantity: 10, tif: 'DAY', tradeClass: 'intraday', strategyId: 'intraday', createdAt: T0, expiresAt: T0 + 120 * 60_000, executedAt: null,
        takePct: 6, dailyAtr: 4, triggerBand: '60-74', lane: 'trigger', gate: null, score: 66,
        ...overrides,
    };
}

describe('variant registry v1 (REQ-SIM-004)', () => {
    test('the registry names every pre-registered variant; weights-calibrated is inactive until WP3', () => {
        const names = VARIANTS_V1.map((v) => v.name);
        for (const n of ['incumbent', 'funnel-75', 'gate-off:noise-stop', 'gate-off:entry-pricing', 'gate-off:chase', 'gate-off:extension',
            'gate-off:risk-reward', 'gate-off:microstructure', 'exit-ratchet', 'exit-x2.0', 'stop-x/3', 'exit-fixed-3', 'class-swing', 'lane-overnight', 'lane-cup-and-handle', 'class-earnings-bet', 'weights-calibrated']) {
            expect(names).toContain(n);
        }
        expect(variantByName('weights-calibrated')?.status).toMatch(/inactive/);
        expect(activeVariants().map((v) => v.name)).not.toContain('weights-calibrated');
    });

    test('incumbent: every proposal, geometry as proposed, DAY rows flat at the triage bar, GTC rows carry', () => {
        const v = variantByName('incumbent')!;
        expect(v.applies(proposal())).toBe(true);
        expect(v.applies(proposal({ kind: 'refusal', gate: 'noise-stop' }))).toBe(false);
        const spec = v.spec(proposal(), ctx)!;
        expect(spec.entry).toBe(100); expect(spec.stop).toBe(97); expect(spec.target).toBe(106);
        expect(spec.flatAt).toBe(T0 + 3 * 3_600_000);
        expect(v.spec(proposal({ tif: 'GTC', tradeClass: 'swing' }), ctx)!.flatAt).toBe(T0 + 20 * 3_600_000); // review 2026-09-06: GTC twins flatten at the lane deadline
        // the entry may rest 30 min past the proposal's expiry (the sweeper's grace)
        // review 2026-09-06 second pass (finding 5): the entry dies at max(expiry, accepted + 30 min grace) — never accepted → expiry
        expect(spec.entryDeadline).toBe(T0 + 120 * 60_000);
        expect(v.spec(proposal({ executedAt: T0 + 110 * 60_000 }), ctx)!.entryDeadline).toBe(T0 + 140 * 60_000); // a late accept keeps its 30 min
        expect(v.spec(proposal({ executedAt: T0 + 10 * 60_000 }), ctx)!.entryDeadline).toBe(T0 + 120 * 60_000); // an early accept dies at expiry
    });

    test('WP5 lanes: exit-fixed-3 targets +3% from entry; lane-overnight/lane-cup by strategy; class-swing keeps swing + legacy swing rows; an overnight GTC entry dies with its expiry', () => {
        const fixed = variantByName('exit-fixed-3')!;
        expect(fixed.spec(proposal(), ctx)!.target).toBeCloseTo(103, 9);
        expect(fixed.spec(proposal({ direction: 'short' }), ctx)!.target).toBeCloseTo(97, 9);
        expect(fixed.applies(proposal({ tradeClass: 'swing', strategyId: 'swing' }))).toBe(false);
        const ovn = proposal({ tradeClass: 'swing', tif: 'GTC', strategyId: 'overnight', expiresAt: T0 + 25 * 60_000 });
        expect(variantByName('lane-overnight')!.applies(ovn)).toBe(true);
        expect(variantByName('class-swing')!.applies(ovn)).toBe(false);
        expect(variantByName('class-swing')!.applies(proposal({ tradeClass: 'swing', tif: 'GTC', strategyId: 'swing' }))).toBe(true);
        expect(variantByName('class-swing')!.applies(proposal({ tradeClass: 'swing', tif: 'GTC', strategyId: null }))).toBe(true);
        expect(variantByName('lane-cup-and-handle')!.applies(proposal({ tradeClass: 'swing', tif: 'GTC', strategyId: 'cup-and-handle' }))).toBe(true);
        // entry deadline: an ordinary GTC swing may rest 3 days; the overnight lane dies at expiry + grace
        expect(variantByName('lane-overnight')!.spec(ovn, ctx)!.entryDeadline).toBe(T0 + 30 * 60_000); // max(expiry 25 min, creation + 30 min grace)
        expect(variantByName('lane-overnight')!.spec({ ...ovn, executedAt: T0 + 20 * 60_000 }, ctx)!.entryDeadline).toBe(T0 + 50 * 60_000); // accepted at 20 → 50
        expect(variantByName('class-swing')!.spec(proposal({ tradeClass: 'swing', tif: 'GTC', strategyId: 'swing' }), ctx)!.entryDeadline).toBe(T0 + 3 * 86_400_000);
    });

    test('funnel-75: what the OLD bar would have traded — trigger rows in the 75+ band, plus every non-trigger lane', () => {
        const v = variantByName('funnel-75')!;
        expect(v.applies(proposal({ triggerBand: '75+' }))).toBe(true);
        expect(v.applies(proposal({ triggerBand: '60-74' }))).toBe(false);
        expect(v.applies(proposal({ lane: 'cron:Market Open Scan', triggerBand: null }))).toBe(true);
        expect(v.applies(proposal({ lane: 'breadth', triggerBand: null }))).toBe(true);
    });

    test('gate-off:<gate>: only refusals of that gate, replayed as proposed; incomplete levels never apply', () => {
        const v = variantByName('gate-off:noise-stop')!;
        expect(v.applies(proposal({ kind: 'refusal', gate: 'noise-stop' }))).toBe(true);
        expect(v.applies(proposal({ kind: 'refusal', gate: 'entry-pricing' }))).toBe(false);
        expect(v.applies(proposal({ kind: 'refusal', gate: 'noise-stop', target: null as never }))).toBe(false);
        expect(v.applies(proposal())).toBe(false);
        const spec = v.spec(proposal({ kind: 'refusal', gate: 'noise-stop', stop: 99.5, target: 101.5 }), ctx)!;
        expect(spec.stop).toBe(99.5); expect(spec.target).toBe(101.5);
    });

    test('exit-ratchet: intraday rows with an x and an ATR — no fixed target, arm at x, lock at x−1, trail = pullback mult × ATR', () => {
        const v = variantByName('exit-ratchet')!;
        const spec = v.spec(proposal(), ctx)!;
        expect(spec.target).toBeNull();
        expect(spec.ratchet).toEqual({ armPct: 6, lockPct: 5, trailAbs: ctx.rules.profit_trail_pullback_atr_mult * 4 });
        expect(v.spec(proposal({ dailyAtr: null }), ctx)).toBeNull();
        expect(v.applies(proposal({ tradeClass: 'swing', tif: 'GTC' }))).toBe(false);
    });

    test('exit-x2.0: target at clamp(2.0 × ATR%, floor, cap) from entry; stop unchanged', () => {
        const v = variantByName('exit-x2.0')!;
        const spec = v.spec(proposal(), ctx)!; // ATR% = 4 → 8% → target 108
        expect(spec.target).toBeCloseTo(108, 6);
        expect(spec.stop).toBe(97);
        const capped = v.spec(proposal({ dailyAtr: 8 }), ctx)!; // 16% → cap 10 → 110
        expect(capped.target).toBeCloseTo(110, 6);
        const short = v.spec(proposal({ direction: 'short', stop: 103, target: 94 }), ctx)!;
        expect(short.target).toBeCloseTo(92, 6);
    });

    test('stop-x/3: stop tightened to x/3 from entry; target unchanged', () => {
        const v = variantByName('stop-x/3')!;
        const spec = v.spec(proposal(), ctx)!; // x = 6 → stop at 98
        expect(spec.stop).toBeCloseTo(98, 6);
        expect(spec.target).toBe(106);
        expect(v.spec(proposal({ direction: 'short', stop: 103, target: 94 }), ctx)!.stop).toBeCloseTo(102, 6);
    });

    test('class variants select by class and carry GTC overnight', () => {
        const swing = variantByName('class-swing')!;
        expect(swing.applies(proposal({ tradeClass: 'swing', tif: 'GTC', strategyId: 'swing' }))).toBe(true);
        expect(swing.applies(proposal())).toBe(false);
        expect(swing.spec(proposal({ tradeClass: 'swing', tif: 'GTC', strategyId: 'swing' }), ctx)!.flatAt).toBe(T0 + 20 * 3_600_000);
        const bet = variantByName('class-earnings-bet')!;
        expect(bet.applies(proposal({ tradeClass: 'earnings-bet', tif: 'GTC' }))).toBe(true);
        expect(bet.applies(proposal({ tradeClass: 'swing', tif: 'GTC', strategyId: 'swing' }))).toBe(false);
    });
});

describe('sizeAtRung (REQ-SIM-005 — every variant sized at the current rung)', () => {
    test('floor(rung% × NetLiq / |entry − stop|), whole shares, zero when unaffordable', () => {
        expect(sizeAtRung({ entry: 100, stop: 97, rungPct: 0.25, netLiq: 12_000 })).toBe(10); // $30 / $3
        expect(sizeAtRung({ entry: 100, stop: 97, rungPct: 0.5, netLiq: 12_000 })).toBe(20);
        expect(sizeAtRung({ entry: 1000, stop: 900, rungPct: 0.25, netLiq: 12_000 })).toBe(0);
        expect(sizeAtRung({ entry: 100, stop: 100, rungPct: 0.25, netLiq: 12_000 })).toBe(0);
    });
});
