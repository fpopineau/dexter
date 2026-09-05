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
        const r = computeQuantity({ entry: 50, stop: 48, score: 85, netLiquidation: NETLIQ }, LIVE, LIVE.max_risk_per_trade_pct);
        expect(r.quantity).toBe(14);
        expect(r.riskBudget).toBe(37);
    });

    test('risk budget binds when the stop is wide', () => {
        // budget 37, stop distance 5 → 7 shares; cap allows 14.
        const r = computeQuantity({ entry: 50, stop: 45, score: 85, netLiquidation: NETLIQ }, LIVE, LIVE.max_risk_per_trade_pct);
        expect(r.quantity).toBe(7);
    });

    test('low confidence shrinks the budget below the floor → refused', () => {
        // unscored: 37 × 0.35 = 12.95 < $15 floor.
        const r = computeQuantity({ entry: 50, stop: 48, score: null, netLiquidation: NETLIQ }, LIVE, LIVE.max_risk_per_trade_pct);
        expect(r.quantity).toBeNull();
        expect(r.reason).toContain('floor');
    });

    test('unaffordable symbol (one share over the position cap) → refused with the cap', () => {
        // 20% cap = $740; MSFT-like $800 share.
        const r = computeQuantity({ entry: 800, stop: 780, score: 90, netLiquidation: NETLIQ }, LIVE, LIVE.max_risk_per_trade_pct);
        expect(r.quantity).toBeNull();
        expect(r.reason).toContain('cannot afford');
    });

    test('stop distance wider than the whole budget → refused, suggests structure', () => {
        // budget 37, stop distance 40 → 0 shares by risk.
        const r = computeQuantity({ entry: 300, stop: 260, score: 90, netLiquidation: NETLIQ }, LIVE, LIVE.max_risk_per_trade_pct);
        expect(r.quantity).toBeNull();
        expect(r.reason).toContain('stop distance');
    });
});

describe('computeQuantity — four-lane contract (REQ-LANE-004: overnight-capable sizing composes the gap-stress budget)', () => {
    // Live shape: 1.5% daily loss, 20% stress → the WHOLE overnight book ≤ 7.5% of NetLiq; per-position overnight cap 15%.
    const LIVE_LANES: RiskRules = {
        ...DEFAULT_RULES, max_position_pct: 15, max_daily_loss_pct: 1.5, overnight_gap_stress_pct: 20, max_overnight_position_pct: 15,
        swing_risk_pct: 0.75, overnight_risk_pct: 0.75, max_risk_per_trade_pct: 0.5,
    };
    const NETLIQ = 11_700;

    test('a swing-class position is capped by the stress budget: $877 notional → 8 shares at $100 even though risk and the position cap allow more', () => {
        // risk: 0.75% × 11,700 = $87.75 / $2 stop = 43 shares; position cap 15% = $1,755 → 17 shares; stress cap $877.5 × 0.995 / 100 = 8.
        const r = computeQuantity({ entry: 100, stop: 98, score: 85, netLiquidation: NETLIQ, tradeClass: 'swing', strategyId: 'swing' }, LIVE_LANES, 0.5);
        expect(r.quantity).toBe(8);
        // the existing overnight book eats the budget: $500 already riding → $377.5 left → 3 shares
        expect(computeQuantity({ entry: 100, stop: 98, score: 85, netLiquidation: NETLIQ, tradeClass: 'swing', strategyId: 'swing', overnightBookNotionalUsd: 500 }, LIVE_LANES, 0.5).quantity).toBe(3);
        // a $1,000 name cannot ride the night at all — refused with the overnight reason
        const big = computeQuantity({ entry: 1000, stop: 980, score: 85, netLiquidation: NETLIQ, tradeClass: 'swing', strategyId: 'swing' }, LIVE_LANES, 0.5);
        expect(big.quantity).toBeNull();
        expect(big.reason).toContain('overnight budget');
    });

    test('the overnight lane funds from overnight_risk_pct; intraday is untouched by the stress cap; stress 0 disables it', () => {
        const ovn = computeQuantity({ entry: 50, stop: 49, score: 85, netLiquidation: NETLIQ, tradeClass: 'swing', strategyId: 'overnight' }, { ...LIVE_LANES, overnight_risk_pct: 0.25 }, 0.5);
        expect(ovn.riskBudget).toBeCloseTo(29.25, 2); // 0.25% × 11,700
        const intraday = computeQuantity({ entry: 1000, stop: 990, score: 85, netLiquidation: NETLIQ, tradeClass: 'intraday', strategyId: 'intraday' }, LIVE_LANES, 0.5);
        expect(intraday.quantity).toBe(1); // 15% cap = $1,755 → 1 share; no overnight cap on the intraday class
        const noStress = computeQuantity({ entry: 100, stop: 98, score: 85, netLiquidation: NETLIQ, tradeClass: 'swing', strategyId: 'swing' }, { ...LIVE_LANES, overnight_gap_stress_pct: 0 }, 0.5);
        expect(noStress.quantity).toBe(17); // only the 15% per-position overnight cap binds
    });
});

