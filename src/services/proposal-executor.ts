/**
 * Proposal executor — the ONLY code path that turns an accepted proposal
 * into orders. Deterministic, no LLM involved.
 *
 * Gate order on accept:
 *   1. proposal exists, is open, not expired
 *   2. paper/live safety lock (assertOrderingAllowed)
 *   3. daily-loss kill-switch (assertDailyLossOk — fail-safe on uncertainty)
 *   4. bracket placement (entry + OCA stop/target)
 *
 * Callers: the WhatsApp command router (explicit human message) and the
 * approval-gated accept_proposal tool (interactive TUI confirmation).
 */

import { placeBracketOrder } from '@/tools/ibkr/bracket.js';
import { assertOrderingAllowed } from '@/tools/ibkr/connection.js';
import { logger } from '@/utils';
import { assertDailyLossOk } from './daily-loss-guard.js';
import {
    expireStale,
    formatProposalLine,
    getProposal,
    setProposalStatus,
} from './trade-proposals.js';

export interface ExecutionOutcome {
    ok: boolean;
    message: string;
}

export async function acceptProposal(id: string): Promise<ExecutionOutcome> {
    await expireStale();
    const p = await getProposal(id);
    if (!p) {
        return { ok: false, message: `Proposal ${id.toUpperCase()} not found.` };
    }
    if (p.status !== 'open') {
        return { ok: false, message: `Proposal ${p.id} is ${p.status}, not open. ${formatProposalLine(p)}` };
    }

    try {
        // Safety gates — order matters: cheap static lock first, then live P&L.
        assertOrderingAllowed();
        await assertDailyLossOk();

        const result = await placeBracketOrder({
            symbol: p.symbol,
            direction: p.direction,
            quantity: p.quantity,
            entryType: p.entryType,
            entryPrice: p.entry ?? undefined,
            stopPrice: p.stop,
            targetPrice: p.target,
        });

        const orderIds = [result.parentOrderId, result.takeProfitOrderId, result.stopOrderId];
        await setProposalStatus(p.id, 'executed', { orderIds });
        logger.info(`[proposal-executor] ${p.id} executed (orders ${orderIds.join('/')})`);

        return {
            ok: true,
            message:
                `✅ ${p.id} executed: ${p.direction.toUpperCase()} ${p.quantity} ${p.symbol} ` +
                `${p.entryType === 'MKT' ? 'at market' : `limit ${p.entry}`}, stop ${p.stop}, target ${p.target} ` +
                `(orders ${orderIds.join('/')}, OCA ${result.ocaGroup}).`,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await setProposalStatus(p.id, 'failed', { note: msg });
        logger.error(`[proposal-executor] ${p.id} failed: ${msg}`);
        return { ok: false, message: `❌ ${p.id} NOT executed — ${msg}` };
    }
}

export async function rejectProposal(id: string): Promise<ExecutionOutcome> {
    const p = await getProposal(id);
    if (!p) {
        return { ok: false, message: `Proposal ${id.toUpperCase()} not found.` };
    }
    if (p.status !== 'open') {
        return { ok: false, message: `Proposal ${p.id} is already ${p.status}.` };
    }
    await setProposalStatus(p.id, 'rejected');
    return { ok: true, message: `🚫 ${p.id} rejected. ${formatProposalLine({ ...p, status: 'rejected' })}` };
}
