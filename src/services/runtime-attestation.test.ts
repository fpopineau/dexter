import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { auditRuntimeAttestation } from '@/utils/equity-series-math.js';

describe('auditRuntimeAttestation (review-31 — only the RUNNING gateway can prove its profile)', () => {
    const NOW = 1_800_000_000_000;
    const GOOD = {
        at: NOW - 10 * 60_000, // 10 min — inside the 45-min window (3× the 15-min heartbeat)
        pid: 12345,
        profileEnv: 'live',
        accountType: 'paper',
        maxDailyLossPct: 1.5,
        maxRiskPerTradePct: 0.5,
        strategyFingerprint: 'abc123abc123',
    };
    const EXPECTED = { maxDailyLossPct: 1.5, maxRiskPerTradePct: 0.5, currentFp: 'abc123abc123', nowMs: NOW, maxAgeMs: 45 * 60_000, pidAlive: true as boolean | null };

    test('a fresh, live-profile, paper-account, PID-alive, fingerprint-matching attestation passes', () => {
        expect(auditRuntimeAttestation(GOOD, EXPECTED)).toEqual([]);
    });

    test('review-32 liveness teeth: stopped, dead PID, unknown PID, and a null EXPECTED fingerprint each fail', () => {
        // An orderly shutdown is not a running gateway.
        expect(auditRuntimeAttestation({ ...GOOD, stopped: true }, EXPECTED)
            .some((p) => p.includes('ORDERLY STOP'))).toBe(true);
        // A fresh FILE is not a running PROCESS.
        expect(auditRuntimeAttestation(GOOD, { ...EXPECTED, pidAlive: false })
            .some((p) => p.includes('NOT running'))).toBe(true);
        expect(auditRuntimeAttestation(GOOD, { ...EXPECTED, pidAlive: null })
            .some((p) => p.includes('liveness could not be determined'))).toBe(true);
        // Comparing nothing to something proves nothing — the old code let
        // ANY attested fingerprint reach CONFIRMED when currentFp was null.
        expect(auditRuntimeAttestation(GOOD, { ...EXPECTED, currentFp: null })
            .some((p) => p.includes('could not resolve its own expected fingerprint'))).toBe(true);
    });

    test('every failure mode is named: missing, stale, wrong account, wrong profile, wrong rules, fingerprint issues', () => {
        expect(auditRuntimeAttestation(null, EXPECTED)[0]).toContain('runtime attestation missing');
        expect(auditRuntimeAttestation({ ...GOOD, at: NOW - 3_600_000 }, EXPECTED)
            .some((p) => p.includes('STALE'))).toBe(true);
        expect(auditRuntimeAttestation({ ...GOOD, accountType: 'LIVE' }, EXPECTED)
            .some((p) => p.includes('PAPER account'))).toBe(true);
        expect(auditRuntimeAttestation({ ...GOOD, accountType: 'unverified' }, EXPECTED)
            .some((p) => p.includes('PAPER account'))).toBe(true);
        // The review-31 scenario: env never reached the process — it still
        // runs paper rules while the yaml looks right.
        const paperRules = auditRuntimeAttestation(
            { ...GOOD, profileEnv: null, maxDailyLossPct: 2, maxRiskPerTradePct: 0.25 }, EXPECTED);
        expect(paperRules.some((p) => p.includes("not 'live'"))).toBe(true);
        expect(paperRules.some((p) => p.includes('loaded the wrong rules'))).toBe(true);
        expect(auditRuntimeAttestation({ ...GOOD, strategyFingerprint: null }, EXPECTED)
            .some((p) => p.includes('could not resolve its own strategy fingerprint'))).toBe(true);
        expect(auditRuntimeAttestation({ ...GOOD, strategyFingerprint: 'def456def456' }, EXPECTED)
            .some((p) => p.includes('not this strategy'))).toBe(true);
    });
});

describe('writeRuntimeAttestation (the gateway-side writer)', () => {
    test('writes a well-formed record from the live runtime state', async () => {
        const { writeRuntimeAttestation, attestationPath } = await import('./runtime-attestation.js');
        const record = await writeRuntimeAttestation();
        expect(record).not.toBeNull();
        const onDisk = JSON.parse(readFileSync(attestationPath(), 'utf-8')) as Record<string, unknown>;
        expect(onDisk.pid).toBe(process.pid);
        expect(typeof onDisk.at).toBe('number');
        expect(typeof onDisk.maxDailyLossPct).toBe('number');
        expect(typeof onDisk.maxRiskPerTradePct).toBe('number');
        // Pre-verification (no IBKR in tests): the account is honestly
        // unverified, never invented.
        expect(onDisk.accountType).toBe('unverified');
    });
});
