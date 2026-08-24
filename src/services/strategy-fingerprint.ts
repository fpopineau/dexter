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
 *   - the code identity: a digest of the runtime paths' git tree/blob
 *     hashes at HEAD plus a content digest of any runtime drift, read
 *     via the git BINARY (worktrees and submodules where `.git` is a
 *     file resolve correctly). Tree-based, NOT the commit SHA —
 *     review-22: a docs-only commit (the manifest workflow) must leave
 *     the identity unchanged. A dirty runtime checkout is a distinct
 *     (and suspect) identity, not clean;
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
import { loadCronStore } from '../cron/store.js';
import { discoverSkills } from '../skills/index.js';
import { getSetting } from '../utils/config.js';
import { getRiskRules } from '@/tools/ibkr/risk-rules.js';

const execFileAsync = promisify(execFile);

async function execGit(args: string[], cwd: string): Promise<string | null> {
    try {
        // 64MB buffer: `git diff --binary HEAD` carries file CONTENT.
        const { stdout } = await execFileAsync('git', args, { cwd, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
        return stdout.replace(/\r/g, '').trim();
    } catch {
        return null;
    }
}

/** The paths that shape runtime behavior. Code identity is derived from
 *  THESE (tree/blob hashes at HEAD + their working-tree drift), never
 *  from the commit SHA — review-22: HEAD made the freeze manifest
 *  self-referential by construction (recording the fingerprint in the
 *  manifest changed HEAD and with it the fingerprint). A docs-only
 *  commit leaves every one of these objects — and so the identity —
 *  unchanged. */
const RUNTIME_PATHS = ['src', 'scripts', 'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'SOUL.md'];
const RUNTIME_UNTRACKED = /^(src|scripts)\/|^(package\.json|bun\.lock|bunfig\.toml|tsconfig\.json|SOUL\.md)$/;

/** Review-23: behavior-affecting ENVIRONMENT settings — trigger
 *  thresholds, auto-execution selection, lifecycle switches, universe
 *  overrides, the data-feed type. Changing any of these changes WHICH
 *  trades enter the sample, so they are part of the strategy identity.
 *  Hashed as RAW values with an 'unset' sentinel rather than re-deriving
 *  each default here: duplicating ~40 defaults would drift from the real
 *  ones (harness infidelity); raw hashing is over-sensitive (explicitly
 *  setting a default ends a window) but never under-sensitive. Secrets
 *  are NEVER hashed by value — capability env hashes presence only. */
const BEHAVIOR_ENV = [
    'DEXTER_RISK_PROFILE', 'IBKR_PORT', 'IBKR_ALLOW_LIVE', 'IBKR_MARKET_DATA_TYPE',
    'AUTO_EXECUTE_PAPER', 'AUTO_EXECUTE_MAX_PER_DAY', 'AUTO_EXECUTE_MIN_SCORE',
    'AUTO_PROTECT', 'PROFIT_TRAIL', 'CHASE_CONTINUATION', 'KILL_SWITCH_GUARDIAN',
    'EOD_TRIAGE', 'EOD_EARNINGS_GUARD', 'EOD_MACRO_WARNING',
    'ENTRY_EXPIRY_GRACE_MIN', 'STALE_ENTRY_MAX_DAYS',
    'OPPORTUNITY_ENGINE', 'OPP_TRIGGER_SCORE', 'OPP_TRIGGER_MAX_PER_DAY', 'OPP_TRIGGER_COOLDOWN_MIN',
    'OPP_TOP_N', 'OPP_MAX_CANDIDATES', 'OPP_MARKET_CAP_MIN', 'OPP_MARKET_CAP_MAX',
    'OPP_DEEP_TRIGGER_MARGIN', 'OPP_EVENT_BOOST_MIN_PCT', 'OPP_MOVER_ALERT_PCT', 'OPP_MOVER_ALERT_RVOL',
    'OPP_SENTINEL', 'OPP_SENTINEL_CADENCE_MIN', 'OPP_SENTINEL_MOVE_PCT',
    'OPP_DAWN_CADENCE_MIN', 'OPP_DAWN_START_ET', 'OPP_HEALTH_EMPTY_CYCLES', 'OPP_REACTOR_RELIEF',
    'OPP_BREADTH_MAX_PER_DAY', 'OPP_BREADTH_COOLDOWN_MIN', 'OPP_BREADTH_MIN_WATCHED',
    'OPP_BREADTH_THRESHOLD_RELIEF', 'OPP_BREADTH_CAP_BONUS',
    'OPP_BREADTH_VEHICLE_BROAD', 'OPP_BREADTH_VEHICLE_SEMI', 'OPP_BREADTH_VEHICLE_CRYPTO',
    'REGIME_PREARM_MAX_PER_DAY', 'REGIME_PREARM_COOLDOWN_MIN',
    'UNIVERSE_SWEEP', 'UNIVERSE_CAP_MIN', 'UNIVERSE_EXTRA_SYMBOLS',
    'NEWS_PULSE', 'NEWS_PULSE_WINDOW_MIN', 'NEWS_PULSE_MIN_ARTICLES', 'NEWS_PULSE_MIN_DOMAINS',
    'NEWS_PULSE_MAX_SYMBOLS', 'NEWS_PULSE_BATCH_SIZE', 'NEWS_PULSE_BACKOFF_MIN',
] as const;
/** Data/model capability presence — a provider appearing or vanishing
 *  changes what judgment can see, but the VALUE is a secret and never
 *  enters the digest. */
const CAPABILITY_ENV = [
    'ANTHROPIC_API_KEY', 'FINANCIAL_DATASETS_API_KEY', 'EXASEARCH_API_KEY',
    'PERPLEXITY_API_KEY', 'TAVILY_API_KEY', 'LANGSEARCH_API_KEY',
    // Review-25: automatic embedding-provider selection for MEMORY
    // retrieval depends on these — presence changes what context the
    // agent recalls.
    'OPENAI_API_KEY', 'GOOGLE_API_KEY',
    'X_BEARER_TOKEN', 'OLLAMA_BASE_URL', 'VLLM_BASE_URL',
] as const;

/** Deterministic JSON with recursively sorted object keys — settings
 *  round-trip through editors that reorder keys; identity must not. */
function stableJson(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
    if (v !== null && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(v) ?? 'null';
}

/** Review-23, pure: the typed non-secret snapshot of behavior-affecting
 *  environment. Exported for the harness. */
export function behaviorEnvInput(env: Record<string, string | undefined> = process.env): string {
    const policy = BEHAVIOR_ENV.map((k) => `${k}=${env[k]?.trim() ?? 'unset'}`);
    const caps = CAPABILITY_ENV.map((k) => `${k}:${env[k] ? 'present' : 'absent'}`);
    return [...policy, ...caps].join('|');
}

/** Review-24: mutable JUDGMENT configuration outside env and settings —
 *  the cron jobs (`.dexter/cron/jobs.json`) hand the agent its prompt,
 *  model/provider, schedule, active hours and iteration budget, so an
 *  edited job is a different strategy under the same code. Canonical:
 *  behavior fields only (runtime bookkeeping — timestamps, last-run
 *  state, random ids — excluded), sorted for order-independence. The
 *  search-provider PREFERENCE rides along (its capability keys hash as
 *  presence in behaviorEnvInput). A missing or corrupt jobs file
 *  canonicalizes to zero jobs — exactly what the runtime loads from it. */
export function judgmentConfigInput(): string {
    let cron = 'cron:[]';
    try {
        const jobs = loadCronStore().jobs.map((j) => ({
            name: j.name,
            enabled: j.enabled,
            schedule: j.schedule,
            fulfillment: j.fulfillment,
            activeHours: j.activeHours ?? null,
            message: j.payload?.message ?? null,
            model: j.payload?.model ?? null,
            modelProvider: j.payload?.modelProvider ?? null,
            maxIterations: j.payload?.maxIterations ?? null,
        }));
        jobs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        cron = `cron:${JSON.stringify(jobs)}`;
    } catch { /* store unreadable → runtime loads zero jobs → the sentinel matches */ }
    let search = 'search:unset';
    try {
        search = `search:${getSetting<string | null>('webSearchPreferredProvider', null) ?? 'unset'}`;
    } catch { /* settings unreadable */ }
    // Review-25: memory POLICY (context budget, temporal decay, MMR,
    // indexing, embedding provider/model) shapes what the agent recalls
    // at judgment time — canonical raw settings with sorted keys ('unset'
    // sentinel = the runtime's defaults). Memory CONTENTS stay
    // operational state, never fingerprinted.
    let memory = 'memory:unset';
    try {
        const m = getSetting<Record<string, unknown> | null>('memory', null);
        if (m !== null && m !== undefined) memory = `memory:${stableJson(m)}`;
    } catch { /* settings unreadable */ }
    return `${cron}|${search}|${memory}`;
}

/** Review-20/21, pure: split `git status --porcelain=v1 -z` output into
 *  "tracked files changed" and "runtime-relevant untracked paths".
 *  NUL-delimited (review-21: the newline form QUOTES paths containing
 *  spaces — `?? "src/foo bar.ts"` silently failed the runtime filter);
 *  rename/copy entries carry the ORIGIN path as the following token.
 *  Exported for the harness — the filtering policy is the contract. */
export function classifyWorkingTree(statusZ: string): { hasTrackedChanges: boolean; untrackedRuntime: string[] } {
    const tokens = statusZ.split('\u0000').filter((t) => t.length > 0);
    let hasTrackedChanges = false;
    const untrackedRuntime: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const entry = tokens[i];
        const xy = entry.slice(0, 2);
        const path = entry.slice(3);
        if (xy === '??') {
            if (RUNTIME_UNTRACKED.test(path)) untrackedRuntime.push(path);
            continue;
        }
        hasTrackedChanges = true;
        if (/[RC]/.test(xy)) i++; // skip the origin-path token of a rename/copy
    }
    return { hasTrackedChanges, untrackedRuntime: untrackedRuntime.sort() };
}

/** The running code identity: `tree.<digest>` for a runtime-clean
 *  checkout — a digest over the git TREE/BLOB hashes of the runtime
 *  paths at HEAD (review-22: invariant under a docs-only commit, so the
 *  manifest workflow cannot perturb the fingerprint it records) — and
 *  `tree.<digest>+dirty.<digest>` when runtime paths drift, where the
 *  dirty digest is over the actual CONTENT of the drift (review-20:
 *  names alone let further edits to a dirty file pass unchanged):
 *  `git diff --binary HEAD -- <runtime paths>` plus the contents of
 *  runtime-relevant untracked files. Docs/.claude/manifest edits —
 *  tracked or not — never touch the identity. Null when git cannot
 *  prove any half — required surface, so null fails the whole
 *  fingerprint closed (an unreadable untracked runtime file, or an
 *  untracked runtime DIRECTORY, is unprovable content; commit or
 *  remove it). */
export async function codeIdentity(cwd = process.cwd()): Promise<string | null> {
    const parts: string[] = [];
    let anyPresent = false;
    for (const p of RUNTIME_PATHS) {
        const obj = await execGit(['rev-parse', `HEAD:${p}`], cwd);
        if (obj !== null && !/^[0-9a-f]{40}$/.test(obj)) return null; // git spoke, but not an object hash
        if (obj !== null) anyPresent = true;
        parts.push(`${p}:${obj ?? 'absent'}`);
    }
    if (!anyPresent) return null; // not a repo, or nothing runtime-tracked — identity unprovable
    const base = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
    // -z: NUL-delimited, unquoted paths (spaces survive); untracked-files
    // =all lists files INSIDE untracked directories individually and
    // overrides any config that would suppress untracked output. Scoped
    // to the runtime paths: docs edits do not dirty the identity.
    const status = await execGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...RUNTIME_PATHS], cwd);
    if (status === null) return null; // a clean state we cannot PROVE is not clean
    const tree = classifyWorkingTree(status);
    if (!tree.hasTrackedChanges && tree.untrackedRuntime.length === 0) return `tree.${base}`;
    const h = createHash('sha256');
    if (tree.hasTrackedChanges) {
        const diff = await execGit(['diff', '--binary', 'HEAD', '--', ...RUNTIME_PATHS], cwd);
        if (diff === null) return null;
        h.update(diff);
    }
    for (const p of tree.untrackedRuntime) {
        const content = await readFile(join(cwd, p), 'utf-8').catch(() => null);
        if (content === null) return null; // content unprovable → identity unprovable
        h.update(p).update(' ').update(content).update(' ');
    }
    return `tree.${base}+dirty.${h.digest('hex').slice(0, 12)}`;
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
    /** Review-23: behaviorEnvInput() — always resolvable (sentinels for
     *  unset), so plain string. */
    behaviorEnv: string;
    /** Review-24: judgmentConfigInput() — cron jobs + search preference. */
    judgmentConfig: string;
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
        .update(s.skills).update('\u0000')
        .update(s.behaviorEnv).update('\u0000')
        .update(s.judgmentConfig)
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
    return fingerprintFromSurfaces({ effectiveRules, codeIdentity: code, providerModel, soul, rules, skills, behaviorEnv: behaviorEnvInput(), judgmentConfig: judgmentConfigInput() });
}
