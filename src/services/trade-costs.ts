/**
 * Trade costs (REQ-SIZE-003, WP6; AUD-01 cost dimension).
 *
 * A 2:1 ratio on a $585 position is not an edge once commissions, the spread
 * and slippage are paid: at +3 % the gross gain is $17.55 and two $1
 * commissions alone are 11 % of it. The sizer prices the round trip at
 * creation and refuses when the estimate exceeds `max_cost_to_target_pct`
 * of the gross gain at the target.
 *
 * Model (IBKR fixed tier, the simulator's assumption):
 *   commission per side = max(commission_min_usd, qty × commission_per_share_usd)
 *   spread crossing     = qty × entry × spread% (half at entry, half at exit)
 *   slippage            = 2 × qty × entry × slippage_bps / 10,000
 * A missing spread (no live quote) is not zero: the estimate says so and
 * counts commissions + slippage only; the observed twin slippage (simulator)
 * is the source that will calibrate `slippage_bps` later.
 */

import type { RiskRules } from '@/tools/ibkr/risk-rules.js';

export interface CostEstimate {
    commissionsUsd: number;
    spreadUsd: number;
    slippageUsd: number;
    totalUsd: number;
    grossGainUsd: number;
    /** total / gross gain × 100; null when the gain is not positive. */
    costToTargetPct: number | null;
    spreadKnown: boolean;
}

export function commissionPerSideUsd(quantity: number, rules: Pick<RiskRules, 'commission_per_share_usd' | 'commission_min_usd'>): number {
    return Math.max(rules.commission_min_usd, quantity * rules.commission_per_share_usd);
}

export function estimateRoundTrip(
    input: { quantity: number; entry: number; target: number; spreadPct: number | null | undefined },
    rules: Pick<RiskRules, 'commission_per_share_usd' | 'commission_min_usd' | 'slippage_bps'>,
): CostEstimate {
    const q = Math.max(0, input.quantity);
    const notional = q * input.entry;
    const commissionsUsd = 2 * commissionPerSideUsd(q, rules);
    const spreadKnown = typeof input.spreadPct === 'number' && Number.isFinite(input.spreadPct) && input.spreadPct >= 0;
    const spreadUsd = spreadKnown ? notional * ((input.spreadPct as number) / 100) : 0;
    const slippageUsd = 2 * notional * (rules.slippage_bps / 10_000);
    const totalUsd = commissionsUsd + spreadUsd + slippageUsd;
    const grossGainUsd = q * Math.abs(input.target - input.entry);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
        commissionsUsd: r2(commissionsUsd),
        spreadUsd: r2(spreadUsd),
        slippageUsd: r2(slippageUsd),
        totalUsd: r2(totalUsd),
        grossGainUsd: r2(grossGainUsd),
        costToTargetPct: grossGainUsd > 0 ? Math.round((totalUsd / grossGainUsd) * 1000) / 10 : null,
        spreadKnown,
    };
}

/** REQ-SIZE-003: is the trade worth its costs under the configured ratio? */
export function costViability(est: CostEstimate, rules: Pick<RiskRules, 'max_cost_to_target_pct'>): { ok: boolean; reason?: string } {
    if (!(rules.max_cost_to_target_pct > 0)) return { ok: true };
    if (est.costToTargetPct === null) return { ok: false, reason: 'the target offers no gross gain over the entry — nothing to pay costs from' };
    if (est.costToTargetPct > rules.max_cost_to_target_pct) {
        return {
            ok: false,
            reason:
                `estimated round-trip costs $${est.totalUsd.toFixed(2)} (commissions $${est.commissionsUsd.toFixed(2)}, ` +
                `spread ${est.spreadKnown ? `$${est.spreadUsd.toFixed(2)}` : 'unknown'}, slippage $${est.slippageUsd.toFixed(2)}) are ` +
                `${est.costToTargetPct.toFixed(1)}% of the $${est.grossGainUsd.toFixed(2)} gross gain at target — over the ` +
                `${rules.max_cost_to_target_pct}% cost-to-target cap; a wider target, a larger (affordable) size, or skip`,
        };
    }
    return { ok: true };
}
