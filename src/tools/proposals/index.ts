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
import { acceptProposal } from '@/services/proposal-executor.js';
import {
    createProposal,
    formatProposalLine,
    getProposal,
    listProposals,
} from '@/services/trade-proposals.js';
import { rejectProposal } from '@/services/proposal-executor.js';
import { formatToolResult } from '../types.js';

export const TRADE_PROPOSALS_DESCRIPTION = `
Manage trade proposals — persisted, human-actionable trade recommendations.

**create** — register a recommendation (symbol, direction, entryType LMT/MKT, entry,
  stop, target, quantity, score, rationale, expiresMinutes default 120). Creating a
  proposal does NOT trade. Always include the returned proposal id in your answer,
  with the instruction "reply 'accept <ID>' to execute (paper)".
**list** — list proposals (status filter: open/executed/rejected/expired/failed; default open).
**get** — fetch one proposal by id.
**reject** — mark an open proposal rejected (risk-reducing, always allowed).

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
    entryType: z.enum(['LMT', 'MKT']).default('LMT').describe('LMT requires entry price; MKT enters at market.'),
    entry: z.number().positive().optional().describe('Entry price (required for LMT).'),
    stop: z.number().positive().describe('Stop-loss price.'),
    target: z.number().positive().describe('Take-profit price.'),
    quantity: z.number().int().positive().describe('Number of shares.'),
    score: z.number().min(0).max(150).optional().describe('Signal/composite score backing this proposal.'),
    rationale: z.string().min(5).describe('One or two sentences: why this trade, catalyst, risk note.'),
    expiresMinutes: z.number().int().positive().max(24 * 60).default(120)
        .describe('Validity window in minutes. Defaults to 120.'),
});

const ListSchema = z.object({
    action: z.literal('list'),
    status: z.enum(['open', 'executed', 'rejected', 'expired', 'failed']).optional()
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

const ProposalsSchema = z.discriminatedUnion('action', [CreateSchema, ListSchema, GetSchema, RejectSchema]);

function coherent(input: z.infer<typeof CreateSchema>): string | null {
    if (input.entryType === 'LMT') {
        if (input.entry == null) return 'entry price is required for LMT proposals';
        if (input.direction === 'long' && !(input.stop < input.entry && input.entry < input.target)) {
            return 'long proposal requires stop < entry < target';
        }
        if (input.direction === 'short' && !(input.target < input.entry && input.entry < input.stop)) {
            return 'short proposal requires target < entry < stop';
        }
    } else if (input.direction === 'long' ? !(input.stop < input.target) : !(input.target < input.stop)) {
        return 'stop and target are inconsistent with the direction';
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
                    const p = await createProposal({
                        symbol: input.symbol,
                        direction: input.direction,
                        entryType: input.entryType,
                        entry: input.entry,
                        stop: input.stop,
                        target: input.target,
                        quantity: input.quantity,
                        score: input.score,
                        rationale: input.rationale,
                        source: 'agent',
                        expiresMinutes: input.expiresMinutes,
                    });
                    return formatToolResult({
                        created: p,
                        userInstruction: `Reply 'accept ${p.id}' to execute on paper, or 'reject ${p.id}'. Expires ${new Date(p.expiresAt).toISOString()}.`,
                    });
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
