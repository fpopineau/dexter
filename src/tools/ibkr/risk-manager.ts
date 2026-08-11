/**
 * Risk Manager tool — validates a proposed trade against configurable risk
 * rules loaded from src/config/risk-rules.yaml.
 *
 * Returns a pass/fail verdict with details on every rule checked.
 * Does NOT execute trades — advisory only; the deterministic gate at
 * creation/acceptance is the authority.
 *
 * Sizing suggestions delegate to the SAME position-sizer the executor
 * runs, against the LIVE account value (fetched server-side, best
 * effort). Until 2026-08-11 this tool sized from its own formula
 * (0.25 × max_daily_loss_pct = 2× the real per-trade budget) against a
 * $100K placeholder account — every narrated size disagreed with the
 * executed size, exactly the mismatch that erodes trust in an alert.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getNetLiquidation } from '@/services/daily-loss-guard.js';
import { computeQuantity } from '@/services/position-sizer.js';
import { formatToolResult } from '../types.js';
import { getRiskRules, type RiskRules } from './risk-rules.js';

// Re-exported for existing importers (daily-loss-guard, tests).
export { getRiskRules, type RiskRules } from './risk-rules.js';

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

export const RISK_MANAGER_DESCRIPTION = `
Validate a proposed trade against risk management rules (ADVISORY — the
deterministic gate at creation/acceptance is the authority). Checks:
  - Position size vs max allocation
  - Risk/reward ratio vs minimum threshold
  - Stop loss presence
  - Price and liquidity minimums
  - Per-position overnight cap (if holding overnight)

Sizing suggestions use the SAME position sizer the executor runs
(class budget × confidence multiplier ÷ risk per share) against the
LIVE account value — pass the proposal's score and tradeClass to
preview what the sizer will compute at acceptance. When the account
value cannot be verified (IBKR down, no accountValue given), the
account-relative checks are SKIPPED and say so — never validated
against a placeholder.

Returns PASS or FAIL with a breakdown of each rule checked.
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
        .coerce.number()
        .describe('Proposed entry price.'),
    stopPrice: z
        .coerce.number()
        .optional()
        .describe('Proposed stop-loss price. Required if mandatory_stop_loss is true.'),
    targetPrice: z
        .coerce.number()
        .optional()
        .describe('Proposed target/take-profit price.'),
    shares: z
        .coerce.number()
        .optional()
        .describe('Number of shares to trade. If omitted, the tool suggests a position size.'),
    accountValue: z
        .coerce.number()
        .optional()
        .describe('FALLBACK account value in USD, used only when the live IBKR net liquidation cannot be fetched. Never defaults — without either, account-relative checks are skipped and reported as such.'),
    score: z
        .coerce.number()
        .optional()
        .describe("The proposal's confidence score (0–100+). Feeds the sizer's confidence multiplier so the suggestion matches what acceptance will compute. Omitted = sized as unscored (lowest multiplier)."),
    tradeClass: z
        .enum(['intraday', 'swing', 'earnings-bet'])
        .optional()
        .describe("Trade class; selects the risk budget the sizer uses (default 'intraday')."),
    worstCaseGapPct: z
        .coerce.number()
        .optional()
        .describe('Earnings bets only: the assumed adverse post-print gap (%) — the sizer sizes against it, not the stop.'),
    currentOpenPositions: z
        .coerce.number()
        .optional()
        .describe('Number of currently open positions. Used for max-positions check.'),
    holdOvernight: z
        .boolean()
        .default(false)
        .describe('Whether this position will be held overnight.'),
    avgVolume: z
        .coerce.number()
        .optional()
        .describe('Average daily volume of the stock.'),
    atr: z
        .coerce.number()
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

/** Exported for tests: pure validation against a RESOLVED account value
 *  (null = unavailable → account-relative checks are skipped, visibly). */
