import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { auditRuntimeAttestation } from '@/utils/equity-series-math.js';

describe('auditRuntimeAttestation (review-31 — only the RUNNING gateway can prove its profile)', () => {
    const NOW = 1_800_000_000_000;
    const GOOD = {
        at: NOW - 30 * 60_000, // 30 min — inside the 2h heartbeat window
        profileEnv: 'live',
        accountType: 'paper',
        maxDailyLossPct: 1.5,
        maxRiskPerTradePct: 0.5,
        strategyFingerprint: 'abc123abc123',
    };
    const EXPECTED = { maxDailyLossPct: 1.5, maxRiskPerTradePct: 0.5, currentFp: 'abc123abc123', nowMs: NOW, maxAgeMs: 2 * 3_600_000 };

    test('a fresh, live-profile, paper-account, fingerprint-matching attestation passes', () => {
        expect(auditRuntimeAttestation(GOOD, EXPECTED)).toEqual([]);
    });

    test('every failure mode is named: missing, stale, wrong account, wrong profile, wrong rules, fingerprint issues', () => {
        expect(auditRuntimeAttestation(null, EXPECTED)[0]).toContain('runtime attestation missing');
        expect(auditRuntimeAttestation({ ...GOOD, at: NOW - 3 * 3_600_000 }, EXPECTED)
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
