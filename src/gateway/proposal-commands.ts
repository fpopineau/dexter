/**
 * Deterministic WhatsApp command router for trade proposals.
 *
 * Runs BEFORE the agent: an explicit human message like "accept P-3F2A" is
 * the approval itself, so execution goes straight through the deterministic
 * proposal executor (safety lock + kill-switch) — no LLM in the loop.
 *
 * Recognized (DMs only):
 *   accept|ok|go P-XXXX     execute the proposal (paper bracket)
 *   reject|no P-XXXX        reject the proposal
 *   proposals               list open proposals
 *   halt status             show the daily-loss kill-switch state
 *   performance [N]         closed-trade P&L summary over the last N days (default 7)
 */

import { getDailyLossStatus } from '@/services/daily-loss-guard.js';
import { acceptProposal, rejectProposal } from '@/services/proposal-executor.js';
import {
    formatPerformanceReport,
    formatProposalLine,
    getPerformanceSummary,
    listProposals,
} from '@/services/trade-proposals.js';

const ACCEPT_RE = /^\s*(accept|ok|go)\s+(P-[A-Za-z0-9]{4})\s*$/i;
const REJECT_RE = /^\s*(reject|no)\s+(P-[A-Za-z0-9]{4})\s*$/i;
const LIST_RE = /^\s*proposals?\s*$/i;
const HALT_RE = /^\s*halt\s+status\s*$/i;
const PERF_RE = /^\s*(performance|perf)(?:\s+(\d{1,3})\s*d?)?\s*$/i;

/**
 * Try to handle the message as a proposal command.
 * Returns the reply text when handled, or null to fall through to the agent.
 */
export async function handleProposalCommand(body: string): Promise<string | null> {
    const accept = ACCEPT_RE.exec(body);
    if (accept) {
        const outcome = await acceptProposal(accept[2].toUpperCase());
        return outcome.message;
    }

    const reject = REJECT_RE.exec(body);
    if (reject) {
        const outcome = await rejectProposal(reject[2].toUpperCase());
        return outcome.message;
    }

    if (LIST_RE.test(body)) {
        const open = await listProposals('open');
        if (open.length === 0) return 'No open proposals.';
        return [
            `Open proposals (${open.length}):`,
            ...open.map((p) => `• ${formatProposalLine(p)}`),
            "Reply 'accept <ID>' to execute (paper) or 'reject <ID>'.",
        ].join('\n');
    }

    const perf = PERF_RE.exec(body);
    if (perf) {
        const days = perf[2] ? Math.max(1, Number(perf[2])) : 7;
        const summary = await getPerformanceSummary(Date.now() - days * 24 * 3600_000);
        return formatPerformanceReport(summary, `last ${days}d`);
    }

    if (HALT_RE.test(body)) {
        const s = await getDailyLossStatus();
        return s.halted
            ? `⛔ Trading HALTED — ${s.reason}`
            : `✅ Trading allowed. Daily P&L ${s.dailyPnL?.toFixed(0) ?? '?'} / limit -${s.limitDollars?.toFixed(0) ?? '?'} (${s.limitPct}% of ${s.netLiquidation?.toFixed(0) ?? '?'}).`;
    }

    return null;
}
