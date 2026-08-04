import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES, type RiskRules } from '@/tools/ibkr/risk-rules.js';
import { computeQuantity, confidenceMultiplier } from './position-sizer.js';

// The live small-account shape (risk-rules.live.yaml values) — pinned here so
// the tests don't depend on the yaml files or the active profile.
const LIVE: RiskRules = {
    ...DEFAULT_RULES,
    max_position_pct: 20,
    max_risk_per_trade_pct: 1.0,
    min_risk_budget_usd: 15,
};

// Paper shape: current production numbers.
const PAPER: RiskRules = { ...DEFAULT_RULES }; // 5% cap, 0.25% risk, no budget floor

describe('confidenceMultiplier', () => {
    test('bands: full / half / low, unscored = low', () => {
        expect(confidenceMultiplier(90, LIVE)).toBe(1);
        expect(confidenceMultiplier(80, LIVE)).toBe(1);
        expect(confidenceMultiplier(79, LIVE)).toBe(LIVE.sizing_half_mult);
        expect(confidenceMultiplier(60, LIVE)).toBe(LIVE.sizing_half_mult);
        expect(confidenceMultiplier(59, LIVE)).toBe(LIVE.sizing_low_mult);
        expect(confidenceMultiplier(null, LIVE)).toBe(LIVE.sizing_low_mult);
        expect(confidenceMultiplier(undefined, LIVE)).toBe(LIVE.sizing_low_mult);
    });
});

describe('computeQuantity — €3.7K live account', () => {
    const NETLIQ = 3700;

    test('high-confidence trade sizes from the full risk budget', () => {
        // budget = 3700 × 1% = 37; stop distance 2 → 18 by risk;
        // cap = 3700 × 20% = 740 → 14 shares at $50 → cap binds.
        const r = computeQuantity({ entry: 50, stop: 48, score: 85, netLiquidation: NETLIQ }, LIVE);
        expect(r.quantity).toBe(14);
        expect(r.riskBudget).toBe(37);
    });

    test('risk budget binds when the stop is wide', () => {
        // budget 37, stop distance 5 → 7 shares; cap allows 14.
        const r = computeQuantity({ entry: 50, stop: 45, score: 85, netLiquidation: NETLIQ }, LIVE);
        expect(r.quantity).toBe(7);
    });

    test('low confidence shrinks the budget below the floor → refused', () => {
        // unscored: 37 × 0.35 = 12.95 < $15 floor.
        const r = computeQuantity({ entry: 50, stop: 48, score: null, netLiquidation: NETLIQ }, LIVE);
        expect(r.quantity).toBeNull();
        expect(r.reason).toContain('floor');
    });

    test('unaffordable symbol (one share over the position cap) → refused with the cap', () => {
        // 20% cap = $740; MSFT-like $800 share.
        const r = computeQuantity({ entry: 800, stop: 780, score: 90, netLiquidation: NETLIQ }, LIVE);
        expect(r.quantity).toBeNull();
        expect(r.reason).toContain('cannot afford');
    });

    test('stop distance wider than the whole budget → refused, suggests structure', () => {
        // budget 37, stop distance 40 → 0 shares by risk.
        const r = computeQuantity({ entry: 300, stop: 260, score: 90, netLiquidation: NETLIQ }, LIVE);
        expect(r.quantity).toBeNull();
        expect(r.reason).toContain('stop distance');
    });
});

describe('computeQuantity — $1M paper account (sizer must also serve paper)', () => {
    test('produces the familiar risk-budget sizing', () => {
        // budget = 1,000,000 × 0.25% = 2500 at full confidence; stop distance 3.5
        // → 714 by risk; cap = 5% = 50,000 → 165 shares at $303 → cap binds.
        const r = computeQuantity({ entry: 303, stop: 299.5, score: 85, netLiquidation: 1_000_000 }, PAPER);
        expect(r.quantity).toBe(165);
    });

    test('no budget floor on paper — small unscored trades still size', () => {
        const r = computeQuantity({ entry: 20, stop: 19.5, score: null, netLiquidation: 1_000_000 }, PAPER);
        expect(r.quantity).toBeGreaterThan(0);
    });
});

describe('computeQuantity — degenerate inputs', () => {
    test('zero stop distance or missing netliq refuse cleanly', () => {
        expect(computeQuantity({ entry: 50, stop: 50, score: 90, netLiquidation: 3700 }, LIVE).quantity).toBeNull();
        expect(computeQuantity({ entry: 50, stop: 48, score: 90, netLiquidation: 0 }, LIVE).quantity).toBeNull();
    });
});
