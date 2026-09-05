/**
 * Loop control-plane core (REQ-LIVE-003, live-loop WP1) — the operator's
 * per-trade powers once automation is on, plus read-only status of the
 * loop's state files. Shared by the WhatsApp grammar
 * (src/gateway/loop-commands.ts) and the dashboard action route, so every
 * surface runs the same deterministic paths.
 *
 *   veto P-XXXX   open row → reject; executed-but-unfilled → cancel the
 *                 bracket through the existing primitive (parent leg,
 *                 broker-confirmed, children untouched); FILLED → refused
 *                 with the `kill` hint — a veto never strips protection.
 *   kill SYMBOL   = closePosition (every one of its refusals honoured).
 *
 * This module is observability/control-plane: it changes no selection,
 * sizing or exit behavior and lives outside the behavior fingerprint
 * paths (WP3 pins the list).
 */

import { cancelProposalBracket, rejectProposal, type ExecutionOutcome } from './proposal-executor.js';
import { closePosition } from './position-actions.js';
import { getProposal, type TradeProposal } from './trade-proposals.js';
import { describeLiveSwitch } from './live-switch.js';
import { readLadderState, BOTTOM_RUNG } from './ladder-state.js';
import { readEpochState } from './epoch-state.js';
import { readEpochRecord } from './loop/epoch-control.js';

export type VetoDecision = 'reject' | 'cancel-bracket' | 'refuse-filled' | 'refuse-status';

/** Pure: what a veto may do to this row. */
export function vetoDecision(p: TradeProposal): VetoDecision {
    if (p.status === 'open') return 'reject';
    if (p.status === 'executed') {
        if (p.entryFillPrice != null) return 'refuse-filled';
        return 'cancel-bracket';
    }
    return 'refuse-status';
}

export interface VetoDeps {
    getProposal: (id: string) => Promise<TradeProposal | null>;
    rejectProposal: (id: string) => Promise<ExecutionOutcome>;
    cancelProposalBracket: (id: string) => Promise<ExecutionOutcome>;
}

const defaultVetoDeps: VetoDeps = { getProposal, rejectProposal, cancelProposalBracket };

export async function vetoProposalWith(idRaw: string, deps: VetoDeps = defaultVetoDeps): Promise<ExecutionOutcome> {
    const id = idRaw.trim().toUpperCase();
    const p = await deps.getProposal(id);
    if (!p) return { ok: false, message: `Proposal ${id} not found.` };
    switch (vetoDecision(p)) {
        case 'reject': {
            const r = await deps.rejectProposal(id);
            return { ...r, message: r.ok ? `🛑 veto ${id}: ${r.message}` : r.message };
        }
        case 'cancel-bracket': {
            const r = await deps.cancelProposalBracket(id);
            return { ...r, message: r.ok ? `🛑 veto ${id}: entry not yet filled — ${r.message}` : r.message };
        }
        case 'refuse-filled':
            return {
                ok: false,
                message: `⛔ veto ${id} refused: the ${p.symbol} entry has FILLED — a veto never strips a position's protection. ` +
                    `Use 'kill ${p.symbol}' to close it at market, or leave the bracket working.`,
            };
        case 'refuse-status':
            return { ok: false, message: `⛔ veto ${id} refused: the proposal is ${p.status} — nothing to veto.` };
        default: {
            const _exhaustive: never = vetoDecision(p) as never;
            throw new Error(`unhandled veto decision ${String(_exhaustive)}`);
        }
    }
}

export function vetoProposal(id: string): Promise<ExecutionOutcome> {
    return vetoProposalWith(id);
}

/** `kill SYMBOL` — the safe close path, all refusals honoured. */
export async function killPosition(symbol: string): Promise<{ ok: boolean; message: string }> {
    const r = await closePosition(symbol.trim().toUpperCase(), 'kill command');
    return { ok: r.ok, message: r.message };
}

export function ladderStatusLine(dataDir?: string): string {
    const s = readLadderState(dataDir);
    const rec = readEpochRecord(dataDir);
    const queued = rec?.status === 'running' && rec.stepUpEligible
        ? ` · STEP-UP to ${rec.stepUpEligible.nextRung}% ELIGIBLE (${rec.stepUpEligible.reason}) — 'ladder up' then 'ladder up confirm'`
        : '';
    if (!s) return `ladder: rung ${BOTTOM_RUNG}% (bottom — no state file yet; 'epoch new' writes it)${queued}`;
    return `ladder: rung ${s.rung}%${s.since ? ` since ${s.since.slice(0, 10)}` : ''}${s.lastStepUpNetLiq ? ` · automatic step-down at −5% from $${s.lastStepUpNetLiq.toFixed(0)}` : ' · no step-down mark yet'}${queued}`;
}

export function epochStatusLine(dataDir?: string): string {
    const r = readEpochState(dataDir);
    if (r.kind === 'absent') return "epoch: none started (no state file — intake open). 'epoch new' opens epoch 1.";
    if (r.kind === 'corrupt') return `epoch: STATE FILE UNREADABLE (${r.error}) — new entries are refused until it is fixed`;
    const s = r.state;
    const rec = readEpochRecord(dataDir);
    const looks = rec?.looks.length ? ` · looks ${rec.looks.map((l) => `n${l.n}:${l.decision}`).join(', ')}` : ' · no look yet';
    return `epoch ${s.id}: ${s.status.toUpperCase()}${s.status === 'stopped' ? ` — ${s.stopReason ?? 'no reason recorded'}` : ''} since ${new Date(s.startedAt).toISOString().slice(0, 10)} (fp ${s.fingerprint || '?'}${rec?.netLiq ? `, NetLiq $${rec.netLiq.toFixed(0)}` : ''})${looks}${rec?.firstAcceptAt ? ` · ACCEPT recorded ${new Date(rec.firstAcceptAt).toISOString().slice(0, 10)}` : ''}${rec?.promotionPending ? ` · promotion pending: ${rec.promotionPending.variant}` : ''}`;
}

export function liveStatusLine(dataDir?: string): string {
    return describeLiveSwitch(dataDir);
}