describe('computeQuantity — WP6: the book composes every acceptance cap at creation (REQ-SIZE-002/003)', () => {
    const LIVE_BOOK: RiskRules = {
        ...DEFAULT_RULES, max_position_pct: 15, max_daily_loss_pct: 1.5, max_sector_exposure_pct: 35, max_overnight_position_pct: 15,
        max_overnight_exposure_pct: 30, overnight_gap_stress_pct: 20, swing_risk_pct: 0.75, overnight_risk_pct: 0.75, max_risk_per_trade_pct: 0.5,
        max_adv_pct: 1.0, commission_per_share_usd: 0.005, commission_min_usd: 1, slippage_bps: 5, max_cost_to_target_pct: 20,
    };
    const NETLIQ = 11_700;
    // intraday, $100 entry, $2 stop, rung 0.5%: risk 58.5/2 = 29 shares; cap 1,755×0.995/100 = 17 → 'position-cap' binds by default
    const base = { entry: 100, stop: 98, score: 85, netLiquidation: NETLIQ, tradeClass: 'intraday' as const, strategyId: 'intraday' as const };

    test('with no book the result names the binding cap (position-cap here) and lists every cap it evaluated', () => {
        const r = computeQuantity(base, LIVE_BOOK, 0.5);
        expect(r.quantity).toBe(17);
        expect(r.binding).toBe('position-cap');
        expect(r.caps).toEqual({ risk: 29, 'position-cap': 17 });
    });

    test('headroom: planned stop-outs of the open book plus realized losses cap the shares; nothing left → refused naming headroom', () => {
        // limit $175.5; open planned risk $150; realized −$10 → headroom $15.5 → 7 shares at $2
        const r = computeQuantity({ ...base, book: { openPlannedRiskUsd: 150, realizedLossTodayUsd: -10 } }, LIVE_BOOK, 0.5);
        expect(r.quantity).toBe(7);
        expect(r.binding).toBe('headroom');
        const none = computeQuantity({ ...base, book: { openPlannedRiskUsd: 175 } }, LIVE_BOOK, 0.5);
        expect(none.quantity).toBeNull();
        expect(none.binding).toBe('headroom');
        expect(none.reason).toContain('daily-loss headroom');
        // wins never expand the headroom
        expect(computeQuantity({ ...base, book: { openPlannedRiskUsd: 150, realizedLossTodayUsd: +500 } }, LIVE_BOOK, 0.5).quantity).toBe(12);
    });

    test('symbol aggregate, sector and ADV rooms bind and name themselves', () => {
        // symbol: cap $1,755 − $1,500 committed = $255 → 2 shares
        expect(computeQuantity({ ...base, book: { existingSymbolExposureUsd: 1500 } }, LIVE_BOOK, 0.5)).toMatchObject({ quantity: 2, binding: 'symbol-aggregate' });
        // sector: 35% = $4,095 − $3,800 = $295 → 2 shares
        expect(computeQuantity({ ...base, book: { sameSectorExposureUsd: 3800 } }, LIVE_BOOK, 0.5)).toMatchObject({ quantity: 2, binding: 'sector' });
        // unknown sector → skipped
        expect(computeQuantity({ ...base, book: { sameSectorExposureUsd: null } }, LIVE_BOOK, 0.5).caps?.sector).toBeUndefined();
        // ADV: 1% of 1,000 shares = 10
        expect(computeQuantity({ ...base, book: { avgDailyVolume20d: 1000 } }, LIVE_BOOK, 0.5)).toMatchObject({ quantity: 10, binding: 'adv' });
        const thin = computeQuantity({ ...base, book: { avgDailyVolume20d: 50 } }, LIVE_BOOK, 0.5);
        expect(thin.quantity).toBeNull();
        expect(thin.reason).toContain('ADV');
    });

    test('swing class: class-aware book stress and the overnight book cap compose with the per-position overnight cap', () => {
        const swing = { ...base, tradeClass: 'swing' as const, strategyId: 'swing' as const, stop: 97 };
        // stress budget $175.5; book already stressed $100 → room $75.5/0.2 = $377.5 → 3 shares
        expect(computeQuantity({ ...swing, book: { overnightExposureUsd: 500, overnightStressedLossUsd: 100 } }, LIVE_BOOK, 0.5)).toMatchObject({ quantity: 3, binding: 'overnight' });
        // book cap: 30% = $3,510 − $3,400 = $110 → 1 share (stress room would allow more with an empty stressed book)
        expect(computeQuantity({ ...swing, book: { overnightExposureUsd: 3400, overnightStressedLossUsd: 0 } }, LIVE_BOOK, 0.5)).toMatchObject({ quantity: 1, binding: 'overnight' });
    });

    test('REQ-SIZE-003 viability: a 2-share trade at +3% cannot pay two $1 commissions inside 20%; a viable size passes and reports the ratio', () => {
        // cheap name, wide stop → risk allows few shares: $117 entry, $110 stop, rung 0.25% → 29.25/7 = 4 shares; target +3% → gross $14.04, costs ≈ $2.6 → 18.5%
        const ok = computeQuantity({ entry: 117, stop: 110, target: 120.51, score: 85, netLiquidation: NETLIQ, tradeClass: 'intraday', strategyId: 'intraday', book: { spreadPct: 0.05 } }, LIVE_BOOK, 0.25);
        expect(ok.quantity).toBe(4);
        expect(ok.costToTargetPct).toBeLessThanOrEqual(20);
        const tiny = computeQuantity({ entry: 117, stop: 100, target: 120.51, score: 85, netLiquidation: NETLIQ, tradeClass: 'intraday', strategyId: 'intraday' }, LIVE_BOOK, 0.25);
        // 29.25/17 = 1 share → gross $3.51, costs $2 + slippage → over 20%
        expect(tiny.quantity).toBeNull();
        expect(tiny.binding).toBe('costs');
        expect(tiny.reason).toContain('cost-to-target cap');
        // without a target the viability check does not run
        expect(computeQuantity({ entry: 117, stop: 100, score: 85, netLiquidation: NETLIQ, tradeClass: 'intraday', strategyId: 'intraday' }, LIVE_BOOK, 0.25).quantity).toBe(1);
    });
});

