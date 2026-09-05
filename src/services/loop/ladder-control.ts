/**
 * Ladder control (REQ-LADDER-001..004, live-loop WP3) — the WRITER side of
 * the size ladder whose reader (`ladder-state.ts`) the sizer and the gate
 * consult. Step-UPS are operator acts (queued by the nightly look, applied
 * by `ladder up` + confirm); step-DOWNS are automatic at −5 % of marked
 * NetLiq from the last step-up mark; a new epoch resets to the bottom rung
 * unless it carries. Every move is journaled.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BOTTOM_RUNG, LADDER_RUNGS, ladderStatePath, readLadderState, type LadderState } from '../ladder-state.js';
import { ladderEligibility, stepDownDue, type LadderEligibility } from '@/utils/sequential-test.js';

export function writeLadderState(state: LadderState, dataDir?: string): void {
    const p = ladderStatePath(dataDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state, null, 2));
}

export interface LadderDeps {
    now: number;
    dataDir?: string;
    journal: (line: string) => void;
}

/** REQ-LADDER-003: a new epoch starts at the bottom rung unless it carries. */
export function resetLadder(deps: LadderDeps & { carry?: boolean; epochId: string }): LadderState {
    const prev = readLadderState(deps.dataDir);
    if (deps.carry && prev) {
        deps.journal(`ladder CARRIED into ${deps.epochId} at rung ${prev.rung}% (operator choice)`);
        return prev;
    }
    const state: LadderState = {
        rung: BOTTOM_RUNG,
        since: new Date(deps.now).toISOString(),
        history: [...(prev?.history ?? []), { at: new Date(deps.now).toISOString(), from: prev?.rung ?? BOTTOM_RUNG, to: BOTTOM_RUNG, reason: `epoch ${deps.epochId} start` }],
    };
    writeLadderState(state, deps.dataDir);
    deps.journal(`ladder RESET to rung ${BOTTOM_RUNG}% for ${deps.epochId}`);
    return state;
}

/** REQ-LADDER-001: apply a step-up the evidence permits; the caller has
 *  already collected the operator's confirmation. */
export function stepUp(deps: LadderDeps & { markedNetLiq: number | null; evidence: { n: number; sumR: number; stopActive: boolean } }): { ok: boolean; message: string; state?: LadderState; eligibility: LadderEligibility } {
    const prev = readLadderState(deps.dataDir);
    const rung = prev?.rung ?? BOTTOM_RUNG;
    const eligibility = ladderEligibility({ ...deps.evidence, rung });
    if (!eligibility.eligible || eligibility.nextRung === null) {
        return { ok: false, message: `⛔ ladder step-up refused: ${eligibility.reason}`, eligibility };
    }
    if (deps.markedNetLiq === null || !(deps.markedNetLiq > 0)) {
        return { ok: false, message: '⛔ ladder step-up refused: marked NetLiq unavailable — the step-down mark could not be anchored; retry when IBKR responds', eligibility };
    }
    const state: LadderState = {
        rung: eligibility.nextRung,
        since: new Date(deps.now).toISOString(),
        lastStepUpNetLiq: deps.markedNetLiq,
        history: [...(prev?.history ?? []), { at: new Date(deps.now).toISOString(), from: rung, to: eligibility.nextRung, reason: `step-up: ${eligibility.reason}` }],
    };
    writeLadderState(state, deps.dataDir);
    deps.journal(`ladder STEP-UP ${rung}% → ${eligibility.nextRung}% (${eligibility.reason}); step-down mark $${deps.markedNetLiq.toFixed(2)}`);
    return { ok: true, message: `📈 ladder: rung ${rung}% → ${eligibility.nextRung}% (${eligibility.reason}). Automatic step-down at −5% from $${deps.markedNetLiq.toFixed(0)}.`, state, eligibility };
}

/** REQ-LADDER-002: automatic step-down; never below the bottom rung; the
 *  step-down mark re-anchors at the current NetLiq so one drawdown costs one
 *  rung. Returns null when nothing is due. */
export function stepDownIfDue(deps: LadderDeps & { markedNetLiq: number; alert?: (msg: string) => void }): LadderState | null {
    const prev = readLadderState(deps.dataDir);
    if (!prev) return null;
    if (!stepDownDue(deps.markedNetLiq, prev.lastStepUpNetLiq ?? null)) return null;
    const rungs = LADDER_RUNGS as readonly number[];
    const idx = rungs.indexOf(prev.rung);
    const to = idx > 0 ? rungs[idx - 1] : BOTTOM_RUNG;
    const state: LadderState = {
        rung: to,
        since: new Date(deps.now).toISOString(),
        // Re-anchor: the next step-down measures from here; a step-up sets it again.
        lastStepUpNetLiq: deps.markedNetLiq,
        history: [...(prev.history ?? []), { at: new Date(deps.now).toISOString(), from: prev.rung, to, reason: `automatic step-down: marked NetLiq $${deps.markedNetLiq.toFixed(2)} ≤ 95% of $${(prev.lastStepUpNetLiq ?? 0).toFixed(2)}` }],
    };
    writeLadderState(state, deps.dataDir);
    const line = `ladder STEP-DOWN ${prev.rung}% → ${to}% (marked NetLiq $${deps.markedNetLiq.toFixed(2)} ≤ 95% of the step-up mark $${(prev.lastStepUpNetLiq ?? 0).toFixed(2)})`;
    deps.journal(line);
    deps.alert?.(`📉 ${line}`);
    return state;
}

export function ladderStatusLine(dataDir?: string, eligibility?: LadderEligibility | null): string {
    const s = readLadderState(dataDir);
    const base = s
        ? `ladder: rung ${s.rung}%${s.since ? ` since ${s.since.slice(0, 10)}` : ''}${s.lastStepUpNetLiq ? ` · step-down mark $${s.lastStepUpNetLiq.toFixed(0)} (−5%)` : ' · no step-down mark yet'}`
        : `ladder: rung ${BOTTOM_RUNG}% (bottom — no state file yet)`;
    if (!eligibility) return base;
    return `${base} · ${eligibility.eligible ? `STEP-UP to ${eligibility.nextRung}% ELIGIBLE (${eligibility.reason}) — reply 'ladder up' then 'ladder up confirm'` : `next: ${eligibility.nextRung ?? '—'}% at n ≥ ${eligibility.milestone ?? '—'} (${eligibility.reason})`}`;
}
