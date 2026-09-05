/**
 * Epoch control (REQ-EPOCH-001..004, REQ-SEQ-004, live-loop WP3) — the
 * WRITER side of the epoch latch whose reader (`epoch-state.ts`) the accept
 * path consults.
 *
 *   start   `epoch new`: performance reset (USD NetLiq frozen), the record
 *           (id, fingerprint, constants hash, NetLiq), ladder reset unless
 *           carried, one journal line. Precision on REQ-EPOCH-001: the
 *           legacy `performance reset` command resets only the baseline —
 *           its router is a behavior path and is not touched.
 *   stop    REJECT look, −5 % hard stop, or an unresolved broker anomaly:
 *           status 'stopped' + reason, journal, alert, and the operator's
 *           live switch is turned OFF (the system may only ever write
 *           false). Idempotent.
 *   guards  every equity sample: hard stop and ladder step-down.
 *
 * The record is a superset of the behavior reader's schema (extra fields
 * are ignored there, read here).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '@/utils';
import { constantsHash, hardStopDue, type LadderEligibility, type LookDecision } from '@/utils/sequential-test.js';
import { epochStatePath, type EpochState } from '../epoch-state.js';
import { liveSwitchPath } from '../live-switch.js';
import { resetLadder, stepDownIfDue } from './ladder-control.js';

export interface LookRecord {
    n: number;
    at: number;
    decision: LookDecision;
    lcb: number | null;
    ucb95: number | null;
    sumR: number;
    profitFactor: number;
}

export interface LoopEpochRecord extends EpochState {
    netLiq: number | null;
    looksDone: number[];
    looks: LookRecord[];
    firstAcceptAt?: number;
    stepUpEligible?: { nextRung: number; milestone: number; since: number; reason: string } | null;
    promotionPending?: { variant: string; at: number } | null;
    carryRung?: boolean;
}

function dataDirOf(dataDir?: string): string {
    return dataDir ?? process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
}

export function readEpochRecord(dataDir?: string): LoopEpochRecord | null {
    const p = epochStatePath(dataDirOf(dataDir));
    if (!existsSync(p)) return null;
    try {
        const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<LoopEpochRecord>;
        if (typeof raw.id !== 'string' || (raw.status !== 'running' && raw.status !== 'stopped')) return null;
        return {
            id: raw.id,
            startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
            fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : '',
            status: raw.status,
            ...(typeof raw.stopReason === 'string' ? { stopReason: raw.stopReason } : {}),
            ...(typeof raw.stoppedAt === 'number' ? { stoppedAt: raw.stoppedAt } : {}),
            ...(typeof raw.constantsHash === 'string' ? { constantsHash: raw.constantsHash } : {}),
            ...(typeof raw.policyLabel === 'string' ? { policyLabel: raw.policyLabel } : {}),
            netLiq: typeof raw.netLiq === 'number' ? raw.netLiq : null,
            looksDone: Array.isArray(raw.looksDone) ? raw.looksDone.filter((n): n is number => typeof n === 'number') : [],
            looks: Array.isArray(raw.looks) ? (raw.looks as LookRecord[]) : [],
            ...(typeof raw.firstAcceptAt === 'number' ? { firstAcceptAt: raw.firstAcceptAt } : {}),
            stepUpEligible: raw.stepUpEligible ?? null,
            promotionPending: raw.promotionPending ?? null,
            ...(typeof raw.carryRung === 'boolean' ? { carryRung: raw.carryRung } : {}),
        };
    } catch {
        return null;
    }
}

export function writeEpochRecord(rec: LoopEpochRecord, dataDir?: string): void {
    const p = epochStatePath(dataDirOf(dataDir));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(rec, null, 2));
}

function historyPath(dataDir?: string): string {
    return join(dataDirOf(dataDir), 'epochs.jsonl');
}

/** epoch-N: N = one past the number of epochs ever started here. */
export function nextEpochId(dataDir?: string): string {
    let count = 0;
    try {
        if (existsSync(historyPath(dataDir))) {
            count = readFileSync(historyPath(dataDir), 'utf-8').split('\n').filter((l) => l.trim()).length;
        }
    } catch { /* first epoch */ }
    return `epoch-${count + 1}`;
}

export interface StartEpochDeps {
    now: number;
    dataDir?: string;
    /** USD NetLiq to freeze (null = unavailable; recorded, reported). */
    netLiqUsd: number | null;
    fingerprint: string | null;
    policyLabel?: string;
    carryRung?: boolean;
    /** The performance-baseline reset (trade-proposals.setPerformanceBaseline). */
    setBaseline: (note: string, netLiqUsd: number | null) => void;
    journal: (line: string) => void;
}

