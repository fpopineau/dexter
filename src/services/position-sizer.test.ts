import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES, type RiskRules } from '@/tools/ibkr/risk-rules.js';
import { computeQuantity, confidenceMultiplier } from './position-sizer.js';

// The live small-account shape (risk-rules.live.yaml values) — pinned here so
// the tests don't depend on the yaml files or the active profile.
// Production defaults are FLAT (1.0/1.0) until the frozen sample proves
// decile monotonicity (VALIDATION-PROTOCOL.md, review 2026-08-21). Tests
// that exercise the BANDING MECHANISM opt into explicit non-flat bands —
// the mechanism stays supported as config; the default policy is flat.
const BANDED = { sizing_half_mult: 0.6, sizing_low_mult: 0.35 };

const LIVE: RiskRules = {
    ...DEFAULT_RULES,
    ...BANDED,
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
        // → 714 by risk; cap = 5% × 0.995 drift margin = 49,750 → 164
        // shares at $303 → cap binds.
        const r = computeQuantity({ entry: 303, stop: 299.5, score: 85, netLiquidation: 1_000_000 }, PAPER);
        expect(r.quantity).toBe(164);
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

describe('computeQuantity — short proposals', () => {
    test('sizes shorts identically (stop above entry)', () => {
        const LIVE_RULES = { ...DEFAULT_RULES, max_position_pct: 20, max_risk_per_trade_pct: 1.0, min_risk_budget_usd: 15 };
        // short at 50, stop 52 → distance 2, budget 37 → 18 by risk; cap 14.
        const r = computeQuantity({ entry: 50, stop: 52, score: 85, netLiquidation: 3700 }, LIVE_RULES);
        expect(r.quantity).toBe(14);
    });
});

describe('fractional shares (small live account)', () => {
    const FRAC: RiskRules = { ...DEFAULT_RULES, ...BANDED, max_position_pct: 20, max_risk_per_trade_pct: 1.0, min_risk_budget_usd: 15, fractional_shares: true };

    test('isValidQuantity: integers-only off, 0.0001 resolution on', async () => {
        const { isValidQuantity } = await import('./position-sizer.js');
        expect(isValidQuantity(3, false)).toBe(true);
        expect(isValidQuantity(1.5, false)).toBe(false);
        expect(isValidQuantity(1.5, true)).toBe(true);
        expect(isValidQuantity(0.0001, true)).toBe(true);
        expect(isValidQuantity(0.00005, true)).toBe(false);   // below IBKR resolution
        expect(isValidQuantity(1.23456, true)).toBe(false);   // 5 decimals
        expect(isValidQuantity(0, true)).toBe(false);
        expect(isValidQuantity(-1, true)).toBe(false);
    });

    test('floorToPlaceable rounds down to the placeable step', async () => {
        const { floorToPlaceable } = await import('./position-sizer.js');
        expect(floorToPlaceable(1.99999, false)).toBe(1);
        expect(floorToPlaceable(1.48123456, true)).toBeCloseTo(1.4812, 10);
    });

    test('a $500 mega-cap becomes tradable: cap-bound decimal quantity', () => {
        // cap = 3700 × 20% × 0.995 drift margin = 736.3 → /500 = 1.4726;
        // budget 37 / stop 10 = 3.7 → cap binds.
        const r = computeQuantity({ entry: 500, stop: 490, score: 85, netLiquidation: 3700 }, FRAC);
        expect(r.quantity).toBeCloseTo(1.4726, 10);
    });

    test('cap-bound sizing survives NetLiq drifting down before the gate re-checks (P-DBFF, 2026-08-21)', () => {
        // The real refusal: sized 1553 × $9.36 on creation-time NetLiq,
        // refused at acceptance when fresh USD NetLiq (EUR account × live
        // EURUSD) had drifted ~3.5bp lower → gate max 1552. The margin
        // keeps cap-bound sizes clear of the boundary.
        const sized = computeQuantity(
            { entry: 9.36, stop: 9.14, score: 85, netLiquidation: 290_722 },
            { ...DEFAULT_RULES }, // paper shape: 5% cap, whole shares
        );
        expect(sized.quantity).not.toBeNull();
        // Gate replay at a 30bp-LOWER NetLiq must still pass.
        const driftedMaxValue = 0.05 * (290_722 * 0.997);
        expect(sized.quantity! * 9.36).toBeLessThanOrEqual(driftedMaxValue);
        // And the margin must not be doing more than trimming the boundary:
        // the size stays within 1% of the unmargined cap.
        expect(sized.quantity! * 9.36).toBeGreaterThan(0.05 * 290_722 * 0.985);
    });

    test('risk budget binds fractionally too', () => {
        // budget 37 / stop 25 = 1.48 by risk; cap 740/300 = 2.4666 → risk binds at 1.48.
        const r = computeQuantity({ entry: 300, stop: 275, score: 85, netLiquidation: 3700 }, FRAC);
        expect(r.quantity).toBeCloseTo(1.48, 10);
    });

    test('confidence floor still refuses sub-viable trades in fractional mode', () => {
        const r = computeQuantity({ entry: 500, stop: 490, score: null, netLiquidation: 3700 }, FRAC);
        expect(r.quantity).toBeNull();
        expect(r.reason).toContain('floor');
    });

    test('whole-share mode is unchanged (paper regression)', () => {
        // Cap-bound at the margined cap: 49,750 / 303 = 164.
        const r = computeQuantity({ entry: 303, stop: 299.5, score: 85, netLiquidation: 1_000_000 }, { ...DEFAULT_RULES });
        expect(r.quantity).toBe(164);
    });
});
