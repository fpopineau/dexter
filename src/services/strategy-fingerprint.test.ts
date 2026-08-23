import { describe, expect, test } from 'bun:test';
import { readGitHeadSha, strategyFingerprint } from './strategy-fingerprint.js';
import { fingerprintPurity } from '@/utils/equity-series-math.js';

describe('strategyFingerprint (REQ-VAL-019 — the machine-checked freeze)', () => {
    test('12-hex and deterministic for one runtime state', async () => {
        const a = await strategyFingerprint();
        const b = await strategyFingerprint();
        expect(a).toMatch(/^[0-9a-f]{12}$/);
        expect(b).toBe(a);
    });

    test('the running code SHA resolves from the checkout; a non-repo is honestly absent', async () => {
        // The suite runs from the repo — HEAD must resolve to a real commit
        // (40-hex). 'absent' is tolerated only for detached/packed edge
        // states the parser cannot follow, never a crash.
        expect(await readGitHeadSha()).toMatch(/^([0-9a-f]{40}|absent)$/);
        expect(await readGitHeadSha('Z:/definitely/not/a/repo')).toBe('absent');
    });
});

describe('fingerprintPurity (the scorecard freeze-purity decision, review-18)', () => {
    test('exactly one real fingerprint passes; mixed, absent and empty all fail closed', () => {
        expect(fingerprintPurity(['abc123abc123', 'abc123abc123']).ok).toBe(true);
        // A mid-sample edit is a DIFFERENT strategy, not more data.
        expect(fingerprintPurity(['abc123abc123', 'def456def456']).ok).toBe(false);
        // An unstamped row/sample means the instrumentation cannot prove purity.
        expect(fingerprintPurity(['abc123abc123', null]).ok).toBe(false);
        expect(fingerprintPurity(['abc123abc123', undefined]).ok).toBe(false);
        expect(fingerprintPurity(['abc123abc123', '']).ok).toBe(false);
        // Nothing seen = nothing certified.
        expect(fingerprintPurity([]).ok).toBe(false);
        expect(fingerprintPurity([null]).distinct).toEqual(['ABSENT']);
    });
});
