/**
 * Trade proposal tools.
 *
 * `trade_proposals` (safe): create / list / get / reject — lets the agent
 * register actionable recommendations and inspect their lifecycle. Creating
 * a proposal NEVER trades; it just persists a human-actionable record.
 *
 * `accept_proposal` (approval-gated, in TOOLS_REQUIRING_APPROVAL): executes
 * an open proposal as a paper bracket order through the deterministic
 * executor (safety lock + daily-loss kill-switch). In headless contexts
 * (cron/gateway agent runs) approval is auto-denied, so only an interactive
 * human confirmation — or the WhatsApp command router — can execute.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { acceptProposal, autoExecuteProposal, isAutoExecuteEnabled } from '@/services/proposal-executor.js';
import {
    createProposal,
    formatPerformanceReport,
    formatProposalLine,
    getPerformanceSummary,
    getProposal,
    listProposals,
} from '@/services/trade-proposals.js';
import { rejectProposal } from '@/services/proposal-executor.js';
import { fetchDailyRiskContext } from '../ibkr/daily-atr.js';
import { formatToolResult } from '../types.js';
import { logger } from '@/utils';

export const TRADE_PROPOSALS_DESCRIPTION = `
Manage trade proposals — persisted, human-actionable trade recommendations.

**create** — register a recommendation (symbol, direction, entryType LMT/MKT, entry,
  stop, target, quantity, score, rationale, expiresMinutes default 120). Creating a
  proposal does NOT trade. The entry price is REQUIRED even for MKT proposals (pass the
  current price — it anchors deterministic risk validation; execution is still at market).
  Every proposal passes a mandatory risk gate (min risk/reward, min price, coherent
  stop/target) — a rejected create returns the violations; fix the numbers, don't fight it.
  Always include the returned proposal id in your answer, with the instruction
  "reply 'accept <ID>' to execute (paper)".
**list** — list proposals (status filter: open/executed/closed/rejected/expired/failed; default open).
**get** — fetch one proposal by id.
**reject** — mark an open proposal rejected (risk-reducing, always allowed).
**performance** — closed-trade outcomes over the last N days (default 7): wins/losses,
  win rate, gross/net P&L, best/worst, exit reasons. Use it for daily recaps.

Execution is human-only: the accept_proposal tool requires interactive approval, and
WhatsApp users execute by replying 'accept <ID>'. Prices must be coherent: for long,
stop < entry < target; for short, target < entry < stop.
`.trim();

export const ACCEPT_PROPOSAL_DESCRIPTION = `
Execute an OPEN trade proposal as a paper bracket order (entry + OCA stop/target).

Requires interactive user approval (TOOLS_REQUIRING_APPROVAL) — in headless runs it is
auto-denied by design. Passes through the paper/live safety lock and the daily-loss
kill-switch before any order is placed. Use trade_proposals (action get/list) first to
verify what will be executed.
`.trim();

const CreateSchema = z.object({
    action: z.literal('create'),
    symbol: z.string().describe("US equity ticker, e.g. 'AAPL'."),
    direction: z.enum(['long', 'short']),
    entryType: z.enum(['LMT', 'MKT', 'STP_LMT']).default('LMT')
        .describe('LMT: limit entry (mean-reversion — waits for a pullback). MKT: enter at market. STP_LMT: MOMENTUM entry — triggers at `entry` and fills up to `entryLimit`; use for continuation setups on fast movers, where a below-market limit would never fill.'),
    entry: z.coerce.number().positive()
        .describe('Entry price. LMT: the limit. MKT: current price (indicative, risk validation). STP_LMT: the TRIGGER price (above market for longs).'),
    entryLimit: z.coerce.number().positive().optional()
        .describe('STP_LMT only: the limit cap for the triggered entry (slightly beyond the trigger, e.g. trigger +0.3–0.6%).'),
    stop: z.coerce.number().positive()
        .describe('Stop-loss price at REAL STRUCTURE (low of day, pullback low, VWAP). The gate refuses stops closer than 0.4× the daily ATR — inside intraday noise, they fill on randomness.'),
    target: z.coerce.number().positive()
        .describe('Take-profit at a real objective (prior high, measured move). Do NOT derive it as entry + 2× stop distance to satisfy the R/R gate — if an honest target is not ≥2× the stop distance away, skip the trade.'),
    quantity: z.coerce.number().int().positive()
        .describe('Number of shares. Size from the risk budget: shares ≈ (0.25% of account) / (entry − stop). At acceptance the gate refuses if a stop-out would cost more than the budget.'),
    tif: z.enum(['DAY', 'GTC']).default('DAY')
        .describe("Bracket time-in-force. Use 'GTC' for overnight/swing setups so the stop and target SURVIVE the market close; 'DAY' brackets expire at the bell and can leave a filled position unprotected overnight."),
    score: z.coerce.number().min(0).max(150).optional().describe('Signal/composite score backing this proposal.'),
    rationale: z.string().min(5).describe('One or two sentences: why this trade, catalyst, risk note.'),
    expiresMinutes: z.coerce.number().int().positive().max(24 * 60).default(120)
        .describe('Validity window in minutes. Defaults to 120.'),
});

const ListSchema = z.object({
    action: z.literal('list'),
    status: z.enum(['open', 'executed', 'closed', 'rejected', 'expired', 'failed']).optional()
        .describe('Filter by status. Omit for all (recent first).'),
});

const GetSchema = z.object({
    action: z.literal('get'),
    id: z.string().describe("Proposal id, e.g. 'P-3F2A'."),
});

const RejectSchema = z.object({
    action: z.literal('reject'),
    id: z.string().describe('Proposal id to reject.'),
});

const PerformanceSchema = z.object({
    action: z.literal('performance'),
    days: z.coerce.number().int().positive().max(365).default(7)
        .describe('Look-back window in days for closed-trade outcomes. Defaults to 7.'),
});

const ProposalsSchema = z.discriminatedUnion('action', [CreateSchema, ListSchema, GetSchema, RejectSchema, PerformanceSchema]);

function coherent(input: z.infer<typeof CreateSchema>): string | null {
    if (input.direction === 'long' && !(input.stop < input.entry && input.entry < input.target)) {
        return 'long proposal requires stop < entry < target';
    }
    if (input.direction === 'short' && !(input.target < input.entry && input.entry < input.stop)) {
        return 'short proposal requires target < entry < stop';
    }
    return null;
}

export function createTradeProposalsTool() {
    return new DynamicStructuredTool({
        name: 'trade_proposals',
        description:
            'Create, list, get, or reject persisted trade proposals. Creating never trades; execution is human-only.',
        schema: ProposalsSchema,
        func: async (input) => {
            switch (input.action) {
                case 'create': {
                    const problem = coherent(input);
                    if (problem) return formatToolResult({ error: problem });
                    try {
                        // Server-side daily ATR + EMA10 for the noise-stop
                        // and extension checks — never taken from the model.
                        // Fail-open (nulls skip the checks).
                        const { dailyAtr, ema10 } = await fetchDailyRiskContext(input.symbol);
                        const p = await createProposal({
                            symbol: input.symbol,
                            direction: input.direction,
                            entryType: input.entryType,
                            entry: input.entry,
                            entryLimit: input.entryLimit,
                            stop: input.stop,
                            target: input.target,
                            quantity: input.quantity,
                            tif: input.tif,
                            score: input.score,
                            rationale: input.rationale,
                            source: 'agent',
                            expiresMinutes: input.expiresMinutes,
                        }, {
                            ...(dailyAtr != null ? { dailyAtr } : {}),
                            ...(ema10 != null ? { ema10 } : {}),
                        });

                        // Paper-only auto-execution (AUTO_EXECUTE_PAPER=true):
                        // attempted for EVERY proposal source — the executor
                        // itself gates on score, daily cap, and paper port.
                        // A refusal simply leaves the proposal open for a
                        // manual 'accept'.
                        let autoExecution: { ok: boolean; message: string } | undefined;
                        if (isAutoExecuteEnabled()) {
                            autoExecution = await autoExecuteProposal(p.id);
                        }
                        return formatToolResult({
                            created: p,
                            ...(autoExecution ? { autoExecution } : {}),
                            userInstruction: autoExecution?.ok
                                ? `${p.id} was AUTO-EXECUTED on paper (score ${p.score}) — the bracket is working; the outcome will be tracked and alerted. Tell the user this explicitly.`
                                : `Reply 'accept ${p.id}' to execute on paper, or 'reject ${p.id}'. Expires ${new Date(p.expiresAt).toISOString()}.`,
                        });
                    } catch (err) {
                        // Risk-gate refusal: return the violations so the numbers
                        // can be corrected — do not weaken them to force a trade.
                        // Logged too: refused creates leave no DB row, so without
                        // this line they are invisible in post-hoc diagnosis.
                        const msg = err instanceof Error ? err.message : String(err);
                        logger.warn(`[trade-proposals] create refused: ${input.symbol} ${input.direction} ${input.entryType} @${input.entry} stop ${input.stop} target ${input.target} q${input.quantity} — ${msg}`);
                        return formatToolResult({ error: msg });
                    }
                }
                case 'list': {
                    const items = await listProposals(input.status);
                    return formatToolResult({
                        count: items.length,
                        proposals: items.map((p) => ({ ...p, summary: formatProposalLine(p) })),
                    });
                }
                case 'get': {
                    const p = await getProposal(input.id);
                    return formatToolResult(p ? { proposal: p, summary: formatProposalLine(p) } : { error: `Proposal ${input.id} not found` });
                }
                case 'reject': {
                    const outcome = await rejectProposal(input.id);
                    return formatToolResult(outcome);
                }
                case 'performance': {
                    const summary = await getPerformanceSummary(Date.now() - input.days * 24 * 3600_000);
                    return formatToolResult({
                        days: input.days,
                        summary,
                        report: formatPerformanceReport(summary, `last ${input.days}d`),
                    });
                }
            }
        },
    });
}

const AcceptSchema = z.object({
    id: z.string().describe("Proposal id to execute, e.g. 'P-3F2A'."),
});

export function createAcceptProposalTool() {
    return new DynamicStructuredTool({
        name: 'accept_proposal',
        description:
            'Execute an open trade proposal as a paper bracket order. Requires interactive user approval; gated by the safety lock and the daily-loss kill-switch.',
        schema: AcceptSchema,
        func: async (input) => {
            const outcome = await acceptProposal(input.id);
            return formatToolResult(outcome);
        },
    });
}
