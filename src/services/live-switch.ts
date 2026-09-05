/**
 * Live switch — READER only in WP1 (REQ-LIVE-001 seam; the producers —
 * `live on` challenge/confirm, `live off`, the system's own OFF on an
 * epoch stop — land in WP4).
 *
 * The operator's warm switch for live auto-execution: a state file, not an
 * env var, so flipping it needs no restart and touches no fingerprint
 * surface. Absent file = OFF. Nothing in the system may ever write
 * `enabled: true`; WP4's writer is the operator's confirmed command only.
 * A file that exists but cannot be parsed reads as OFF (fail-closed).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LiveSwitchState {
    enabled: boolean;
    changedAt?: string;
    by?: string;
    reason?: string;
}

export function liveSwitchPath(dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data')): string {
    return join(dataDir, 'live-switch.json');
}

export function parseLiveSwitch(raw: unknown): LiveSwitchState | null {
    if (raw === null || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.enabled !== 'boolean') return null;
    const s: LiveSwitchState = { enabled: o.enabled };
    if (typeof o.changedAt === 'string') s.changedAt = o.changedAt;
    if (typeof o.by === 'string') s.by = o.by;
    if (typeof o.reason === 'string') s.reason = o.reason;
    return s;
}

export function readLiveSwitch(dataDir?: string): LiveSwitchState | null {
    const p = liveSwitchPath(dataDir);
    if (!existsSync(p)) return null;
    try {
        return parseLiveSwitch(JSON.parse(readFileSync(p, 'utf-8')));
    } catch {
        return null;
    }
}

/** OFF unless a well-formed file says `enabled: true`. */
export function isLiveEnabled(dataDir?: string): boolean {
    return readLiveSwitch(dataDir)?.enabled === true;
}

export function describeLiveSwitch(dataDir?: string): string {
    const s = readLiveSwitch(dataDir);
    if (!s) return 'live switch: OFF (no state file — live auto-execution structurally off)';
    return `live switch: ${s.enabled ? 'ON' : 'OFF'}${s.changedAt ? ` since ${s.changedAt}` : ''}${s.by ? ` by ${s.by}` : ''}${s.reason ? ` — ${s.reason}` : ''}`;
}
