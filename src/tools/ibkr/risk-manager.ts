/**
 * Risk Manager tool — validates a proposed trade against configurable risk
 * rules loaded from src/config/risk-rules.yaml.
 *
 * Returns a pass/fail verdict with details on every rule checked.
 * Does NOT execute trades — advisory only.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { getRiskRules, type RiskRules } from './risk-rules.js';

// Re-exported for existing importers (daily-loss-guard, tests).
export { getRiskRules, type RiskRules } from './risk-rules.js';

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

export const RISK_MANAGER_DESCRIPTION = `
Validate a proposed trade against risk management rules. Checks:
  - Position size vs max allocation
  - Risk/reward ratio vs minimum threshold
  - Stop loss presence
  - Price and liquidity minimums
  - Overnight exposure limits (if holding overnight)

Returns PASS or FAIL with a breakdown of each rule checked.
Does not require IBKR connection — works on the proposed numbers alone.
`.trim();

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RiskManagerSchema = z.object({
    ticker: z
        .string()
        .describe("US equity ticker symbol, e.g. 'AAPL'."),
    direction: z
        .enum(['long', 'short'])
        .describe("Trade direction: 'long' or 'short'."),
    entryPrice: z
        .number()
        .describe('Proposed entry price.'),
    stopPrice: z
        .number()
        .optional()
        .describe('Proposed stop-loss price. Required if mandatory_stop_loss is true.'),
    targetPrice: z
        .number()
        .optional()
        .describe('Proposed target/take-profit price.'),
    shares: z
        .number()
        .optional()
        .describe('Number of shares to trade. If omitted, the tool suggests a position size.'),
    accountValue: z
        .number()
        .optional()
        .describe('Total account value in USD. Used for position sizing. Defaults to $100,000 if not provided.'),
    currentOpenPositions: z
        .number()
        .optional()
        .describe('Number of currently open positions. Used for max-positions check.'),
    holdOvernight: z
        .boolean()
        .default(false)
        .describe('Whether this position will be held overnight.'),
    avgVolume: z
        .number()
        .optional()
        .describe('Average daily volume of the stock.'),
    atr: z
        .number()
        .optional()
        .describe('Current ATR value. Used to suggest stops if none provided.'),
});

// ---------------------------------------------------------------------------
// Validation logic
// ---------------------------------------------------------------------------

interface RuleCheck {
    rule: string;
    passed: boolean;
    detail: string;
}

function validateTrade(input: z.infer<typeof RiskManagerSchema>): {
    verdict: 'PASS' | 'FAIL';
    checks: RuleCheck[];
    suggestedShares: number | null;
    suggestedStop: number | null;
    riskReward: number | null;
    positionValuePct: number | null;
} {
    const rules: RiskRules = getRiskRules();
    const checks: RuleCheck[] = [];
    const accountValue = input.accountValue ?? 100_000;
    let allPassed = true;

    const fail = (rule: string, detail: string) => {
        checks.push({ rule, passed: false, detail });
        allPassed = false;
    };
    const pass = (rule: string, detail: string) => {
        checks.push({ rule, passed: true, detail });
    };

    // --- Min price ---
    if (input.entryPrice < rules.min_price) {
        fail('min_price', `Entry $${input.entryPrice} < min $${rules.min_price}`);
    } else {
        pass('min_price', `Entry $${input.entryPrice} ≥ min $${rules.min_price}`);
    }

    // --- Avg volume ---
    if (input.avgVolume !== undefined) {
        if (input.avgVolume < rules.min_avg_volume) {
            fail('min_avg_volume', `Avg volume ${input.avgVolume.toLocaleString()} < min ${rules.min_avg_volume.toLocaleString()}`);
        } else {
            pass('min_avg_volume', `Avg volume ${input.avgVolume.toLocaleString()} ≥ min ${rules.min_avg_volume.toLocaleString()}`);
        }
    }

    // --- Stop loss presence ---
    let suggestedStop: number | null = null;
    if (rules.mandatory_stop_loss && input.stopPrice === undefined) {
        if (input.atr !== undefined) {
            // Suggest a stop based on ATR
            const offset = input.atr * rules.stop_atr_multiplier;
            suggestedStop = input.direction === 'long'
                ? Math.round((input.entryPrice - offset) * 100) / 100
                : Math.round((input.entryPrice + offset) * 100) / 100;
            fail('mandatory_stop_loss', `No stop provided. Suggested: $${suggestedStop} (${rules.stop_atr_multiplier}× ATR)`);
        } else {
            fail('mandatory_stop_loss', 'No stop-loss provided and no ATR available to suggest one.');
        }
    } else if (input.stopPrice !== undefined) {
        // Verify stop is in the correct direction
        const isLong = input.direction === 'long';
        const stopCorrect = isLong ? input.stopPrice < input.entryPrice : input.stopPrice > input.entryPrice;
        if (!stopCorrect) {
            fail('stop_direction', `Stop $${input.stopPrice} is on the wrong side of entry $${input.entryPrice} for a ${input.direction} trade.`);
        } else {
            pass('mandatory_stop_loss', `Stop $${input.stopPrice} provided and correctly placed.`);
        }
    }

    // --- Risk/reward ratio ---
    let riskReward: number | null = null;
    const stopForCalc = input.stopPrice ?? suggestedStop;
    if (input.targetPrice !== undefined && stopForCalc != null) {
        const risk = Math.abs(input.entryPrice - stopForCalc);
        const reward = Math.abs(input.targetPrice - input.entryPrice);
        riskReward = risk > 0 ? Math.round((reward / risk) * 100) / 100 : null;
        if (riskReward !== null) {
            if (riskReward < rules.min_risk_reward) {
                fail('min_risk_reward', `R/R ${riskReward}:1 < min ${rules.min_risk_reward}:1`);
            } else {
                pass('min_risk_reward', `R/R ${riskReward}:1 ≥ min ${rules.min_risk_reward}:1`);
            }
        }
    }

    // --- Position sizing ---
    const maxPositionValue = accountValue * (rules.max_position_pct / 100);
    let suggestedShares: number | null = null;

    if (input.shares !== undefined) {
        const positionValue = input.shares * input.entryPrice;
        const positionPct = (positionValue / accountValue) * 100;
        if (positionPct > rules.max_position_pct) {
            const maxShares = Math.floor(maxPositionValue / input.entryPrice);
            fail('max_position_pct', `Position ${positionPct.toFixed(1)}% (${input.shares} shares × $${input.entryPrice}) > max ${rules.max_position_pct}%. Max shares: ${maxShares}`);
        } else {
            pass('max_position_pct', `Position ${positionPct.toFixed(1)}% ≤ max ${rules.max_position_pct}%`);
        }
    } else {
        // Suggest position size based on risk if stop is known
        if (stopForCalc != null) {
            const riskPerShare = Math.abs(input.entryPrice - stopForCalc);
            const maxRiskDollars = accountValue * (rules.max_daily_loss_pct / 100) * 0.25; // risk 25% of daily limit per trade
            const sharesByRisk = riskPerShare > 0 ? Math.floor(maxRiskDollars / riskPerShare) : 0;
            const sharesBySize = Math.floor(maxPositionValue / input.entryPrice);
            suggestedShares = Math.min(sharesByRisk, sharesBySize);
            pass('position_size', `Suggested: ${suggestedShares} shares ($${(suggestedShares * input.entryPrice).toFixed(0)}, ${((suggestedShares * input.entryPrice / accountValue) * 100).toFixed(1)}% of account)`);
        } else {
            suggestedShares = Math.floor(maxPositionValue / input.entryPrice);
            pass('position_size', `Suggested (max allocation): ${suggestedShares} shares ($${(suggestedShares * input.entryPrice).toFixed(0)})`);
        }
    }

    // --- Max open positions ---
    if (input.currentOpenPositions !== undefined) {
        if (input.currentOpenPositions >= rules.max_open_positions) {
            fail('max_open_positions', `${input.currentOpenPositions} open ≥ max ${rules.max_open_positions}`);
        } else {
            pass('max_open_positions', `${input.currentOpenPositions} open < max ${rules.max_open_positions}`);
        }
    }

    // --- Overnight exposure ---
    if (input.holdOvernight) {
        const overnightMaxPct = rules.max_overnight_position_pct;
        const posValue = (input.shares ?? suggestedShares ?? 0) * input.entryPrice;
        const posValuePct = (posValue / accountValue) * 100;
        if (posValuePct > overnightMaxPct) {
            const maxOvernightShares = Math.floor((accountValue * overnightMaxPct / 100) / input.entryPrice);
            fail('max_overnight_position_pct', `Overnight position ${posValuePct.toFixed(1)}% > max ${overnightMaxPct}%. Reduce to ${maxOvernightShares} shares.`);
        } else {
            pass('max_overnight_position_pct', `Overnight position ${posValuePct.toFixed(1)}% ≤ max ${overnightMaxPct}%`);
        }
    }

    const effectiveShares = input.shares ?? suggestedShares ?? 0;
    const positionValuePct = accountValue > 0
        ? Math.round(((effectiveShares * input.entryPrice) / accountValue) * 10000) / 100
        : null;

    return {
        verdict: allPassed ? 'PASS' : 'FAIL',
        checks,
        suggestedShares: input.shares === undefined ? suggestedShares : null,
        suggestedStop: input.stopPrice === undefined ? suggestedStop : null,
        riskReward,
        positionValuePct,
    };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createRiskManager() {
    return new DynamicStructuredTool({
        name: 'risk_manager',
        description:
            'Validate a proposed trade against risk management rules (position size, R/R ratio, stop loss, overnight limits). Returns PASS/FAIL with details.',
        schema: RiskManagerSchema,
        func: async (input) => {
            const result = validateTrade(input);
            return formatToolResult({
                ticker: input.ticker.trim().toUpperCase(),
                direction: input.direction,
                entryPrice: input.entryPrice,
                stopPrice: input.stopPrice ?? result.suggestedStop,
                targetPrice: input.targetPrice ?? null,
                holdOvernight: input.holdOvernight,
                ...result,
            });
        },
    });
}