describe('computeQuantity — $1M paper account (sizer must also serve paper)', () => {
    test('produces the familiar risk-budget sizing', () => {
        // budget = 1,000,000 × 0.25% = 2500 at full confidence; stop distance 3.5
        // → 714 by risk; cap = 5% × 0.995 drift margin = 49,750 → 164
        // shares at $303 → cap binds.
        const r = computeQuantity({ entry: 303, stop: 299.5, score: 85, netLiquidation: 1_000_000 }, PAPER, PAPER.max_risk_per_trade_pct);
        expect(r.quantity).toBe(164);
    });

    test('no budget floor on paper — small unscored trades still size', () => {
        const r = computeQuantity({ entry: 20, stop: 19.5, score: null, netLiquidation: 1_000_000 }, PAPER, PAPER.max_risk_per_trade_pct);
        expect(r.quantity).toBeGreaterThan(0);
    });
});

describe('computeQuantity — degenerate inputs', () => {
    test('zero stop distance or missing netliq refuse cleanly', () => {
        expect(computeQuantity({ entry: 50, stop: 50, score: 90, netLiquidation: 3700 }, LIVE, LIVE.max_risk_per_trade_pct).quantity).toBeNull();
        expect(computeQuantity({ entry: 50, stop: 48, score: 90, netLiquidation: 0 }, LIVE, LIVE.max_risk_per_trade_pct).quantity).toBeNull();
    });
});

