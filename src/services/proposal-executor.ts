/**
 * Proposal executor — the ONLY code path that turns an accepted proposal
 * into orders. Deterministic, no LLM involved.
 *
 * Gate order on accept:
 *   1. proposal exists, is open, not expired
 *   2. paper/live safety lock (assertOrderingAllowed)
 *   3. daily-loss kill-switch (assertDailyLossOk — fail-safe on uncertainty)
 *   4. risk gate with live account context (position size vs net
 *      liquidation, max open positions, max trades per day)
 *   5. bracket placement (entry + OCA stop/target)
 *
 * Callers: the WhatsApp command router (explicit human message) and the
 * approval-gated accept_proposal tool (interactive TUI confirmation).
 */

import { placeBracketOrder } from '@/tools/ibkr/bracket.js';
import { assertOrderingAllowed, getManagedAccounts, isLivePort } from '@/tools/ibkr/connection.js';
import { logger } from '@/utils';
import { assertDailyLossOk } from './daily-loss-guard.js';
import { trackExecutedProposal } from './outcome-tracker.js';
import { assertProposalRisk } from './proposal-risk-gate.js';
import {
    countExecutedSince,
    countOpenExecuted,
    etDayStartMs,
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
        const lossStatus = await assertDailyLossOk();

        // Risk gate with live account context. Re-runs the static checks too:
        // rules may have been tightened since the proposal was created.
        assertProposalRisk(
            {
                symbol: p.symbol,
                direction: p.direction,
                entryType: p.entryType,
                entry: p.entry,
                stop: p.stop,
                target: p.target,
                quantity: p.quantity,
            },
            {
                netLiquidation: lossStatus.netLiquidation,
                openPositions: await countOpenExecuted(),
                executedToday: await countExecutedSince(etDayStartMs()),
            },
        );

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
        await setProposalStatus(p.id, 'executed', { orderIds, executedAt: Date.now() });
        logger.info(`[proposal-executor] ${p.id} executed (orders ${orderIds.join('/')})`);

        // Hand the bracket to the outcome tracker (fills, exit, realized P&L).
        const executed = await getProposal(p.id);
        if (executed) {
            try { trackExecutedProposal(executed); } catch (err) {
                logger.warn(`[proposal-executor] outcome tracking failed for ${p.id}: ${err}`);
            }
        }

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

// ---------------------------------------------------------------------------
// Auto-execution (paper ONLY, behind AUTO_EXECUTE_PAPER)
//
// Stricter than manual acceptance: refuses live ports/accounts REGARDLESS of
// IBKR_ALLOW_LIVE, and enforces a daily cap (AUTO_EXECUTE_MAX_PER_DAY,
// default 5). Auto-execution is never available for live trading by design —
// going live always requires an explicit human acceptance per trade.
// ---------------------------------------------------------------------------

export function isAutoExecuteEnabled(): boolean {
    return (process.env.AUTO_EXECUTE_PAPER ?? '').trim().toLowerCase() === 'true';
}

function assertPaperOnly(): void {
    if (isLivePort()) {
        throw new Error('auto-execute is paper-only: refusing on a live port (4001/7496), regardless of IBKR_ALLOW_LIVE');
    }
    const liveAccounts = getManagedAccounts().filter((a) => !a.toUpperCase().startsWith('D'));
    if (liveAccounts.length > 0) {
        throw new Error('auto-execute is paper-only: connected account does not look like a paper account');
    }
}

function autoExecMaxPerDay(): number {
    const n = Number(process.env.AUTO_EXECUTE_MAX_PER_DAY);
    return Number.isFinite(n) && n > 0 ? n : 5;
}

function etDate(): string {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

let autoExecDate = '';
let autoExecCount = 0;

/**
 * Auto-execute a proposal on PAPER. Returns a non-ok outcome (never throws)
 * when disabled, capped, non-paper, or when the underlying acceptance fails.
 */
export async function autoExecuteProposal(id: string): Promise<ExecutionOutcome> {
    if (!isAutoExecuteEnabled()) {
        return { ok: false, message: 'auto-execute is disabled (AUTO_EXECUTE_PAPER != true)' };
    }
    const today = etDate();
    if (today !== autoExecDate) {
        autoExecDate = today;
        autoExecCount = 0;
    }
    const max = autoExecMaxPerDay();
    if (autoExecCount >= max) {
        return { ok: false, message: `auto-execute daily cap reached (${max}/day)` };
    }
    try {
        assertPaperOnly();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[proposal-executor] auto-execute refused: ${msg}`);
        return { ok: false, message: `auto-execute refused — ${msg}` };
    }

    const outcome = await acceptProposal(id);
    if (outcome.ok) autoExecCount++;
    return {
        ok: outcome.ok,
        message: `🤖 AUTO-EXECUTE (paper, ${autoExecCount}/${max} today) — ${outcome.message}`,
    };
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
