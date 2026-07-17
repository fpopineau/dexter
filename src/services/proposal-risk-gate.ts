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
    entryType: 'LMT' | 'MKT' | 'STP_LMT';
    /** Entry price. For MKT proposals this is the indicative price used for
     *  risk math (position value, R/R); for STP_LMT it is the TRIGGER. */
    entry: number | null;
    /** STP_LMT only: the limit cap for the triggered entry. */
    entryLimit?: number | null;
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
    /** Daily ATR(14) for the symbol (USD). Enables the noise-stop check —
     *  fetched server-side at creation, never trusted from the LLM. */
    dailyAtr?: number;
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

    // --- STP_LMT: the limit cap must sit beyond the trigger, inside the target ---
    if (p.entryType === 'STP_LMT') {
        const cap = p.entryLimit;
        if (cap == null || !(cap > 0)) {
            violations.push('STP_LMT entries require entryLimit (the limit cap beyond the trigger)');
        } else if (p.direction === 'long') {
            if (!(cap >= entry)) violations.push(`long STP_LMT: entryLimit ${cap} must be at or above the trigger ${entry}`);
            if (!(p.target > cap)) violations.push(`long STP_LMT: target ${p.target} must be above the limit cap ${cap}`);
        } else {
            if (!(cap <= entry)) violations.push(`short STP_LMT: entryLimit ${cap} must be at or below the trigger ${entry}`);
            if (!(p.target < cap)) violations.push(`short STP_LMT: target ${p.target} must be below the limit cap ${cap}`);
        }
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

    // --- Stop distance vs daily ATR (noise-stop filter) ---
    // Every early live loss exited via stop: stops placed at 0.13–0.3× the
    // daily ATR sit inside ordinary intraday noise and get hit regardless
    // of whether the idea was right.
    if (ctx.dailyAtr !== undefined && ctx.dailyAtr > 0 && risk > 0) {
        const minStop = rules.min_stop_atr_fraction * ctx.dailyAtr;
        if (risk < minStop) {
            violations.push(
                `stop is $${risk.toFixed(2)} from entry — inside intraday noise for a stock with daily ` +
                `ATR $${ctx.dailyAtr.toFixed(2)} (minimum ${rules.min_stop_atr_fraction}× ATR = $${minStop.toFixed(2)}). ` +
                `Place the stop at real structure at least that far away (and resize), or skip the trade`,
            );
        }
    }

    // --- Risk budget per trade (needs net liquidation) ---
    // Normalizes what a stop-out costs: quantity × stop distance may not
    // exceed max_risk_per_trade_pct of the account.
    if (ctx.netLiquidation !== undefined && ctx.netLiquidation > 0 && risk > 0) {
        const riskDollars = Math.round(p.quantity * risk * 100) / 100;
        const maxRisk = (rules.max_risk_per_trade_pct / 100) * ctx.netLiquidation;
        if (riskDollars > maxRisk) {
            const maxShares = Math.floor(maxRisk / risk);
            violations.push(
                `a stop-out would cost $${riskDollars.toFixed(0)} (${p.quantity} × $${risk.toFixed(2)} stop distance) — ` +
                `over the ${rules.max_risk_per_trade_pct}% risk budget ($${maxRisk.toFixed(0)}); max ${maxShares} shares at these levels`,
            );
        }
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

// ---------------------------------------------------------------------------
// Price-run (chase/invalidation) check — used at ACCEPTANCE time with a
// live quote. Pure so it is unit-testable.
// ---------------------------------------------------------------------------

/** Fraction of the entry→target distance the price may consume before an
 *  accept counts as chasing. */
export const CHASE_FRACTION = 0.25;

export interface PriceRunResult {
    ok: boolean;
    reason?: string;
}

/**
 * Given a live price, decide whether accepting this proposal still makes
 * sense: refuse when the price has already consumed more than
 * CHASE_FRACTION of the edge (chasing), or has traded through the stop
 * (the setup is invalidated).
 */
export function checkPriceRun(
    p: Pick<RiskGateProposal, 'direction' | 'entry' | 'stop' | 'target'>,
    lastPrice: number,
): PriceRunResult {
    const entry = p.entry;
    if (entry == null || !(lastPrice > 0)) return { ok: true };

    if (p.direction === 'long') {
        if (lastPrice <= p.stop) {
            return { ok: false, reason: `setup invalidated: last ${lastPrice} is at/through the stop ${p.stop}` };
        }
        const chaseLine = entry + CHASE_FRACTION * (p.target - entry);
        if (lastPrice >= chaseLine) {
            return {
                ok: false,
                reason: `price has run: last ${lastPrice} vs entry ${entry} — already past ` +
                    `${Math.round(CHASE_FRACTION * 100)}% of the way to target ${p.target} (chasing)`,
            };
        }
    } else {
        if (lastPrice >= p.stop) {
            return { ok: false, reason: `setup invalidated: last ${lastPrice} is at/through the stop ${p.stop}` };
        }
        const chaseLine = entry - CHASE_FRACTION * (entry - p.target);
        if (lastPrice <= chaseLine) {
            return {
                ok: false,
                reason: `price has run: last ${lastPrice} vs entry ${entry} — already past ` +
                    `${Math.round(CHASE_FRACTION * 100)}% of the way to target ${p.target} (chasing)`,
            };
        }
    }
    return { ok: true };
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