describe('computeQuantity — short proposals', () => {
    test('sizes shorts identically (stop above entry)', () => {
        const LIVE_RULES = { ...DEFAULT_RULES, max_position_pct: 20, max_risk_per_trade_pct: 1.0, min_risk_budget_usd: 15 };
        // short at 50, stop 52 → distance 2, budget 37 → 18 by risk; cap 14.
        const r = computeQuantity({ entry: 50, stop: 52, score: 85, netLiquidation: 3700 }, LIVE_RULES, LIVE_RULES.max_risk_per_trade_pct);
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
        const r = computeQuantity({ entry: 500, stop: 490, score: 85, netLiquidation: 3700 }, FRAC, FRAC.max_risk_per_trade_pct);
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
        const r = computeQuantity({ entry: 300, stop: 275, score: 85, netLiquidation: 3700 }, FRAC, FRAC.max_risk_per_trade_pct);
        expect(r.quantity).toBeCloseTo(1.48, 10);
    });

    test('confidence floor still refuses sub-viable trades in fractional mode', () => {
        const r = computeQuantity({ entry: 500, stop: 490, score: null, netLiquidation: 3700 }, FRAC, FRAC.max_risk_per_trade_pct);
        expect(r.quantity).toBeNull();
        expect(r.reason).toContain('floor');
    });

    test('whole-share mode is unchanged (paper regression)', () => {
        // Cap-bound at the margined cap: 49,750 / 303 = 164.
        const r = computeQuantity({ entry: 303, stop: 299.5, score: 85, netLiquidation: 1_000_000 }, { ...DEFAULT_RULES }, DEFAULT_RULES.max_risk_per_trade_pct);
        expect(r.quantity).toBe(164);
    });
});

describe('ladder rung overlay (REQ-RISK-009 — effective intraday risk = min(yaml ceiling, rung))', () => {
    const CEIL = { ...DEFAULT_RULES, max_risk_per_trade_pct: 0.5, swing_risk_pct: 0.75, max_position_pct: 50 };

    test('classRiskPct: the rung caps intraday, the yaml stays the ceiling; swing and bets are untouched', async () => {
        const { classRiskPct } = await import('./position-sizer.js');
        expect(classRiskPct('intraday', CEIL, 0.25)).toBe(0.25);
        expect(classRiskPct('intraday', CEIL, 1.0)).toBe(0.5);
        expect(classRiskPct('swing', CEIL, 0.25)).toBe(0.75);
        expect(classRiskPct('earnings-bet', CEIL, 0.25)).toBe(CEIL.earnings_bet_risk_pct);
    });

    test('computeQuantity sizes at the rung: 0.25% of $10,000 with a $2.5 stop = $25 budget, 10 shares; a higher rung is capped by the yaml', () => {
        const low = computeQuantity({ entry: 100, stop: 97.5, score: 90, netLiquidation: 10_000 }, CEIL, 0.25);
        expect(low.riskBudget).toBe(25);
        expect(low.quantity).toBe(10);
        const high = computeQuantity({ entry: 100, stop: 97.5, score: 90, netLiquidation: 10_000 }, CEIL, 1.0);
        expect(high.riskBudget).toBe(50);
        expect(high.quantity).toBe(20);
    });

    test('without a ladder file (test data dir) the default rung is the bottom rung 0.25 — fail-safe toward smaller', () => {
        const r = computeQuantity({ entry: 100, stop: 97.5, score: 90, netLiquidation: 10_000 }, { ...CEIL, max_risk_per_trade_pct: 1.0 });
        expect(r.riskBudget).toBe(25);
        expect(r.quantity).toBe(10);
    });
});
