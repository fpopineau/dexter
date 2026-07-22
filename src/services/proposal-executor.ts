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
import { assertOrderingAllowed, getIBApi, getManagedAccounts, isLivePort } from '@/tools/ibkr/connection.js';
import { createIbkrMarketData } from '@/tools/ibkr/market-data.js';
import { logger } from '@/utils';
import { assertDailyLossOk } from './daily-loss-guard.js';
import { trackExecutedProposal } from './outcome-tracker.js';
import { assertProposalRisk, checkPriceRun } from './proposal-risk-gate.js';
import {
    claimProposalForExecution,
    countExecutedSince,
    countOpenExecuted,
    etDayStartMs,
    expireStale,
    formatProposalLine,
    getProposal,
    listTrackable,
    releaseProposalClaim,
    setProposalStatus,
} from './trade-proposals.js';

export interface ExecutionOutcome {
    ok: boolean;
    message: string;
}

/** Best-effort live last price (null when unavailable). */
async function fetchLastPrice(symbol: string): Promise<number | null> {
    try {
        const raw = await createIbkrMarketData().invoke({ ticker: symbol, exchange: 'SMART', currency: 'USD' });
        const data = (JSON.parse(String(raw)) as { data?: { last?: number; bid?: number; ask?: number } }).data;
        if (data?.last && Number.isFinite(data.last) && data.last > 0) return data.last;
        if (data?.bid && data?.ask && data.bid > 0 && data.ask > 0) return (data.bid + data.ask) / 2;
        return null;
    } catch {
        return null;
    }
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

    // Atomic claim (open → executing): exactly one concurrent accept wins.
    // Without this, two accepts racing through the async gates below could
    // both observe 'open' and place two brackets.
    if (!(await claimProposalForExecution(p.id))) {
        return { ok: false, message: `⛔ ${p.id} is already being executed by another accept — not placing a second bracket.` };
    }

    // Safety gates — order matters: cheap static lock first, then live P&L.
    // A gate REFUSAL leaves the proposal OPEN: gates re-run on every accept,
    // and transient conditions (P&L verification timeout, a halt cleared
    // later) must not permanently kill a valid proposal before its expiry.
    try {
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
                entryLimit: p.entryLimit,
                stop: p.stop,
                target: p.target,
                quantity: p.quantity,
            },
            {
                netLiquidation: lossStatus.netLiquidation,
                openPositions: await countOpenExecuted(),
                executedToday: await countExecutedSince(etDayStartMs()),
                // Committed notional on this symbol from OTHER working/filled
                // proposals — the aggregate cap stops same-name stacking.
                existingSymbolExposure: (await listTrackable())
                    .filter((t) => t.symbol === p.symbol && t.id !== p.id)
                    .reduce((sum, t) => sum + t.quantity * (t.entry ?? 0), 0),
            },
        );

        // Chase/invalidation gate: proposal levels are anchored at creation
        // time; on a fast mover the edge may be gone by accept time. Best
        // effort — an unavailable quote does not block (the hard gates
        // above already ran), it is only noted.
        const last = await fetchLastPrice(p.symbol);
        if (last !== null) {
            const run = checkPriceRun(p, last);
            if (!run.ok) {
                throw new Error(`[chase-gate] ${run.reason}. Ask for re-evaluated levels instead of accepting stale ones.`);
            }
        } else {
            logger.warn(`[proposal-executor] ${p.id}: live quote unavailable — chase check skipped`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[proposal-executor] ${p.id} refused by gates (proposal stays open): ${msg}`);
        await releaseProposalClaim(p.id); // refusal → back to open, retryable
        return {
            ok: false,
            message:
                `⛔ ${p.id} NOT executed — ${msg}\n` +
                `The proposal remains OPEN (expires ${new Date(p.expiresAt).toISOString()}); ` +
                `resolve the issue and reply 'accept ${p.id}' to retry.`,
        };
    }

    try {
        const result = await placeBracketOrder({
            symbol: p.symbol,
            direction: p.direction,
            quantity: p.quantity,
            entryType: p.entryType,
            entryPrice: p.entry ?? undefined,
            entryLimitPrice: p.entryLimit ?? undefined,
            stopPrice: p.stop,
            targetPrice: p.target,
            tif: p.tif, // GTC brackets survive the close (overnight/swing)
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
                `✅ ${p.id} bracket placed: ${p.direction.toUpperCase()} ${p.quantity} ${p.symbol} ` +
                `${p.entryType === 'MKT' ? 'at market' : `limit ${p.entry}`}, stop ${p.stop}, target ${p.target} ` +
                `(orders ${orderIds.join('/')}, OCA ${result.ocaGroup}).\n` +
                `The entry order is now WORKING — you hold a position once it fills. ` +
                `Track with 'orders' (resting orders) and 'positions' (fills).`,
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

function autoExecMinScore(): number {
    const n = Number(process.env.AUTO_EXECUTE_MIN_SCORE);
    return Number.isFinite(n) && n > 0 ? n : 80;
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

    // Confidence gate: only proposals carrying a score at or above
    // AUTO_EXECUTE_MIN_SCORE execute unattended; everything else stays
    // open for a manual 'accept'. No score → no auto-execution.
    const p = await getProposal(id);
    if (!p) {
        return { ok: false, message: `auto-execute: proposal ${id.toUpperCase()} not found` };
    }
    const minScore = autoExecMinScore();
    if (p.score == null || p.score < minScore) {
        return {
            ok: false,
            message: `auto-execute: ${p.id} score ${p.score ?? 'none'} is below the confidence threshold ` +
                `${minScore} (AUTO_EXECUTE_MIN_SCORE) — left open for manual 'accept ${p.id}'`,
        };
    }

    const outcome = await acceptProposal(id);
    if (outcome.ok) autoExecCount++;
    return {
        ok: outcome.ok,
        message: `🤖 AUTO-EXECUTE (paper, score ${p.score}, ${autoExecCount}/${max} today) — ${outcome.message}`,
    };
}

/**
 * Cancel the bracket orders of an EXECUTED, still-unfilled proposal
 * (risk-reducing: it removes a pending entry). Refused once the entry has
 * filled — a position exists then; use protect/close instead. The outcome
 * tracker observes the cancellations and closes the proposal honestly.
 */
export async function cancelProposalBracket(id: string): Promise<ExecutionOutcome> {
    const p = await getProposal(id);
    if (!p) {
        return { ok: false, message: `Proposal ${id.toUpperCase()} not found.` };
    }
    if (p.status !== 'executed' || !p.orderIds?.length) {
        return { ok: false, message: `Proposal ${p.id} has no working bracket (status: ${p.status}). Use 'reject ${p.id}' for open proposals.` };
    }
    if (p.entryFillPrice != null) {
        return {
            ok: false,
            message: `⛔ ${p.id}: the entry has FILLED — cancelling the exits would leave the ${p.symbol} position unprotected. ` +
                `Use 'close ${p.symbol}' to exit, or leave the bracket working.`,
        };
    }
    try {
        const api = await getIBApi();
        for (const orderId of p.orderIds) {
            try { api.cancelOrder(orderId); } catch { /* already gone */ }
        }
        logger.info(`[proposal-executor] ${p.id}: cancel requested for orders ${p.orderIds.join('/')}`);
        return {
            ok: true,
            message: `🚫 ${p.id}: cancel requested for the ${p.symbol} bracket (orders ${p.orderIds.join('/')}). ` +
                `The close alert confirms once IBKR processes it.`,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `❌ Could not cancel ${p.id} — ${msg}` };
    }
}

/** Resolve 'cancel SYM' to the working bracket for that symbol. */
export async function cancelProposalForSymbol(symbol: string): Promise<ExecutionOutcome> {
    const sym = symbol.toUpperCase();
    const candidates = (await listTrackable()).filter((p) => p.symbol === sym);
    if (candidates.length === 0) {
        return {
            ok: false,
            message: `No working bracket for ${sym}. 'orders' shows what is live; an open proposal is removed with 'reject P-XXXX'.`,
        };
    }
    const unfilled = candidates.filter((p) => p.entryFillPrice == null);
    if (unfilled.length > 1) {
        return {
            ok: false,
            message: `${sym} has ${unfilled.length} working brackets (${unfilled.map((p) => p.id).join(', ')}) — cancel by id.`,
        };
    }
    // Zero unfilled → every bracket's entry has filled; delegate so the
    // standard "position would be unprotected" refusal explains it.
    return cancelProposalBracket((unfilled[0] ?? candidates[0]).id);
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
