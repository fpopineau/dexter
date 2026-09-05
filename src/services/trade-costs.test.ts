import { describe, expect, test } from 'bun:test';
import { commissionPerSideUsd, costViability, estimateRoundTrip } from './trade-costs.js';

const rules = { commission_per_share_usd: 0.005, commission_min_usd: 1.0, slippage_bps: 5, max_cost_to_target_pct: 20 };

describe('trade costs (REQ-SIZE-003)', () => {
    test('commission per side: the $1 minimum binds on small orders, the per-share rate on large ones', () => {
        expect(commissionPerSideUsd(10, rules)).toBe(1);
        expect(commissionPerSideUsd(400, rules)).toBe(2);
    });

    test('round trip: commissions + one spread crossing + slippage both sides; cost-to-target ratio; unknown spread is flagged', () => {
        // 5 shares at $117 → notional $585; target +3% → gross $17.55
        const est = estimateRoundTrip({ quantity: 5, entry: 117, target: 120.51, spreadPct: 0.1 }, rules);
        expect(est.commissionsUsd).toBe(2);
        expect(est.spreadUsd).toBeCloseTo(0.59, 2);   // 0.585 rounded to cents
        expect(est.slippageUsd).toBeCloseTo(0.59, 2);
        expect(est.totalUsd).toBeCloseTo(3.17, 2);
        expect(est.grossGainUsd).toBeCloseTo(17.55, 2);
        expect(est.costToTargetPct).toBeCloseTo(18.1, 1);
        expect(est.spreadKnown).toBe(true);
        const noSpread = estimateRoundTrip({ quantity: 5, entry: 117, target: 120.51, spreadPct: null }, rules);
        expect(noSpread.spreadKnown).toBe(false);
        expect(noSpread.totalUsd).toBeCloseTo(2.59, 2);
    });

    test('viability: 18% passes at a 20% cap; a 2-share trade fails; a target at entry has nothing to pay from; cap 0 disables', () => {
        expect(costViability(estimateRoundTrip({ quantity: 5, entry: 117, target: 120.51, spreadPct: 0.1 }, rules), rules).ok).toBe(true);
        const tiny = costViability(estimateRoundTrip({ quantity: 2, entry: 117, target: 120.51, spreadPct: 0.1 }, rules), rules);
        expect(tiny.ok).toBe(false);
        expect(tiny.reason).toContain('cost-to-target cap');
        expect(costViability(estimateRoundTrip({ quantity: 5, entry: 117, target: 117, spreadPct: null }, rules), rules).ok).toBe(false);
        expect(costViability(estimateRoundTrip({ quantity: 2, entry: 117, target: 120.51, spreadPct: 0.1 }, rules), { max_cost_to_target_pct: 0 }).ok).toBe(true);
    });
});
