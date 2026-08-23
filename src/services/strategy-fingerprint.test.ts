import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeIdentity, fingerprintFromSurfaces, readGitHeadSha, strategyFingerprint } from './strategy-fingerprint.js';
import { fingerprintPurity } from '@/utils/equity-series-math.js';

describe('fingerprintFromSurfaces (review-19 — required identity fails CLOSED, optional absence is a state)', () => {
    const ALL = {
        effectiveRules: '{"a":1}', codeIdentity: 'f'.repeat(40),
        providerModel: 'anthropic:claude-sonnet-5', soul: 'soul', rules: 'rules', skills: 'skills',
    };

    test('all surfaces present → deterministic 12-hex', () => {
        const a = fingerprintFromSurfaces(ALL);
        expect(a).toMatch(/^[0-9a-f]{12}$/);
        expect(fingerprintFromSurfaces({ ...ALL })).toBe(a as string);
    });

    test('ANY required surface null → null (never a valid-looking digest of "absent")', () => {
        expect(fingerprintFromSurfaces({ ...ALL, effectiveRules: null })).toBeNull();
        expect(fingerprintFromSurfaces({ ...ALL, codeIdentity: null })).toBeNull();
        expect(fingerprintFromSurfaces({ ...ALL, providerModel: null })).toBeNull();
    });

    test('optional surfaces: absence is a DIFFERENT state, not a failure', () => {
        const withSoul = fingerprintFromSurfaces(ALL);
        const noSoul = fingerprintFromSurfaces({ ...ALL, soul: null });
        expect(noSoul).toMatch(/^[0-9a-f]{12}$/); // still a fingerprint…
        expect(noSoul).not.toBe(withSoul);        // …but deleting SOUL.md mid-sample changes it
        expect(fingerprintFromSurfaces({ ...ALL, rules: null })).not.toBe(withSoul);
    });

    test('every surface moves the digest', () => {
        const base = fingerprintFromSurfaces(ALL);
        for (const key of ['effectiveRules', 'codeIdentity', 'providerModel', 'soul', 'rules', 'skills'] as const) {
            expect(fingerprintFromSurfaces({ ...ALL, [key]: 'CHANGED' })).not.toBe(base);
        }
    });
});

describe('codeIdentity (review-19 — HEAD alone misses dirty state)', () => {
    test('in this checkout: a 40-hex sha, optionally +dirty.<12-hex> — never a bare lie', async () => {
        const id = await codeIdentity();
        expect(id).toMatch(/^[0-9a-f]{40}(\+dirty\.[0-9a-f]{12})?$/);
    });

    test('outside any repo: null (identity unprovable → the fingerprint fails closed)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'dexter-norepo-'));
        expect(await codeIdentity(dir)).toBeNull();
    });
});

describe('readGitHeadSha (diagnostic .git parser)', () => {
    test('this checkout resolves; non-repos are absent', async () => {
        expect(await readGitHeadSha()).toMatch(/^([0-9a-f]{40}|absent)$/);
        expect(await readGitHeadSha('Z:/definitely/not/a/repo')).toBe('absent');
    });

    test('a worktree/submodule `.git` FILE (gitdir pointer) is followed', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'dexter-worktree-'));
        const sha = 'a'.repeat(40);
        mkdirSync(join(dir, 'gitdir', 'refs', 'heads'), { recursive: true });
        writeFileSync(join(dir, '.git'), 'gitdir: gitdir\n');
        writeFileSync(join(dir, 'gitdir', 'HEAD'), 'ref: refs/heads/main\n');
        writeFileSync(join(dir, 'gitdir', 'refs', 'heads', 'main'), `${sha}\n`);
        expect(await readGitHeadSha(dir)).toBe(sha);
    });
});

describe('strategyFingerprint (the gathered digest)', () => {
    test('stable across calls: either a 12-hex identity or an honest null — never flapping', async () => {
        const a = await strategyFingerprint();
        const b = await strategyFingerprint();
        expect(b).toBe(a);
        if (a !== null) expect(a).toMatch(/^[0-9a-f]{12}$/);
    });
});

describe('fingerprintPurity (STRICT format — review-19)', () => {
    test('exactly one 12-hex value passes; mixed, absent, empty and MALFORMED all fail closed', () => {
        expect(fingerprintPurity(['abc123abc123', 'abc123abc123']).ok).toBe(true);
        expect(fingerprintPurity(['abc123abc123', 'def456def456']).ok).toBe(false); // mid-sample edit
        expect(fingerprintPurity(['abc123abc123', null]).ok).toBe(false);           // unstamped row
        expect(fingerprintPurity(['abc123abc123', undefined]).ok).toBe(false);      // legacy sample line
        expect(fingerprintPurity(['abc123abc123', '']).ok).toBe(false);
        // Malformed stamps prove nothing — same as no stamp (they used to
        // count as ordinary distinct values).
        expect(fingerprintPurity(['not-a-fingerprint']).ok).toBe(false);
        expect(fingerprintPurity(['not-a-fingerprint']).distinct).toEqual(['ABSENT']);
        expect(fingerprintPurity(['ABC123ABC123']).ok).toBe(false); // uppercase is not the format
        expect(fingerprintPurity([]).ok).toBe(false);               // nothing seen = nothing certified
        expect(fingerprintPurity([null]).distinct).toEqual(['ABSENT']);
    });
});
