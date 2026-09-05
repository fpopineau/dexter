/**
 * Ladder state — the size-ladder rung the sizer overlays on the yaml
 * ceiling (REQ-RISK-009, live-loop WP1; the ladder's movement lands in WP3).
 *
 * The rung is a STATE FILE, not a rule: `risk-rules.live.yaml` stays the
 * ceiling policy the operator ratified, and the effective intraday risk
 * budget is min(yaml, rung). The file is read on every sizing call (the
 * ladder is expected to move inside an epoch, so nothing caches it) and
 * every failure mode resolves to the BOTTOM rung — absent, unreadable or
 * malformed state can only make positions smaller, never larger.
 *
 * The rung is deliberately NOT a strategy-fingerprint surface: the
 * sequential test judges R-multiples, which are rung-invariant by
 * construction, and the ladder moving mid-epoch is the design.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/utils';

/** Pre-registered rungs, % of NetLiq risked per intraday trade. */
export const LADDER_RUNGS: readonly number[] = [0.25, 0.5, 0.75, 1.0];

export const BOTTOM_RUNG = LADDER_RUNGS[0];

export interface LadderStepRecord {
    at: string;
    from: number;
    to: number;
    reason: string;
}

export interface LadderState {
    /** Current rung — always a member of LADDER_RUNGS. */
    rung: number;
    /** ISO time the current rung took effect. */
    since?: string;
    /** Marked NetLiq at the last step-UP — the automatic step-down (WP3)
     *  measures its -5% from here. */
    lastStepUpNetLiq?: number;
    history?: LadderStepRecord[];
}

export function ladderStatePath(dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data')): string {
    return join(dataDir, 'ladder-state.json');
}

function isRung(n: unknown): n is number {
    return typeof n === 'number' && LADDER_RUNGS.includes(n);
}

/** Pure: a well-formed ladder record, or null. Only `rung` is required. */
export function parseLadderState(raw: unknown): LadderState | null {
    if (raw === null || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (!isRung(o.rung)) return null;
    const state: LadderState = { rung: o.rung };
    if (typeof o.since === 'string') state.since = o.since;
    if (typeof o.lastStepUpNetLiq === 'number' && Number.isFinite(o.lastStepUpNetLiq)) state.lastStepUpNetLiq = o.lastStepUpNetLiq;
    if (Array.isArray(o.history)) state.history = o.history as LadderStepRecord[];
    return state;
}

/** Pure: the effective rung for a (possibly absent) state. */
export function rungFromState(state: LadderState | null): number {
    return state?.rung ?? BOTTOM_RUNG;
}

let warnedOnce = false;

/** Read the ladder file; null when absent or unparseable (logged once). */
export function readLadderState(dataDir?: string): LadderState | null {
    const p = ladderStatePath(dataDir);
    if (!existsSync(p)) return null;
    try {
        const parsed = parseLadderState(JSON.parse(readFileSync(p, 'utf-8')));
        if (parsed === null && !warnedOnce) {
            warnedOnce = true;
            logger.warn(`[ladder-state] ${p} is malformed — sizing at the bottom rung ${BOTTOM_RUNG}% until it is fixed`);
        }
        return parsed;
    } catch (err) {
        if (!warnedOnce) {
            warnedOnce = true;
            logger.warn(`[ladder-state] ${p} unreadable (${err instanceof Error ? err.message : err}) — sizing at the bottom rung ${BOTTOM_RUNG}%`);
        }
        return null;
    }
}

/** The rung the sizer must honour right now (fail-safe: bottom rung). */
export function currentRung(): number {
    return rungFromState(readLadderState());
}
