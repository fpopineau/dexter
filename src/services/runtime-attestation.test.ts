import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

    test('review-33: future-dated records, non-finite timestamps and malformed PIDs fail', () => {
        // A record dated a day AHEAD stayed "fresh" forever under the
        // one-sided check (clock rollback / malformed record).
        expect(auditRuntimeAttestation({ ...GOOD, at: NOW + 24 * 3_600_000 }, EXPECTED)
            .some((p) => p.includes('in the FUTURE'))).toBe(true);
        // Small clock skew is tolerated.
        expect(auditRuntimeAttestation({ ...GOOD, at: NOW + 60_000 }, EXPECTED)).toEqual([]);
        expect(auditRuntimeAttestation({ ...GOOD, at: Number.NaN }, EXPECTED)
            .some((p) => p.includes('no usable timestamp'))).toBe(true);
        // PID 0 targets the caller's own process group and "succeeds" on
        // Windows — shape fails before liveness is asked.
        expect(auditRuntimeAttestation({ ...GOOD, pid: 0 }, EXPECTED)
            .some((p) => p.includes('not a valid process id'))).toBe(true);
        expect(auditRuntimeAttestation({ ...GOOD, pid: 1.5 }, EXPECTED)
            .some((p) => p.includes('not a valid process id'))).toBe(true);
        expect(auditRuntimeAttestation({ ...GOOD, pid: -4 }, EXPECTED)
            .some((p) => p.includes('not a valid process id'))).toBe(true);
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
    }, 30_000);

    test('review-33: stop AWAITS the stopped record, and racing running writes can never bury it', async () => {
        const { startRuntimeAttestation, stopRuntimeAttestation, writeRuntimeAttestation, attestationPath } =
            await import('./runtime-attestation.js');
        startRuntimeAttestation();
        // A running write STILL IN FLIGHT when stop is called (the exact
        // reproduced race: async fingerprint hashing finishes after the
        // stop and used to overwrite the stopped marker).
        const inflight = writeRuntimeAttestation();
        // Returns only once stopped:true is ON DISK — and review-34:
        // a clean stop CONFIRMS the marker with true.
        expect(await stopRuntimeAttestation()).toBe(true);
        expect((JSON.parse(readFileSync(attestationPath(), 'utf-8')) as { stopped?: boolean }).stopped).toBe(true);
        await inflight;
        // A running write enqueued AFTER the stop no-ops entirely.
        expect(await writeRuntimeAttestation()).toBeNull();
        expect((JSON.parse(readFileSync(attestationPath(), 'utf-8')) as { stopped?: boolean }).stopped).toBe(true);
        startRuntimeAttestation(); // re-arm cleanly for any later suite
        await stopRuntimeAttestation();
    }, 30_000);

    test('review-34: a FAILED stopped-record write surfaces false — never a silent orderly shutdown', async () => {
        const { startRuntimeAttestation, stopRuntimeAttestation } = await import('./runtime-attestation.js');
        const prev = process.env.DEXTER_DATA_DIR;
        // A data dir that does not exist: writeFileSync ENOENTs, the
        // writer swallows it into null, and the old void stop returned
        // "successfully" with no marker written (reviewer-reproduced).
        process.env.DEXTER_DATA_DIR = join('.dexter', 'data', '__review34-missing__', 'nested');
        try {
            startRuntimeAttestation();
            expect(await stopRuntimeAttestation()).toBe(false);
            // The latch keeps a SECOND stop honest — the marker still
            // is not on disk, so it must not report vacuous success.
            expect(await stopRuntimeAttestation()).toBe(false);
        } finally {
            if (prev === undefined) delete process.env.DEXTER_DATA_DIR;
            else process.env.DEXTER_DATA_DIR = prev;
        }
        // A restart re-arms the verdict and a healthy stop confirms.
        startRuntimeAttestation();
        expect(await stopRuntimeAttestation()).toBe(true);
    }, 30_000);

    test('review-35: CONCURRENT stops share ONE verdict — never [false, true]', async () => {
        const { startRuntimeAttestation, stopRuntimeAttestation } = await import('./runtime-attestation.js');
        const prev = process.env.DEXTER_DATA_DIR;
        // The reproduced race: caller A cleared the timer and awaited the
        // failing write; caller B saw timer===null with no verdict latched
        // yet and returned vacuous true — [false, true] for ONE failed
        // marker. The shared stopPromise makes both await the same truth.
        process.env.DEXTER_DATA_DIR = join('.dexter', 'data', '__review35-missing__', 'nested');
        try {
            startRuntimeAttestation();
            expect(await Promise.all([stopRuntimeAttestation(), stopRuntimeAttestation()])).toEqual([false, false]);
        } finally {
            if (prev === undefined) delete process.env.DEXTER_DATA_DIR;
            else process.env.DEXTER_DATA_DIR = prev;
        }
        // Healthy path: concurrent stops both confirm the marker.
        startRuntimeAttestation();
        expect(await Promise.all([stopRuntimeAttestation(), stopRuntimeAttestation()])).toEqual([true, true]);
    }, 30_000);
});
