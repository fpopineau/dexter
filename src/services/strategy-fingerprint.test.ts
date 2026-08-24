import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyWorkingTree, codeIdentity, fingerprintFromSurfaces, readGitHeadSha, strategyFingerprint } from './strategy-fingerprint.js';
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

describe('classifyWorkingTree (review-20/21 — RUNTIME dirty, NUL-delimited, spaces survive)', () => {
    const z = (...entries: string[]) => entries.join('\u0000') + '\u0000';

    test('identity-irrelevant untracked noise does not dirty the checkout', () => {
        const t = classifyWorkingTree(z('?? .claude/settings.local.json', '?? docs/notes.md', '?? scratch.txt'));
        expect(t.hasTrackedChanges).toBe(false);
        expect(t.untrackedRuntime).toEqual([]);
    });

    test('untracked RUNTIME files and any tracked change are identity-relevant', () => {
        const t = classifyWorkingTree(z(' M src/services/foo.ts', '?? src/services/new-module.ts', '?? scripts/tool.ts', '?? .claude/x.json'));
        expect(t.hasTrackedChanges).toBe(true);
        expect(t.untrackedRuntime).toEqual(['scripts/tool.ts', 'src/services/new-module.ts']);
    });

    test('review-21: a path WITH SPACES is seen (the newline form quoted it into invisibility)', () => {
        const t = classifyWorkingTree(z('?? src/foo bar.ts'));
        expect(t.untrackedRuntime).toEqual(['src/foo bar.ts']);
    });

    test('renames carry the origin as the NEXT token — consumed, never misread as a path', () => {
        const t = classifyWorkingTree(z('R  src/b.ts', 'src/a.ts', '?? SOUL.md'));
        expect(t.hasTrackedChanges).toBe(true);
        expect(t.untrackedRuntime).toEqual(['SOUL.md']); // src/a.ts is the rename origin, not untracked
    });

    test('staged and root-config changes count; empty tree is clean', () => {
        expect(classifyWorkingTree(z('M  src/a.ts')).hasTrackedChanges).toBe(true);
        expect(classifyWorkingTree(z('?? package.json')).untrackedRuntime).toEqual(['package.json']);
        expect(classifyWorkingTree('').hasTrackedChanges).toBe(false);
    });
});

describe('codeIdentity (review-19/22 — tree-based, dirty-content-aware)', () => {
    test('in this checkout: tree.<12-hex>, optionally +dirty.<12-hex> — never a bare lie', async () => {
        const id = await codeIdentity();
        expect(id).toMatch(/^tree\.[0-9a-f]{12}(\+dirty\.[0-9a-f]{12})?$/);
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

describe('codeIdentity on a REAL temporary repository (review-21)', () => {
    test('editing an already-dirty file CHANGES the identity — content, not names', async () => {
        const { execFileSync } = await import('node:child_process');
        const dir = mkdtempSync(join(tmpdir(), 'dexter-gitid-'));
        const g = (...args: string[]) => execFileSync('git', args, { cwd: dir });
        g('init', '-q');
        g('config', 'user.email', 'test@dexter');
        g('config', 'user.name', 'dexter-test');
        g('config', 'commit.gpgsign', 'false');
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'a.ts'), 'v1');
        g('add', '.');
        g('commit', '-qm', 'init');

        const clean = await codeIdentity(dir);
        expect(clean).toMatch(/^tree\.[0-9a-f]{12}$/);

        writeFileSync(join(dir, 'src', 'a.ts'), 'v2');
        const dirty1 = await codeIdentity(dir);
        expect(dirty1).toMatch(/\+dirty\.[0-9a-f]{12}$/);

        // The review-20 defect: status names alone left this UNCHANGED.
        writeFileSync(join(dir, 'src', 'a.ts'), 'v3');
        const dirty2 = await codeIdentity(dir);
        expect(dirty2).toMatch(/\+dirty\.[0-9a-f]{12}$/);
        expect(dirty2).not.toBe(dirty1);

        // The review-21 defect: an untracked runtime file with a SPACE in
        // its name was quoted into invisibility by the newline form.
        writeFileSync(join(dir, 'src', 'foo bar.ts'), 'x');
        const dirty3 = await codeIdentity(dir);
        expect(dirty3).not.toBe(dirty2);

        // Irrelevant untracked noise leaves the identity untouched.
        writeFileSync(join(dir, 'notes.txt'), 'irrelevant');
        expect(await codeIdentity(dir)).toBe(dirty3);
    });

    test('review-22: a DOCS-ONLY commit leaves the identity unchanged — the manifest workflow cannot perturb the fingerprint it records', async () => {
        const { execFileSync } = await import('node:child_process');
        const dir = mkdtempSync(join(tmpdir(), 'dexter-treeid-'));
        const g = (...args: string[]) => execFileSync('git', args, { cwd: dir });
        g('init', '-q');
        g('config', 'user.email', 'test@dexter');
        g('config', 'user.name', 'dexter-test');
        g('config', 'commit.gpgsign', 'false');
        mkdirSync(join(dir, 'src'), { recursive: true });
        mkdirSync(join(dir, 'docs'), { recursive: true });
        writeFileSync(join(dir, 'src', 'a.ts'), 'runtime');
        writeFileSync(join(dir, 'docs', 'MANIFEST.md'), 'fingerprint: _pending_');
        g('add', '.');
        g('commit', '-qm', 'baseline');
        const baseline = await codeIdentity(dir);
        expect(baseline).toMatch(/^tree\.[0-9a-f]{12}$/);

        // The manifest workflow: fill the doc, commit docs-only. Under the
        // old HEAD-based identity this changed the fingerprint the
        // manifest had just recorded — self-referential by construction.
        writeFileSync(join(dir, 'docs', 'MANIFEST.md'), 'fingerprint: abc123abc123');
        g('add', 'docs');
        g('commit', '-qm', 'manifest only');
        expect(await codeIdentity(dir)).toBe(baseline);

        // A RUNTIME commit does change it.
        writeFileSync(join(dir, 'src', 'a.ts'), 'runtime v2');
        g('add', 'src');
        g('commit', '-qm', 'runtime change');
        expect(await codeIdentity(dir)).not.toBe(baseline);
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

describe('fingerprintFreezeCheck requireManifest (review-22 — a missing manifest must not pass a FINAL evaluation)', () => {
    test('pre-tag: null manifest is diagnostics; final: it fails', async () => {
        const { fingerprintFreezeCheck } = await import('@/utils/equity-series-math.js');
        const fp = 'abc123abc123';
        // Pre-tag diagnostics: sample==current with no manifest passes.
        expect(fingerprintFreezeCheck({ sampleFp: fp, currentFp: fp, manifestFp: null }).ok).toBe(true);
        // Final evaluation (tag exists or --final): the manifest is REQUIRED.
        const final = fingerprintFreezeCheck({ sampleFp: fp, currentFp: fp, manifestFp: null, requireManifest: true });
        expect(final.ok).toBe(false);
        expect(final.problems.some((p) => p.includes('REQUIRED'))).toBe(true);
        // A filled, matching manifest passes final.
        expect(fingerprintFreezeCheck({ sampleFp: fp, currentFp: fp, manifestFp: fp, requireManifest: true }).ok).toBe(true);
        // A mismatched one fails regardless of mode.
        expect(fingerprintFreezeCheck({ sampleFp: fp, currentFp: fp, manifestFp: 'def456def456', requireManifest: true }).ok).toBe(false);
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
