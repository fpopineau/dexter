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
        behaviorEnv: 'EOD_TRIAGE=unset',
        judgmentConfig: 'cron:[]|search:unset',
        scorerWeights: '{"source":"defaults"}',
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
        // Review-26: scorer weights are selection policy — required.
        expect(fingerprintFromSurfaces({ ...ALL, scorerWeights: null })).toBeNull();
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
        for (const key of ['effectiveRules', 'codeIdentity', 'providerModel', 'soul', 'rules', 'skills', 'behaviorEnv', 'judgmentConfig', 'scorerWeights'] as const) {
            expect(fingerprintFromSurfaces({ ...ALL, [key]: 'CHANGED' })).not.toBe(base);
        }
    });
});

describe('behaviorEnvInput (review-23 — env-controlled policy is part of the identity)', () => {
    test('policy values ride raw with an unset sentinel; capability env rides PRESENCE only, never the value', async () => {
        const { behaviorEnvInput } = await import('./strategy-fingerprint.js');
        const a = behaviorEnvInput({});
        expect(a).toContain('EOD_TRIAGE=unset');
        expect(a).toContain('ANTHROPIC_API_KEY:absent');
        const b = behaviorEnvInput({ OPP_TRIGGER_SCORE: '85', ANTHROPIC_API_KEY: 'sk-secret-value' });
        expect(b).toContain('OPP_TRIGGER_SCORE=85');
        expect(b).toContain('ANTHROPIC_API_KEY:present');
        expect(b).not.toContain('sk-secret-value'); // secrets NEVER enter the digest input
        expect(b).not.toBe(a);
        // The reviewer's exact concern: flipping a selection threshold or an
        // EOD switch changes the identity.
        expect(behaviorEnvInput({ EOD_TRIAGE: 'false' })).not.toBe(a);
        expect(behaviorEnvInput({ UNIVERSE_EXTRA_SYMBOLS: 'GME' })).not.toBe(a);
        expect(behaviorEnvInput({ CHASE_CONTINUATION: 'true' })).not.toBe(a);
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
        const afterRuntime = await codeIdentity(dir);
        expect(afterRuntime).not.toBe(baseline);

        // Review-23: the LOCKFILE is part of the executable dependency
        // graph — a lockfile-only commit must move the identity too.
        writeFileSync(join(dir, 'bun.lock'), '{"lockfileVersion": 1}');
        g('add', 'bun.lock');
        g('commit', '-qm', 'lockfile only');
        expect(await codeIdentity(dir)).not.toBe(afterRuntime);
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

describe('judgmentConfigInput (review-24 — cron jobs and search preference are judgment inputs)', () => {
    test('canonical, deterministic, and carries the cron + search surfaces', async () => {
        const { judgmentConfigInput } = await import('./strategy-fingerprint.js');
        const a = judgmentConfigInput();
        expect(a).toBe(judgmentConfigInput()); // deterministic for one runtime state
        expect(a).toMatch(/^cron:\[/);
        expect(a).toContain('|search:');
    });

    test('review-24 capability additions: the web-search provider keys ride as presence flags', async () => {
        const { behaviorEnvInput } = await import('./strategy-fingerprint.js');
        const none = behaviorEnvInput({});
        expect(none).toContain('PERPLEXITY_API_KEY:absent');
        expect(none).toContain('TAVILY_API_KEY:absent');
        expect(none).toContain('LANGSEARCH_API_KEY:absent');
        const withKeys = behaviorEnvInput({ PERPLEXITY_API_KEY: 'pk-secret' });
        expect(withKeys).toContain('PERPLEXITY_API_KEY:present');
        expect(withKeys).not.toContain('pk-secret');
        expect(withKeys).not.toBe(none);
    });
});

describe('auditFreezeManifest (review-24/25 — a schema audit, not substring counting)', () => {
    // A GENUINELY complete manifest: all 13 required identity rows, all 6
    // broker-observation rows, and the scope line (review-25: the old
    // "filled" fixture omitted most rows and still audited clean).
    const filled = `# Freeze manifest
| Field | Value |
|---|---|
| Freeze tag | validation-freeze-1 |
| Behavioral baseline commit SHA | ${'a'.repeat(40)} |
| Manifest commit docs-only diff verified | verified 2026-08-25 (FP) |
| Tagged at (UTC) | 2026-08-25T20:10:00Z |
| Model string | claude-sonnet-5 |
| Provider string | anthropic |
| \`exit_style\` | target |
| Strategy fingerprint (scorecard prints it) | abc123abc123 |
| SHA-256 of \`.dexter/RULES.md\` | ${'b'.repeat(64)} |
| SHA-256 of \`performance-epoch.json\` | ${'c'.repeat(64)} |
| Epoch NetLiq (frozen denominator) | 12257 |
| Scorer-weights provenance | pinned 2026-08-11 run (FP) |
| \`risk-rules.live.yaml\` ratified | FP 2026-08-25 |
| OCA-joined close cancels its siblings broker-side | observed 2026-08-25 AAPL #101/#102 |
| Mixed-TIF bracket: unfilled DAY parent expiry removes the dormant GTC children | observed 2026-08-25 MU #201/#202 |
| Mixed-TIF bracket: fully filled DAY parent leaves both GTC exits active overnight | observed 2026-08-26 NVDA #301/#303 |
| Mixed-TIF bracket: PARTIALLY filled DAY parent at expiry leaves correctly sized GTC protection | WAIVED FP: hard to stage; WP2 observed |
| WP2 partial-fill resize | observed 2026-08-26 NVDA resize #302 |
| WP11 buffered finalize events | WAIVED FP: harness coverage accepted |
- The deployable verdict scope at tag time (record them here): intraday
`;

    test('a complete manifest audits clean and yields the identity fields', async () => {
        const { auditFreezeManifest } = await import('@/utils/equity-series-math.js');
        const a = auditFreezeManifest(filled, { tag: 'validation-freeze-1', deployableClasses: ['intraday'] });
        expect(a.problems).toEqual([]);
        expect(a.fingerprint).toBe('abc123abc123');
        expect(a.baselineSha).toBe('a'.repeat(40));
    });

    test('review-25 schema teeth: missing rows, "not observed", illegal waivers and the WP2 dependency all fail', async () => {
        const { auditFreezeManifest } = await import('@/utils/equity-series-math.js');
        const exp = { tag: 'validation-freeze-1', deployableClasses: ['intraday'] };
        // Deleting a mandatory row is its own failure (substring counting missed it).
        const noEpoch = filled.split('\n').filter((l) => !l.includes('SHA-256 of `performance-epoch.json`')).join('\n');
        expect(auditFreezeManifest(noEpoch, exp).problems.some((x) => x.includes("row missing: 'SHA-256 of `performance-epoch.json`"))).toBe(true);
        // 'not observed' is not an observation.
        const notObs = filled.replace('observed 2026-08-25 AAPL #101/#102', 'not observed');
        expect(auditFreezeManifest(notObs, exp).problems.some((x) => x.includes('neither observed nor a valid waiver'))).toBe(true);
        // Waiving a non-waivable observation fails.
        const waivedOca = filled.replace('observed 2026-08-25 AAPL #101/#102', 'WAIVED FP: too hard');
        expect(auditFreezeManifest(waivedOca, exp).problems.some((x) => x.includes('NOT waivable'))).toBe(true);
        // The partial-expiry waiver DEPENDS on the WP2 observation.
        const wp2Waived = filled.replace('observed 2026-08-26 NVDA resize #302', 'WAIVED FP: skipped');
        expect(auditFreezeManifest(wp2Waived, exp).problems.some((x) => x.includes('requires the WP2'))).toBe(true);
        // Arbitrary text in an identity row fails its validator.
        const badFp = filled.replace('abc123abc123', 'looks fine to me');
        expect(auditFreezeManifest(badFp, exp).problems.some((x) => x.includes('12-hex'))).toBe(true);
        // Wrong tag, wrong scope (both directions) still fail.
        expect(auditFreezeManifest(filled, { tag: 'other-tag', deployableClasses: ['intraday'] }).problems.some((x) => x.includes('freeze tag'))).toBe(true);
        expect(auditFreezeManifest(filled, { tag: 'validation-freeze-1', deployableClasses: ['intraday', 'swing'] }).problems.some((x) => x.includes("'swing' not recorded"))).toBe(true);
    });

    test('review-26: a status word without EVIDENCE fails the grammar', async () => {
        const { auditFreezeManifest } = await import('@/utils/equity-series-math.js');
        const exp = { tag: 'validation-freeze-1', deployableClasses: ['intraday'] };
        // Bare 'observed' — no date, no symbol, no details.
        const bareObs = filled.replace('observed 2026-08-25 AAPL #101/#102', 'observed');
        expect(auditFreezeManifest(bareObs, exp).problems.some((x) => x.includes('lacks the required evidence'))).toBe(true);
        // Date + symbol but NO order ids on a broker-interaction row.
        const noIds = filled.replace('observed 2026-08-25 AAPL #101/#102', 'observed 2026-08-25 AAPL sibling cancel seen');
        expect(auditFreezeManifest(noIds, exp).problems.some((x) => x.includes('order id'))).toBe(true);
        // Bare 'WAIVED' — no initials, no reason.
        const bareWaiver = filled.replace('WAIVED FP: harness coverage accepted', 'WAIVED');
        expect(auditFreezeManifest(bareWaiver, exp).problems.some((x) => x.includes('lacks initials and a reason'))).toBe(true);
        // The complete fixture's own values pass all grammars.
        expect(auditFreezeManifest(filled, exp).problems).toEqual([]);
        // Parsed identity fields for the review-26 window checks.
        const a = auditFreezeManifest(filled, exp);
        expect(a.epochSha).toBe('c'.repeat(64));
        expect(a.taggedAtMs).toBe(Date.parse('2026-08-25T20:10:00Z'));
    });

    test('the real template (all three placeholder variants) fails loudly', async () => {
        const { auditFreezeManifest } = await import('@/utils/equity-series-math.js');
        const { readFileSync } = await import('node:fs');
        const template = readFileSync('docs/day2day/FREEZE-MANIFEST.md', 'utf-8');
        const a = auditFreezeManifest(template, { tag: 'validation-freeze-1', deployableClasses: ['intraday'] });
        expect(a.problems.some((x) => x.includes("'_pending_'"))).toBe(true);
        expect(a.problems.some((x) => x.includes("'_REQUIRED'"))).toBe(true);
        // Review-25: the parenthesized waiver variant is matched by prefix.
        expect(a.problems.some((x) => x.includes("'_observation or explicit waiver'"))).toBe(true);
        expect(a.fingerprint).toBeNull();
        expect(a.baselineSha).toBeNull();
    });
});

describe('memory policy in the identity (review-25)', () => {
    test('the embedding capability keys ride as presence flags; the judgment surface carries memory settings', async () => {
        const { behaviorEnvInput, judgmentConfigInput } = await import('./strategy-fingerprint.js');
        const none = behaviorEnvInput({});
        expect(none).toContain('OPENAI_API_KEY:absent');
        expect(none).toContain('GOOGLE_API_KEY:absent');
        const withKey = behaviorEnvInput({ OPENAI_API_KEY: 'sk-openai-secret' });
        expect(withKey).toContain('OPENAI_API_KEY:present');
        expect(withKey).not.toContain('sk-openai-secret');
        // The judgment surface always carries a memory section (settings or
        // the 'unset' sentinel = runtime defaults).
        expect(judgmentConfigInput()).toMatch(/\|memory:/);
    });
});

describe('scorer weights in the identity (review-26)', () => {
    test('the fingerprint carries the scorer OWN resolution — weights, source, provenance', async () => {
        const { strategyFingerprint } = await import('./strategy-fingerprint.js');
        const { getActiveWeightsInfo, setActiveWeights } = await import('@/tools/ibkr/signal-scorer.js');
        // The surface uses getActiveWeightsInfo — assert the resolution
        // exists and an in-process override (calibration) MOVES the digest.
        const before = await strategyFingerprint();
        const info = getActiveWeightsInfo();
        expect(info.weights.momentum + info.weights.meanReversion + info.weights.volume + info.weights.trend).toBeCloseTo(1, 6);
        setActiveWeights({ momentum: 0.7, meanReversion: 0.1, volume: 0.1, trend: 0.1 });
        try {
            const after = await strategyFingerprint();
            // Either both null (identity unresolvable in this env) or different.
            if (before !== null && after !== null) expect(after).not.toBe(before);
        } finally {
            setActiveWeights(null);
        }
    });
});

describe('resolveFreezeTagTime on a REAL repository (review-27 — the TAGGER clock, never the commit clock)', () => {
    test('annotated tag yields its tagger timestamp; lightweight and missing tags are rejected', async () => {
        const { resolveFreezeTagTime } = await import('./strategy-fingerprint.js');
        const { execFileSync } = await import('node:child_process');
        const dir = mkdtempSync(join(tmpdir(), 'dexter-tagtime-'));
        const env = { ...process.env, GIT_AUTHOR_DATE: '2026-08-25T10:00:00Z', GIT_COMMITTER_DATE: '2026-08-25T10:00:00Z' };
        const g = (args: string[], e = env) => execFileSync('git', args, { cwd: dir, env: e });
        g(['init', '-q']);
        g(['config', 'user.email', 'test@dexter']);
        g(['config', 'user.name', 'dexter-test']);
        g(['config', 'commit.gpgsign', 'false']);
        g(['config', 'tag.gpgsign', 'false']);
        writeFileSync(join(dir, 'a.txt'), 'x');
        g(['add', '.']);
        g(['commit', '-qm', 'baseline']);

        // The tag is created FOUR HOURS after the commit — the review-27
        // hole: `git log` reports 10:00 and leaks the interval's trades.
        const tagEnv = { ...env, GIT_COMMITTER_DATE: '2026-08-25T14:00:00Z' };
        g(['tag', '-a', 'validation-freeze-1', '-m', 'freeze'], tagEnv);
        const r = await resolveFreezeTagTime('validation-freeze-1', dir);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.tagTimeMs).toBe(Date.parse('2026-08-25T14:00:00Z')); // the TAGGER clock
            expect(r.tagTimeMs).not.toBe(Date.parse('2026-08-25T10:00:00Z')); // never the commit clock
        }

        // A lightweight tag has no creation timestamp — rejected by type.
        g(['tag', 'light-tag']);
        const light = await resolveFreezeTagTime('light-tag', dir);
        expect(light.ok).toBe(false);
        if (!light.ok) expect(light.reason).toContain('LIGHTWEIGHT');

        // A missing tag is unresolvable.
        expect((await resolveFreezeTagTime('no-such-tag', dir)).ok).toBe(false);
    });
});

describe('evidence grammar tightenings (review-27)', () => {
    test('impossible dates, non-ticker symbols, single order ids and non-WAIVED status words all fail', async () => {
        const { auditFreezeManifest } = await import('@/utils/equity-series-math.js');
        const exp = { tag: 'validation-freeze-1', deployableClasses: ['intraday'] };
        const base = `| Freeze tag | validation-freeze-1 |
| OCA-joined close cancels its siblings broker-side | VALUE |
`;
        const probe = (value: string) => auditFreezeManifest(base.replace('VALUE', value), exp).problems;
        // 2026-99-99 matches the date SHAPE but is not a calendar date.
        expect(probe('observed 2026-99-99 AAPL #1/#2').some((x) => x.includes('impossible date'))).toBe(true);
        expect(probe('observed 2026-02-30 AAPL #1/#2').some((x) => x.includes('impossible date'))).toBe(true);
        // Arbitrary lowercase token is not a ticker.
        expect(probe('observed 2026-08-25 whatever #1/#2').some((x) => x.includes('non-ticker symbol'))).toBe(true);
        // ONE order id under-specifies a multi-order broker interaction.
        expect(probe('observed 2026-08-25 AAPL #101 only').some((x) => x.includes('at least 2 required'))).toBe(true);
        // 'waived'/'waives' are not the documented status — exactly WAIVED.
        expect(probe('waived FP: reason').some((x) => x.includes('neither observed nor a valid waiver'))).toBe(true);
        expect(probe('waives FP: reason').some((x) => x.includes('neither observed nor a valid waiver'))).toBe(true);
        // The full grammar still passes.
        expect(probe('observed 2026-08-25 AAPL #101/#102').some((x) => x.includes("'OCA-joined close'"))).toBe(false);
    });
});
