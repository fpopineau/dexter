/**
 * Runtime attestation (review-31).
 *
 * The scorecard's deployable-classes line is built FROM THE YAML — it
 * prints the live configuration whether or not the running gateway
 * loaded it, so it cannot confirm the process's actual profile. This
 * record is written by the GATEWAY ITSELF: the effective rules facts the
 * process trades under (daily-loss bar, per-trade risk, class flags —
 * under shadow-live the dual deviation forces swing/bets true), the
 * profile env as the process sees it, the verified account and its
 * type, and the process's own strategy fingerprint. Written at boot,
 * re-written ~90s later (once the account has verified) and every 15
 * minutes as a liveness heartbeat — the scorecard fails a missing,
 * stale (>45 min), future-dated, stopped-marked, dead-or-invalid-PID,
 * wrong-profile, wrong-account or fingerprint-mismatched attestation.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/utils';
import { getRiskRules } from '@/tools/ibkr/risk-rules.js';

// 15-min heartbeat (review-32: a shorter beat shrinks the window where a
// crashed gateway still looks attested; the scorecard treats >45 min as
// dead).
const HEARTBEAT_MS = 15 * 60_000;
const POST_CONNECT_DELAY_MS = 90_000;

export interface RuntimeAttestation {
    at: number;
    pid: number;
    profileEnv: string | null;
    account: string | null;
    accountType: 'paper' | 'LIVE' | 'unverified';
    maxDailyLossPct: number;
    maxRiskPerTradePct: number;
    swingEnabled: boolean;
    earningsBetEnabled: boolean;
    strategyFingerprint: string | null;
    /** Review-32: set by the ORDERLY shutdown write — a stopped gateway
     *  must never read as "confirmed running". */
    stopped?: boolean;
}

export function attestationPath(): string {
    return join(process.env.DEXTER_DATA_DIR || join('.dexter', 'data'), 'runtime-attestation.json');
}

// Review-33: writes are SERIALIZED through a promise chain, and once a
// stopped write is requested no later-running write commits — the old
// fire-and-forget stop could return before the stopped record existed,
// and an in-flight heartbeat (fingerprint hashing is async) could then
// overwrite it with a running record.
let writeChain: Promise<unknown> = Promise.resolve();
let stoppedFinal = false;
// Review-34/35: the SHARED stop promise. Latching only the completed
// boolean raced: caller A cleared the timer and awaited the (failing)
// write while concurrent caller B saw timer===null with no verdict yet
// and returned vacuous true — Promise.all([stop(), stop()]) yielded
// [false, true] for the same failed marker (reviewer-reproduced). The
// promise is assigned SYNCHRONOUSLY by the first stop, so every later
// caller awaits the same verdict; reset only by a new lifecycle.
let stopPromise: Promise<boolean> | null = null;

export function writeRuntimeAttestation(opts?: { stopped?: boolean }): Promise<RuntimeAttestation | null> {
    const run = async (): Promise<RuntimeAttestation | null> => {
        if (stoppedFinal && !opts?.stopped) return null; // a running write must never bury the stop marker
        try {
            const rules = getRiskRules();
            let account: string | null = null;
            try {
                const { getVerifiedSingleAccount } = await import('@/tools/ibkr/connection.js');
                account = getVerifiedSingleAccount();
            } catch { /* boot write before the account verifies — the 90s re-write fills it */ }
            const { strategyFingerprint } = await import('./strategy-fingerprint.js');
            const record: RuntimeAttestation = {
                at: Date.now(),
                pid: process.pid,
                profileEnv: process.env.DEXTER_RISK_PROFILE?.trim() ?? null,
                account,
                accountType: account === null ? 'unverified' : account.toUpperCase().startsWith('D') ? 'paper' : 'LIVE',
                maxDailyLossPct: rules.max_daily_loss_pct,
                maxRiskPerTradePct: rules.max_risk_per_trade_pct,
                swingEnabled: rules.swing_enabled,
                earningsBetEnabled: rules.earnings_bet_enabled,
                strategyFingerprint: await strategyFingerprint(),
                ...(opts?.stopped ? { stopped: true } : {}),
            };
            writeFileSync(attestationPath(), JSON.stringify(record, null, 2));
            return record;
        } catch (err) {
            logger.warn(`[runtime-attestation] write failed: ${err instanceof Error ? err.message : err}`);
            return null;
        }
    };
    const p = writeChain.then(run, run);
    writeChain = p;
    return p;
}

let timer: ReturnType<typeof setInterval> | null = null;
let postConnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Start the attestation writer (idempotent): boot write, a post-connect
 *  re-write with the verified account, then a 15-min heartbeat. */
export function startRuntimeAttestation(): void {
    if (timer) return;
    stoppedFinal = false; // an in-process restart re-arms running writes
    stopPromise = null; // a fresh lifecycle gets a fresh stop verdict
    void writeRuntimeAttestation();
    if (process.env.NODE_ENV !== 'test') {
        postConnectTimer = setTimeout(() => { postConnectTimer = null; void writeRuntimeAttestation(); }, POST_CONNECT_DELAY_MS);
    }
    timer = setInterval(() => { void writeRuntimeAttestation(); }, HEARTBEAT_MS);
    logger.info(`[runtime-attestation] started: profile/account/fingerprint attested to ${attestationPath()} (${HEARTBEAT_MS / 60_000}-min heartbeat)`);
}

/** Review-32/33/34/35: clear BOTH timers (the post-connect timeout used
 *  to survive shutdown and could refresh the record afterwards), latch
 *  stoppedFinal BEFORE enqueuing (any in-flight running write ahead in
 *  the chain no-ops at run time), and resolve to whether the stop
 *  marker is CONFIRMED on disk — the write swallows persistence errors
 *  into null (reviewer-reproduced with an invalid data path), and the
 *  caller must see that as false, never as an orderly shutdown.
 *
 *  Deliberately NOT async: the shared stopPromise is assigned before
 *  any suspension point, so CONCURRENT stops all await the SAME
 *  verdict (the async version resolved [false, true] for one failed
 *  write). When the writer was never started this process wrote no
 *  running record to retract — vacuously true. */
export function stopRuntimeAttestation(): Promise<boolean> {
    if (postConnectTimer) { clearTimeout(postConnectTimer); postConnectTimer = null; }
    if (stopPromise) return stopPromise;
    if (!timer) return Promise.resolve(true);
    clearInterval(timer);
    timer = null;
    stoppedFinal = true;
    stopPromise = writeRuntimeAttestation({ stopped: true }).then((record) => record !== null);
    return stopPromise;
}
