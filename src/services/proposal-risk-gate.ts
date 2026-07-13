/**
 * Proposal risk gate — deterministic enforcement of risk-rules.yaml.
 *
 * The risk_manager tool is advisory (the LLM is *asked* to call it); this
 * gate is mandatory. It runs:
 *
 *   - at proposal CREATION (static checks: price coherence, min price,
 *     min risk/reward, quantity sanity) — a proposal that violates the
 *     rules is never persisted, so it can never be accepted;
 *   - at proposal ACCEPTANCE (context checks: position size vs live
 *     net liquidation, max open positions, max trades per day) — with the
 *     account numbers the executor already has in hand.
 *
 * Pure logic, no IBKR calls: callers supply the context. This keeps the
 * gate unit-testable and free of connection state.
 */

import { getRiskRules, type RiskRules } from '@/tools/ibkr/risk-rules.js';

export interface RiskGateProposal {
    symbol: string;
    direction: 'long' | 'short';
    entryType: 'LMT' | 'MKT';
    /** Entry price. For MKT proposals this is the indicative price used for
     *  risk math (position value, R/R) — execution still happens at market. */
    entry: number | null;
    stop: number;
    target: number;
    quantity: number;
}

export interface RiskGateContext {
    /** Live account net liquidation (USD). Enables max_position_pct check. */
    netLiquidation?: number;
    /** Executed-and-not-yet-closed proposals. Enables max_open_positions. */
    openPositions?: number;
    /** Proposals executed since the start of the ET day. Enables max_daily_trades. */
    executedToday?: number;
}

export interface RiskGateResult {
    ok: boolean;
    violations: string[];
    /** Informational values computed along the way. */
    riskReward: number | null;
    positionValue: number | null;
}

/**
 * Check a proposal against the risk rules. Static checks always run;
 * context checks run only for the context fields provided.
 */
export function checkProposalRisk(
    p: RiskGateProposal,
    ctx: RiskGateContext = {},
    rules: RiskRules = getRiskRules(),
): RiskGateResult {
    const violations: string[] = [];

    // --- Quantity sanity ---
    if (!Number.isInteger(p.quantity) || p.quantity <= 0) {
        violations.push(`quantity must be a positive integer (got ${p.quantity})`);
    }

    // --- Entry price is required (indicative for MKT) ---
    const entry = p.entry;
    if (entry == null || !(entry > 0)) {
        violations.push(
            'entry price is required — for MKT proposals pass the current price as an indicative entry for risk validation',
        );
        return { ok: false, violations, riskReward: null, positionValue: null };
    }

    // --- Price coherence: stop and target on the correct sides ---
    if (p.direction === 'long') {
        if (!(p.stop < entry)) violations.push(`long: stop ${p.stop} must be below entry ${entry}`);
        if (!(p.target > entry)) violations.push(`long: target ${p.target} must be above entry ${entry}`);
    } else {
        if (!(p.stop > entry)) violations.push(`short: stop ${p.stop} must be above entry ${entry}`);
        if (!(p.target < entry)) violations.push(`short: target ${p.target} must be below entry ${entry}`);
    }

    // --- Minimum price (penny-stock filter) ---
    if (entry < rules.min_price) {
        violations.push(`entry $${entry} is below the minimum price $${rules.min_price}`);
    }

    // --- Minimum risk/reward ---
    const risk = Math.abs(entry - p.stop);
    const reward = Math.abs(p.target - entry);
    const riskReward = risk > 0 ? Math.round((reward / risk) * 100) / 100 : null;
    if (riskReward !== null && riskReward < rules.min_risk_reward) {
        violations.push(`risk/reward ${riskReward}:1 is below the minimum ${rules.min_risk_reward}:1`);
    }

    // --- Position size vs account (acceptance-time) ---
    const positionValue = Math.round(p.quantity * entry * 100) / 100;
    if (ctx.netLiquidation !== undefined && ctx.netLiquidation > 0) {
        const maxValue = (rules.max_position_pct / 100) * ctx.netLiquidation;
        if (positionValue > maxValue) {
            const maxShares = Math.floor(maxValue / entry);
            violations.push(
                `position $${positionValue.toFixed(0)} (${p.quantity} × $${entry}) exceeds ` +
                `${rules.max_position_pct}% of net liquidation ($${maxValue.toFixed(0)}) — max ${maxShares} shares`,
            );
        }
    }

    // --- Max open positions (acceptance-time) ---
    if (ctx.openPositions !== undefined && ctx.openPositions >= rules.max_open_positions) {
        violations.push(`${ctx.openPositions} positions already open — max ${rules.max_open_positions}`);
    }

    // --- Max trades per day (acceptance-time) ---
    if (ctx.executedToday !== undefined && ctx.executedToday >= rules.max_daily_trades) {
        violations.push(`${ctx.executedToday} trades already executed today — max ${rules.max_daily_trades}`);
    }

    return { ok: violations.length === 0, violations, riskReward, positionValue };
}

/** Throw with all violations joined unless the proposal passes the gate. */
export function assertProposalRisk(
    p: RiskGateProposal,
    ctx: RiskGateContext = {},
    rules: RiskRules = getRiskRules(),
): void {
    const result = checkProposalRisk(p, ctx, rules);
    if (!result.ok) {
        throw new Error(`[risk-gate] REFUSED ${p.symbol}: ${result.violations.join('; ')}`);
    }
}
