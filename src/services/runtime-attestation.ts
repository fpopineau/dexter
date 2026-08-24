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
 * re-written ~90s later (once the account has verified) and hourly as a
 * liveness heartbeat — the scorecard fails a missing, stale, wrong-
 * profile, wrong-account or fingerprint-mismatched attestation.
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

export async function writeRuntimeAttestation(opts?: { stopped?: boolean }): Promise<RuntimeAttestation | null> {
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
}

let timer: ReturnType<typeof setInterval> | null = null;
let postConnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Start the attestation writer (idempotent): boot write, a post-connect
 *  re-write with the verified account, then a 15-min heartbeat. */
export function startRuntimeAttestation(): void {
    if (timer) return;
    void writeRuntimeAttestation();
    if (process.env.NODE_ENV !== 'test') {
        postConnectTimer = setTimeout(() => { postConnectTimer = null; void writeRuntimeAttestation(); }, POST_CONNECT_DELAY_MS);
    }
    timer = setInterval(() => { void writeRuntimeAttestation(); }, HEARTBEAT_MS);
    logger.info(`[runtime-attestation] started: profile/account/fingerprint attested to ${attestationPath()} (${HEARTBEAT_MS / 60_000}-min heartbeat)`);
}

/** Review-32: clear BOTH timers (the post-connect timeout used to
 *  survive shutdown and could refresh the record afterwards) and mark
 *  the record stopped — an orderly shutdown must never read as a
 *  running gateway. */
export function stopRuntimeAttestation(): void {
    if (postConnectTimer) { clearTimeout(postConnectTimer); postConnectTimer = null; }
    if (timer) {
        clearInterval(timer);
        timer = null;
        void writeRuntimeAttestation({ stopped: true });
    }
}
