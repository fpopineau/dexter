/**
 * Strategy fingerprint (review-17/18/19, freeze integrity).
 *
 * The freeze manifest records what the strategy WAS at tag time, but a
 * document cannot detect drift — the sample itself must carry the
 * identity. Every proposal row and every equity sample is stamped with a
 * 12-hex digest of the behavioral surfaces; the scorecard refuses a
 * window containing more than one fingerprint, so a mid-sample edit on
 * ANY surface ends the window DETECTABLY instead of silently.
 *
 * REQUIRED surfaces — when one cannot be resolved the fingerprint is
 * NULL and the caller stamps NOTHING, which the scorecard reads as
 * ABSENT and refuses (review-19: hashing 'absent' into a valid digest
 * let a whole identity-less window pass purity):
 *   - the EFFECTIVE risk rules (post profile override);
 *   - the code identity: git HEAD SHA plus a dirty-state digest, read
 *     via the git BINARY (`rev-parse` + `status --porcelain`), which
 *     also resolves worktrees and submodules where `.git` is a file —
 *     a dirty checkout is a distinct (and suspect) identity, not clean;
 *   - the configured provider:model pair (settings.json — the runtime's
 *     configured identity; the per-trade `model` column separately pins
 *     what actually proposed each trade).
 *
 * OPTIONAL surfaces — legitimately absent by design; absence hashes as
 * a sentinel so their APPEARANCE or DISAPPEARANCE still changes the
 * digest: SOUL.md (user-or-bundled), `.dexter/RULES.md`, and every
 * discovered skill's SKILL.md content.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadRulesDocument, loadSoulDocument } from '@/agent/prompts.js';
import { discoverSkills } from '../skills/index.js';
import { getSetting } from '../utils/config.js';
import { getRiskRules } from '@/tools/ibkr/risk-rules.js';

const execFileAsync = promisify(execFile);

async function execGit(args: string[], cwd: string): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('git', args, { cwd, timeout: 10_000 });
        return stdout.replace(/\r/g, '').trim();
    } catch {
        return null;
    }
}

/** The running code identity: `<HEAD sha>` for a clean checkout,
 *  `<sha>+dirty.<digest>` when tracked files differ from HEAD (the
 *  digest is over `git status --porcelain`, so WHICH files are dirty is
 *  part of the identity). Null when git cannot prove either half —
 *  required surface, so null fails the whole fingerprint closed. */
export async function codeIdentity(cwd = process.cwd()): Promise<string | null> {
    const sha = await execGit(['rev-parse', 'HEAD'], cwd);
    if (sha === null || !/^[0-9a-f]{40}$/.test(sha)) return null;
    const status = await execGit(['status', '--porcelain'], cwd);
    if (status === null) return null; // a clean state we cannot PROVE is not clean
    return status.length === 0
        ? sha
        : `${sha}+dirty.${createHash('sha256').update(status).digest('hex').slice(0, 12)}`;
}

/** Diagnostic fallback: HEAD sha by parsing .git directly (no dirty
 *  proof — never used for the fingerprint itself). Follows a `.git`
 *  FILE (worktree/submodule gitdir pointer) one level. */
export async function readGitHeadSha(cwd = process.cwd()): Promise<string> {
    try {
        let gitDir = join(cwd, '.git');
        const asFile = await readFile(gitDir, 'utf-8').catch(() => null);
        if (asFile !== null) {
            const m = /^gitdir:\s*(.+)$/m.exec(asFile);
            if (!m) return 'absent';
            gitDir = join(cwd, m[1].trim());
        }
        const head = (await readFile(join(gitDir, 'HEAD'), 'utf-8')).trim();
        const m = /^ref:\s*(.+)$/.exec(head);
        if (!m) return /^[0-9a-f]{40}$/.test(head) ? head : 'absent'; // detached HEAD
        const ref = m[1].trim();
        try {
            return (await readFile(join(gitDir, ref), 'utf-8')).trim();
        } catch {
            const packed = await readFile(join(gitDir, 'packed-refs'), 'utf-8');
            for (const line of packed.split('\n')) {
                const [sha, name] = line.trim().split(/\s+/);
                if (name === ref && /^[0-9a-f]{40}$/.test(sha ?? '')) return sha;
            }
            return 'absent';
        }
    } catch {
        return 'absent';
    }
}

/** Sorted-by-name digest input of every discovered skill's SKILL.md.
 *  Optional surface: unreadable content hashes as a sentinel — a skill
 *  appearing or vanishing mid-sample must change the digest, never
 *  crash. */
async function skillsDigestInput(): Promise<string> {
    let metas: Array<{ name: string; path: string }>;
    try {
        metas = discoverSkills().map((s) => ({ name: s.name, path: s.path }));
    } catch {
        return 'skills:absent';
    }
    metas.sort((a, b) => a.name.localeCompare(b.name));
    const parts: string[] = [];
    for (const meta of metas) {
        const content = await readFile(meta.path, 'utf-8')
            .catch(() => readFile(join(meta.path, 'SKILL.md'), 'utf-8'))
            .catch(() => 'absent');
        parts.push(`${meta.name}\u0000${content}`);
    }
    return parts.join('\u0000');
}

export interface FingerprintSurfaces {
    /** REQUIRED — null means the runtime cannot prove this identity and
     *  the fingerprint as a whole must be null (stamped as ABSENT). */
    effectiveRules: string | null;
    codeIdentity: string | null;
    providerModel: string | null;
    /** Optional by design — null hashes as a sentinel. */
    soul: string | null;
    rules: string | null;
    skills: string;
}

/** Pure core: null when any REQUIRED surface is null; else the 12-hex
 *  digest. Exported for the harness — the required/optional split is
 *  the review-19 contract under test. */
export function fingerprintFromSurfaces(s: FingerprintSurfaces): string | null {
    if (s.effectiveRules === null || s.codeIdentity === null || s.providerModel === null) return null;
    return createHash('sha256')
        .update(s.effectiveRules).update('\u0000')
        .update(s.codeIdentity).update('\u0000')
        .update(s.providerModel).update('\u0000')
        .update(s.soul ?? 'absent').update('\u0000')
        .update(s.rules ?? 'absent').update('\u0000')
        .update(s.skills)
        .digest('hex')
        .slice(0, 12);
}

/** Gather all surfaces and digest them. NULL when a required surface is
 *  unavailable — callers stamp nothing, the scorecard refuses the
 *  window (fail closed). Never throws. */
export async function strategyFingerprint(): Promise<string | null> {
    const [soul, rules, skills, code] = await Promise.all([
        loadSoulDocument().catch(() => null),
        loadRulesDocument().catch(() => null),
        skillsDigestInput(),
        codeIdentity(),
    ]);
    let effectiveRules: string | null = null;
    try {
        effectiveRules = JSON.stringify(getRiskRules());
    } catch { /* required surface unavailable → null fingerprint */ }
    let providerModel: string | null = null;
    try {
        const provider = getSetting<string | null>('provider', null);
        const modelId = getSetting<string | null>('modelId', null);
        if (provider && modelId) providerModel = `${provider}:${modelId}`;
    } catch { /* required surface unavailable → null fingerprint */ }
    return fingerprintFromSurfaces({ effectiveRules, codeIdentity: code, providerModel, soul, rules, skills });
}
