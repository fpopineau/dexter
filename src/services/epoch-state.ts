/**
 * Epoch state — the live-loop epoch latch (REQ-RISK-010, live-loop WP1;
 * the epoch lifecycle — start, looks, stop, journal — lands in WP3).
 *
 * WP1 lands only the READER and the gate verdict, as an inert seam: with
 * no `epoch-state.json` the accept path behaves exactly as today. Once
 * WP3 writes `status: 'stopped'` (a REJECT look, the -5% hard stop, or an
 * unresolved broker anomaly) the accept path and the auto-executor refuse
 * NEW ENTRIES until the operator starts the next epoch (`promote` /
 * `epoch new`). Unlike the daily halt the latch never expires with the ET
 * day, and unlike the halt it gates nothing risk-reducing: exits, EOD
 * triage, the guardian, the flat-exit sweeper and `close`/`kill` never
 * consult it.
 *
 * Fail-closed: a file that exists but cannot be parsed is treated as a
 * STOPPED epoch — a corrupt latch must not silently reopen intake.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type EpochStatus = 'running' | 'stopped';

export interface EpochState {
    id: string;
    startedAt: number;
    /** The gateway's own strategy fingerprint at epoch start. */
    fingerprint: string;
    status: EpochStatus;
    stopReason?: string;
    stoppedAt?: number;
    /** WP3: hash of the pre-registered sequential-test constants. */
    constantsHash?: string;
    /** WP3: policy label (variant name) the epoch trades. */
    policyLabel?: string;
}

export type EpochFileRead =
    | { kind: 'absent' }
    | { kind: 'present'; state: EpochState }
    | { kind: 'corrupt'; error: string };

export type EpochGateVerdict = { ok: true } | { ok: false; reason: string };

export function epochStatePath(dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data')): string {
    return join(dataDir, 'epoch-state.json');
}

/** Pure: a well-formed epoch record, or null. */
export function parseEpochState(raw: unknown): EpochState | null {
    if (raw === null || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.length === 0) return null;
    if (o.status !== 'running' && o.status !== 'stopped') return null;
    const state: EpochState = {
        id: o.id,
        startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
        fingerprint: typeof o.fingerprint === 'string' ? o.fingerprint : '',
        status: o.status,
    };
    if (typeof o.stopReason === 'string') state.stopReason = o.stopReason;
    if (typeof o.stoppedAt === 'number') state.stoppedAt = o.stoppedAt;
    if (typeof o.constantsHash === 'string') state.constantsHash = o.constantsHash;
    if (typeof o.policyLabel === 'string') state.policyLabel = o.policyLabel;
    return state;
}

/** Classify the epoch file. Never throws. */
export function readEpochState(dataDir?: string): EpochFileRead {
    const p = epochStatePath(dataDir);
    if (!existsSync(p)) return { kind: 'absent' };
    try {
        const state = parseEpochState(JSON.parse(readFileSync(p, 'utf-8')));
        if (state === null) return { kind: 'corrupt', error: 'record does not match the epoch schema' };
        return { kind: 'present', state };
    } catch (err) {
        return { kind: 'corrupt', error: err instanceof Error ? err.message : String(err) };
    }
}

/** Pure: may a NEW ENTRY proceed under this epoch file state? */
export function epochGateVerdict(read: EpochFileRead): EpochGateVerdict {
    switch (read.kind) {
        case 'absent':
            return { ok: true };
        case 'present':
            if (read.state.status === 'running') return { ok: true };
            return {
                ok: false,
                reason: `epoch ${read.state.id} is STOPPED (${read.state.stopReason ?? 'no reason recorded'}) — new entries are paused; ` +
                    `'promote <variant>' or 'epoch new' starts the next epoch. Exits, triage and the guardian keep running.`,
            };
        case 'corrupt':
            return {
                ok: false,
                reason: `epoch-state.json exists but is unreadable (${read.error}) — failing CLOSED for new entries; inspect or delete the file`,
            };
        default: {
            const _exhaustive: never = read;
            throw new Error(`unhandled epoch read: ${JSON.stringify(_exhaustive)}`);
        }
    }
}

/** Gate for the accept path: throws the refusal when the epoch is stopped. */
export function assertEpochRunning(dataDir?: string): void {
    const v = epochGateVerdict(readEpochState(dataDir));
    if (!v.ok) throw new Error(`[epoch-gate] ${v.reason}`);
}