export function validateTrade(
    input: z.infer<typeof RiskManagerSchema>,
    accountValue: number | null,
    rules: RiskRules = getRiskRules(),
): {
    verdict: 'PASS' | 'FAIL';
    checks: RuleCheck[];
    /** Account-relative checks that could NOT be evaluated — a PASS
     *  verdict does not cover these. */
    skipped: string[];
    suggestedShares: number | null;
    suggestedStop: number | null;
    riskReward: number | null;
    positionValuePct: number | null;
} {
    const checks: RuleCheck[] = [];
    const skipped: string[] = [];
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

    // --- Account-relative checks: only against a REAL account value ---
    let suggestedShares: number | null = null;
    if (accountValue === null || !(accountValue > 0)) {
        skipped.push(
            'position sizing, max_position_pct and the overnight check were SKIPPED — the live account ' +
            'value could not be verified and no accountValue was supplied. A PASS here does NOT cover them.',
        );
    } else {
        const maxPositionValue = accountValue * (rules.max_position_pct / 100);

        if (input.shares !== undefined) {
            const positionValue = input.shares * input.entryPrice;
            const positionPct = (positionValue / accountValue) * 100;
            if (positionPct > rules.max_position_pct) {
                const maxShares = Math.floor(maxPositionValue / input.entryPrice);
                fail('max_position_pct', `Position ${positionPct.toFixed(1)}% (${input.shares} shares × $${input.entryPrice}) > max ${rules.max_position_pct}%. Max shares: ${maxShares}`);
            } else {
                pass('max_position_pct', `Position ${positionPct.toFixed(1)}% ≤ max ${rules.max_position_pct}%`);
            }
        } else if (stopForCalc != null) {
            // THE sizer, not a lookalike: class budget × confidence
            // multiplier ÷ risk per share (gap for earnings bets), then the
            // position-value cap — the suggestion previews what acceptance
            // will compute from the same inputs.
            const size = computeQuantity({
                entry: input.entryPrice,
                stop: stopForCalc,
                score: input.score ?? null,
                netLiquidation: accountValue,
                tradeClass: input.tradeClass,
                worstCaseGapPct: input.worstCaseGapPct ?? null,
            }, rules);
            if (size.quantity === null) {
                fail('position_size', `the position sizer refuses: ${size.reason ?? 'not viable at these levels'}`);
            } else {
                // The sizer already applies the max_position_pct cap itself.
                suggestedShares = size.quantity;
                pass('position_size',
                    `Suggested ${suggestedShares} shares ($${(suggestedShares * input.entryPrice).toFixed(0)}, ` +
                    `${((suggestedShares * input.entryPrice / accountValue) * 100).toFixed(1)}% of account) — same math the ` +
                    `executor's sizer runs: ${input.tradeClass ?? 'intraday'} budget $${size.riskBudget.toFixed(0)} at ` +
                    `confidence ×${size.multiplier}`);
            }
        } else {
            // No stop: only the allocation ceiling can be stated — and it is
            // a CEILING, not a size. The stop defines the trade.
            suggestedShares = Math.floor(maxPositionValue / input.entryPrice);
            pass('position_size', `No stop given — $${maxPositionValue.toFixed(0)} (${suggestedShares} shares) is the max_position_pct CEILING, not a suggested size; the sizer needs the stop`);
        }

        // --- Overnight exposure (per-position; the total book cap is
        // enforced by the acceptance gate) ---
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
    }

    // --- Max open positions ---
    if (input.currentOpenPositions !== undefined) {
        if (input.currentOpenPositions >= rules.max_open_positions) {
            fail('max_open_positions', `${input.currentOpenPositions} open ≥ max ${rules.max_open_positions}`);
        } else {
            pass('max_open_positions', `${input.currentOpenPositions} open < max ${rules.max_open_positions}`);
        }
    }

    const effectiveShares = input.shares ?? suggestedShares ?? 0;
    const positionValuePct = accountValue !== null && accountValue > 0
        ? Math.round(((effectiveShares * input.entryPrice) / accountValue) * 10000) / 100
        : null;

    return {
        verdict: allPassed ? 'PASS' : 'FAIL',
        checks,
        skipped,
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
            'Validate a proposed trade against risk management rules (position size via the real sizer + live account, R/R ratio, stop loss, overnight limit). Advisory; returns PASS/FAIL with details.',
        schema: RiskManagerSchema,
        func: async (input) => {
            // Live account value first (server-side, best effort); the
            // caller-supplied number is only a fallback for a dead
            // connection. There is deliberately no placeholder default —
            // sizing against a fictional account is worse than saying
            // "could not verify".
            const liveNetLiq = await getNetLiquidation();
            const accountValue = liveNetLiq ?? input.accountValue ?? null;
            const result = validateTrade(input, accountValue);
            return formatToolResult({
                ticker: input.ticker.trim().toUpperCase(),
                direction: input.direction,
                entryPrice: input.entryPrice,
                stopPrice: input.stopPrice ?? result.suggestedStop,
                targetPrice: input.targetPrice ?? null,
                holdOvernight: input.holdOvernight,
                accountValue,
                accountValueSource: liveNetLiq !== null
                    ? 'ibkr-live'
                    : input.accountValue !== undefined ? 'caller-supplied (live NetLiq unavailable)' : 'unavailable',
                ...result,
            });
        },
    });
}
