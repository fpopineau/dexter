/**
 * Position sizer — deterministic, confidence-weighted share sizing.
 *
 * Prep for the small live account (~€3.7K vs the $1M paper account): the
 * LLM should not guess quantities. When a proposal omits quantity, this
 * sizer computes it from three things the operator controls:
 *
 *   risk budget   = netLiquidation × max_risk_per_trade_pct
 *   confidence    = multiplier from the proposal's score (full / half / low
 *                   bands in risk-rules; unscored gets the low multiplier)
 *   stop distance = |entry − stop| (the structural stop the gates enforce)
 *
 *   quantity = floor(budget × confidence / stopDistance),
 *              capped by max_position_pct of the account.
 *
 * Whole shares only — dexter's gates, brackets and tracker assume integer
 * quantities (fractional support is a separate project). A trade the
 * account cannot afford at these rules is REFUSED with the reason, never
 * silently shrunk below viability: min_risk_budget_usd stops trades whose
 * weighted budget is so small that commissions and spread eat the edge.
 *
 * NOTE on currency: netLiquidation is in the account's base currency (EUR
 * for this account) while US prices are USD. The ~5-10% EUR/USD deviation
 * is well inside the sizing bands' tolerance; a precise FX conversion can
 * be added when it matters.
 */

import { getRiskRules, type RiskRules } from '@/tools/ibkr/risk-rules.js';

export interface SizeInput {
    entry: number;
    stop: number;
    /** Proposal confidence score (0–150); null/undefined = unscored. */
    score?: number | null;
    /** Account net liquidation (base currency). */
    netLiquidation: number;
}

export interface SizeResult {
    /** Whole shares to trade, or null when the trade is not viable. */
    quantity: number | null;
    /** Confidence multiplier applied (for logs/messages). */
    multiplier: number;
    /** Weighted risk budget in account currency. */
    riskBudget: number;
    /** Why quantity is null — actionable, shown to the proposing model. */
    reason?: string;
}

/** IBKR fractional resolution: 4 decimal places, minimum 0.0001 share. */
export const FRACTIONAL_STEP = 0.0001;

/**
 * Is `qty` a placeable share quantity under the active rules?
 * Whole-share mode: positive integers. Fractional mode: positive decimals
 * at IBKR's 0.0001 resolution (finer silently fails at the broker).
 * Shared by the risk gate and the bracket placer so the two can never
 * disagree about what is orderable.
 */
export function isValidQuantity(qty: number, fractional: boolean): boolean {
    if (!Number.isFinite(qty) || !(qty > 0)) return false;
    if (!fractional) return Number.isInteger(qty);
    const scaled = qty / FRACTIONAL_STEP;
    return qty >= FRACTIONAL_STEP && Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** Round a computed quantity DOWN to what is placeable under the rules. */
export function floorToPlaceable(qty: number, fractional: boolean): number {
    if (!fractional) return Math.floor(qty);
    return Math.floor(qty / FRACTIONAL_STEP + 1e-9) * FRACTIONAL_STEP;
}

/** Confidence multiplier from the score bands in the risk rules. */
export function confidenceMultiplier(score: number | null | undefined, rules: RiskRules = getRiskRules()): number {
    if (score == null || !Number.isFinite(score)) return rules.sizing_low_mult;
    if (score >= rules.sizing_full_score) return 1;
    if (score >= rules.sizing_half_score) return rules.sizing_half_mult;
    return rules.sizing_low_mult;
}

/** Compute the whole-share quantity for a proposal, or refuse with a reason. */
export function computeQuantity(input: SizeInput, rules: RiskRules = getRiskRules()): SizeResult {
    const stopDistance = Math.abs(input.entry - input.stop);
    const multiplier = confidenceMultiplier(input.score, rules);
    const fullBudget = (rules.max_risk_per_trade_pct / 100) * input.netLiquidation;
    const riskBudget = Math.round(fullBudget * multiplier * 100) / 100;

    if (!(input.entry > 0) || !(stopDistance > 0)) {
        return { quantity: null, multiplier, riskBudget, reason: 'entry and stop must be positive and distinct' };
    }
    if (!(input.netLiquidation > 0)) {
        return { quantity: null, multiplier, riskBudget, reason: 'account net liquidation unavailable — pass an explicit quantity' };
    }

    if (rules.min_risk_budget_usd > 0 && riskBudget < rules.min_risk_budget_usd) {
        return {
            quantity: null, multiplier, riskBudget,
            reason:
                `confidence-weighted risk budget $${riskBudget.toFixed(0)} is below the ` +
                `$${rules.min_risk_budget_usd} account floor — commissions and spread would eat the edge. ` +
                `Only propose higher-conviction setups (score ≥ ${rules.sizing_full_score}) at this account size`,
        };
    }

    const fractional = rules.fractional_shares;
    const maxPositionValue = (rules.max_position_pct / 100) * input.netLiquidation;
    const byRisk = floorToPlaceable(riskBudget / stopDistance, fractional);
    const byCap = floorToPlaceable(maxPositionValue / input.entry, fractional);
    const quantity = Math.min(byRisk, byCap);
    const minQty = fractional ? FRACTIONAL_STEP : 1;

    if (quantity < minQty) {
        const maxAffordableEntry = Math.floor(maxPositionValue * 100) / 100;
        const unit = fractional ? `${FRACTIONAL_STEP} share` : 'one share';
        return {
            quantity: null, multiplier, riskBudget,
            reason: byCap < minQty
                ? `${unit} at $${input.entry} exceeds the ${rules.max_position_pct}% position cap ` +
                  `($${maxAffordableEntry.toFixed(0)}) — the account cannot afford this symbol; pick one under that price`
                : `the $${riskBudget.toFixed(0)} risk budget does not cover ${unit}'s stop distance ` +
                  `($${stopDistance.toFixed(2)}) — tighten to real structure closer in, or skip`,
        };
    }

    // toFixed(4) clears float dust from the resolution math (e.g. 1.4799999…).
    return { quantity: fractional ? Number(quantity.toFixed(4)) : quantity, multiplier, riskBudget };
}