export function startEpoch(deps: StartEpochDeps): LoopEpochRecord {
    const id = nextEpochId(deps.dataDir);
    deps.setBaseline(`${id} start`, deps.netLiqUsd);
    const rec: LoopEpochRecord = {
        id,
        startedAt: deps.now,
        fingerprint: deps.fingerprint ?? '',
        status: 'running',
        constantsHash: constantsHash(),
        ...(deps.policyLabel ? { policyLabel: deps.policyLabel } : {}),
        netLiq: deps.netLiqUsd,
        looksDone: [],
        looks: [],
        stepUpEligible: null,
        promotionPending: null,
        carryRung: deps.carryRung === true,
    };
    writeEpochRecord(rec, deps.dataDir);
    try {
        mkdirSync(dirname(historyPath(deps.dataDir)), { recursive: true });
        appendFileSync(historyPath(deps.dataDir), `${JSON.stringify({ id, startedAt: deps.now, fingerprint: rec.fingerprint, netLiq: deps.netLiqUsd, policyLabel: deps.policyLabel ?? null })}\n`);
    } catch (err) {
        logger.warn(`[epoch] history append failed: ${err}`);
    }
    const ladder = resetLadder({ now: deps.now, dataDir: deps.dataDir, journal: deps.journal, carry: deps.carryRung, epochId: id });
    deps.journal(
        `${id} START ${new Date(deps.now).toISOString()} fp ${rec.fingerprint || 'UNRESOLVED'} constants ${rec.constantsHash} ` +
        `netliq ${deps.netLiqUsd !== null ? `$${deps.netLiqUsd.toFixed(2)}` : 'UNAVAILABLE'} rung ${ladder.rung}` +
        `${deps.policyLabel ? ` policy ${deps.policyLabel}` : ''}`,
    );
    return rec;
}

export interface StopEpochDeps {
    now: number;
    dataDir?: string;
    reason: string;
    journal: (line: string) => void;
    alert?: (message: string) => void;
}

/** Turn the operator's live switch OFF (REQ-EPOCH-002). The system may only
 *  ever write `false`; `true` is the confirmed `live on` command (WP4). */
export function writeLiveSwitchOff(reason: string, now: number, dataDir?: string): void {
    const p = liveSwitchPath(dataDirOf(dataDir));
    let prev: { enabled?: boolean } | null = null;
    try { if (existsSync(p)) prev = JSON.parse(readFileSync(p, 'utf-8')) as { enabled?: boolean }; } catch { prev = null; }
    if (prev && prev.enabled === false) return; // already off — keep the operator's own record
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ enabled: false, changedAt: new Date(now).toISOString(), by: 'system', reason }, null, 2));
}

export function stopEpoch(deps: StopEpochDeps): LoopEpochRecord | null {
    const rec = readEpochRecord(deps.dataDir);
    if (!rec) return null;
    if (rec.status === 'stopped') return rec; // idempotent
    const stopped: LoopEpochRecord = { ...rec, status: 'stopped', stopReason: deps.reason, stoppedAt: deps.now, stepUpEligible: null };
    writeEpochRecord(stopped, deps.dataDir);
    writeLiveSwitchOff(`epoch ${rec.id} stopped: ${deps.reason}`, deps.now, deps.dataDir);
    deps.journal(`${rec.id} STOP ${new Date(deps.now).toISOString()} — ${deps.reason}`);
    deps.alert?.(`🛑 ${rec.id} STOPPED — ${deps.reason}. New entries are paused (exits, triage and the guardian keep running); the live switch is OFF. 'promote <variant>' or 'epoch new' starts the next epoch.`);
    return stopped;
}

export interface EquityGuardDeps {
    now: number;
    dataDir?: string;
    journal: (line: string) => void;
    alert?: (message: string) => void;
}

/** REQ-SEQ-004 + REQ-LADDER-002, evaluated on every equity sample. */
export function evaluateEquityGuards(markedNetLiq: number, deps: EquityGuardDeps): { hardStop: boolean; stepDown: boolean } {
    let hardStop = false;
    let stepDown = false;
    if (!(markedNetLiq > 0)) return { hardStop, stepDown };
    const rec = readEpochRecord(deps.dataDir);
    if (rec && rec.status === 'running' && rec.netLiq !== null && hardStopDue(markedNetLiq, rec.netLiq)) {
        stopEpoch({
            now: deps.now, dataDir: deps.dataDir, journal: deps.journal, alert: deps.alert,
            reason: `-5% hard stop: marked NetLiq $${markedNetLiq.toFixed(2)} ≤ 95% of the epoch NetLiq $${rec.netLiq.toFixed(2)}`,
        });
        hardStop = true;
    }
    if (stepDownIfDue({ now: deps.now, dataDir: deps.dataDir, journal: deps.journal, alert: deps.alert, markedNetLiq })) {
        stepDown = true;
    }
    return { hardStop, stepDown };
}

export function recordStepUpEligibility(el: LadderEligibility | null, now: number, dataDir?: string): void {
    const rec = readEpochRecord(dataDir);
    if (!rec) return;
    const next = el && el.eligible && el.nextRung !== null && el.milestone !== null
        ? (rec.stepUpEligible && rec.stepUpEligible.nextRung === el.nextRung
            ? rec.stepUpEligible
            : { nextRung: el.nextRung, milestone: el.milestone, since: now, reason: el.reason })
        : null;
    if (JSON.stringify(next) !== JSON.stringify(rec.stepUpEligible ?? null)) {
        writeEpochRecord({ ...rec, stepUpEligible: next }, dataDir);
    }
}
