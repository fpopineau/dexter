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
 *   - the code identity: a digest of the BEHAVIOR paths' git blob hashes
 *     at HEAD plus a content digest of any behavior-path drift, read via
 *     the git BINARY (worktrees and submodules where `.git` is a file
 *     resolve correctly). Blob-based, NOT the commit SHA — review-22: a
 *     docs-only commit must leave the identity unchanged; REQ-FP-001
 *     (live-loop WP2): observability, control-plane, evaluator, TUI and
 *     test paths are EXCLUDED (BEHAVIOR_EXCLUDE) so those landings do not
 *     end an epoch. A dirty behavior checkout is a distinct (and suspect)
 *     identity, not clean;
 *   - the configured provider:model pair (settings.json — the runtime's
 *     configured identity; the per-trade `model` column separately pins
 *     what actually proposed each trade).
 *
 * OPTIONAL surfaces — legitimately absent by design; absence hashes as
 * a sentinel so their APPEARANCE or DISAPPEARANCE still changes the
 * digest: SOUL.md (user-or-bundled), `.dexter/RULES.md`, and every
 * discovered skill's SKILL.md content.
 */

import { execFile, execFileSync as execFileSyncNode } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync as readFileSyncNode, writeFileSync as writeFileSyncNode } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadRulesDocument, loadSoulDocument } from '@/agent/prompts.js';
import { loadCronStore } from '../cron/store.js';
import { discoverSkills } from '../skills/index.js';
import { getSetting } from '../utils/config.js';
import { getRiskRules } from '@/tools/ibkr/risk-rules.js';
import { getActiveWeightsInfo } from '@/tools/ibkr/signal-scorer.js';

const execFileAsync = promisify(execFile);

async function execGit(args: string[], cwd: string, opts: { raw?: boolean } = {}): Promise<string | null> {
    try {
        // 64MB buffer: `git diff --binary HEAD` carries file CONTENT.
        const { stdout } = await execFileAsync('git', args, { cwd, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
        // REQ-FP-002 (WP2): NUL-delimited outputs are consumed RAW — a
        // porcelain status entry for a modified file begins with a SPACE
        // (" M path"), and trimming it shifted the path parse by one
        // character (the old identity never noticed: any non-untracked
        // entry counted as dirty regardless of its path).
        if (opts.raw) return stdout;
        return stdout.replace(/\r/g, '').trim();
    } catch {
        return null;
    }
}

/** Review-27: the freeze WINDOW anchor is the tag's own immutable
 *  TAGGER timestamp. `git log -1 --format=%ct <tag>` returns the tagged
 *  COMMIT's time — which can precede the tag by hours, leaking the
 *  interval's trades into "since the tag" — and a lightweight tag has
 *  no creation timestamp at all. Only an ANNOTATED tag (git tag -a) is
 *  acceptable; its taggerdate is immutable tag content. */
export async function resolveFreezeTagTime(
    tag: string,
    cwd = process.cwd(),
): Promise<{ ok: true; tagTimeMs: number; tagObjectSha: string } | { ok: false; reason: string }> {
    const type = await execGit(['cat-file', '-t', `refs/tags/${tag}`], cwd);
    if (type === null) return { ok: false, reason: `tag ${tag} unresolvable` };
    if (type !== 'tag') {
        return {
            ok: false,
            reason: `tag ${tag} is ${type === 'commit' ? 'LIGHTWEIGHT' : `'${type}'`} — an ANNOTATED tag (git tag -a) is required: only its tagger timestamp is an immutable freeze clock`,
        };
    }
    const t = await execGit(['for-each-ref', '--format=%(taggerdate:unix)', `refs/tags/${tag}`], cwd);
    if (t === null || !/^\d+$/.test(t)) return { ok: false, reason: `tagger timestamp of ${tag} unresolvable` };
    // Review-28: the tag OBJECT sha — the annotated object is immutable,
    // but the tag NAME is a movable ref (`git tag -af` re-points it at a
    // fresh object). The caller pins this sha outside the repo and
    // compares on every later evaluation: a force-retag changes it.
    // (for-each-ref %(objectname), not `rev-parse <tag>^{tag}`: Git for
    // Windows' MSYS layer glob-strips the braces into `<tag>^tag`. The
    // ref's objectname IS the tag object — cat-file already proved the
    // type above.)
    const obj = await execGit(['for-each-ref', '--format=%(objectname)', `refs/tags/${tag}`], cwd);
    if (obj === null || !/^[0-9a-f]{40}$/.test(obj)) return { ok: false, reason: `tag object sha of ${tag} unresolvable` };
    return { ok: true, tagTimeMs: Number(t) * 1000, tagObjectSha: obj };
}

/** Review-29/30: the freeze-anchor verification — TOFU pin + mandatory
 *  remote — behind INJECTED operations so every fail-closed branch is
 *  executable in the harness (the scorecard's inline version had none).
 *  Contract: only a genuine ENOENT is a first sighting (a corrupt or
 *  unreadable pin refuses to re-pin — delete-and-retag must not mint a
 *  fresh trusted anchor); the pin is created exclusively; the REMOTE
 *  annotated-tag object must exist and equal the local one. */
export interface FreezeAnchorDeps {
    /** Read the pin file; throw with code ENOENT when absent. */
    readPin(): string;
    /** Create the pin exclusively ('wx' semantics); throw if it exists. */
    writePinExclusive(content: string): void;
    /** Raw `git ls-remote origin refs/tags/<tag>` stdout, or null on any failure. */
    lsRemoteTag(): string | null;
}

export function verifyFreezeAnchor(
    tag: string,
    localTagObjectSha: string,
    deps: FreezeAnchorDeps,
): { problems: string[]; notes: string[] } {
    const problems: string[] = [];
    const notes: string[] = [];
    let pinRaw: string | null = null;
    let pinMissing = false;
    try {
        pinRaw = deps.readPin();
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') pinMissing = true;
        else problems.push(`freeze anchor: pin unreadable (${err instanceof Error ? err.message : err}) — refusing to re-pin over an error`);
    }
    if (pinRaw !== null) {
        let pin: { tag?: string; tagObjectSha?: string } | null = null;
        try { pin = JSON.parse(pinRaw) as { tag?: string; tagObjectSha?: string }; } catch { pin = null; }
        if (pin === null || pin.tag !== tag || typeof pin.tagObjectSha !== 'string' || !/^[0-9a-f]{40}$/.test(pin.tagObjectSha)) {
            problems.push('freeze anchor: freeze-tag-pin.json is CORRUPT — refusing to treat as first sighting; restore it from the journal or remote');
        } else if (pin.tagObjectSha !== localTagObjectSha) {
            problems.push(
                `freeze anchor: the tag OBJECT changed since first pinned (${pin.tagObjectSha.slice(0, 12)}… → ` +
                `${localTagObjectSha.slice(0, 12)}…) — the tag was FORCE-MOVED; the freeze anchor is broken`,
            );
        } else {
            notes.push(`freeze anchor: tag object ${localTagObjectSha.slice(0, 12)}… matches the first-sighting pin`);
        }
    } else if (pinMissing) {
        try {
            deps.writePinExclusive(JSON.stringify({ tag, tagObjectSha: localTagObjectSha, pinnedAt: new Date().toISOString() }, null, 2));
            notes.push(`freeze anchor: FIRST SIGHTING — pinned tag object ${localTagObjectSha}. Push the tag to origin and record this sha in the validation journal.`);
        } catch (err) {
            problems.push(`freeze anchor: could not pin the tag object sha (${err instanceof Error ? err.message : err})`);
        }
    }
    const remoteOut = deps.lsRemoteTag();
    const remoteSha = remoteOut !== null ? (remoteOut.trim().split(/\s+/)[0] ?? '') : '';
    if (remoteOut === null) {
        problems.push('freeze anchor: the remote (origin) could not be queried — the mandatory remote tag anchor is unverifiable');
    } else if (!/^[0-9a-f]{40}$/.test(remoteSha)) {
        problems.push(`freeze anchor: the tag is NOT on origin — push it (git push origin ${tag}); the remote copy is the mandatory immutable anchor`);
    } else if (remoteSha !== localTagObjectSha) {
        problems.push(
            `freeze anchor: the REMOTE tag object (${remoteSha.slice(0, 12)}…) differs from the local one ` +
            `(${localTagObjectSha.slice(0, 12)}…) — the local tag was moved, or the remote was force-updated`,
        );
    } else {
        notes.push(`freeze anchor: remote tag object matches (origin/${tag})`);
    }
    return { problems, notes };
}

/** The real operations for verifyFreezeAnchor — sync fs + git, bound to
 *  a working directory and pin path. Exported so the integration test
 *  can run the SAME deps against a temporary repo with a bare origin. */
export function makeFreezeAnchorDeps(tag: string, cwd: string, pinPath: string): FreezeAnchorDeps {
    return {
        readPin: () => readFileSyncNode(pinPath, 'utf-8'),
        writePinExclusive: (content: string) => writeFileSyncNode(pinPath, content, { flag: 'wx' }),
        lsRemoteTag: () => {
            try {
                return execFileSyncNode('git', ['ls-remote', 'origin', `refs/tags/${tag}`], { cwd, timeout: 15_000 }).toString();
            } catch {
                return null;
            }
        },
    };
}

/** The paths that shape runtime behavior. Code identity is derived from
 *  THESE (tree/blob hashes at HEAD + their working-tree drift), never
 *  from the commit SHA — review-22: HEAD made the freeze manifest
 *  self-referential by construction (recording the fingerprint in the
 *  manifest changed HEAD and with it the fingerprint). A docs-only
 *  commit leaves every one of these objects — and so the identity —
 *  unchanged. */
/** REQ-FP-001 (live-loop WP2): the code identity covers BEHAVIOR paths —
 *  what decides which trades enter, how they are sized, placed and exited,
 *  and what the judgment layer sees. The runtime tree `src` plus the root
 *  runtime configs are INCLUDED by default; observability, control-plane,
 *  evaluator, TUI and test paths are EXCLUDED explicitly below. A new file
 *  is behavior unless excluded: a forgotten exclusion ends an epoch loudly
 *  rather than letting a behavior file escape the identity. `scripts/`
 *  (scorecard, ops tooling) is not runtime behavior and left the identity
 *  with this narrowing. */
export const BEHAVIOR_INCLUDE: readonly string[] = ['src', 'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'SOUL.md'];

export const BEHAVIOR_EXCLUDE: readonly string[] = [
    // Observability: reads the ledgers and the tape, decides nothing.
    'src/services/simulator',
    'src/services/benchmark.ts',
    'src/services/excursion-sweeper.ts',
    'src/services/equity-series.ts',
    'src/services/dashboard.ts',
    'src/services/dashboard-page.ts',
    'src/services/runtime-attestation.ts',
    'src/services/scan-health.ts',
    // Control plane: the operator's per-trade powers and status readers.
    'src/services/loop-control.ts',
    'src/gateway/loop-commands.ts',
    // Alert delivery: transport and formatting of decisions made elsewhere.
    'src/gateway/outcome-alerts.ts',
    'src/gateway/mover-alerts.ts',
    'src/gateway/health-alerts.ts',
    'src/gateway/debug-log.ts',
    // Evaluator math: decides about the EPOCH, not about trades (its
    // constants are hashed into the epoch record by WP3 instead).
    'src/utils/day-bootstrap.ts',
    'src/utils/equity-series-math.ts',
    'src/utils/sequential-test.ts',
    // TUI / CLI / research surfaces: never on the trading path.
    'src/backtest',
    'src/components',
    'src/controllers',
    'src/commands',
    'src/cli.ts',
    'src/index.tsx',
    'src/theme.ts',
    'src/utils/spinner.ts',
    'src/utils/progress-channel.ts',
    'src/utils/thinking-verbs.ts',
    'src/utils/input-key-handlers.ts',
    'src/utils/text-navigation.ts',
    // Tests (glob — matched by extension below).
    '**/*.test.ts',
    '**/*.test.tsx',
];

/** Pure: is this repo-relative path part of the behavior identity? */
export function isBehaviorPath(pathRaw: string): boolean {
    const p = pathRaw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!BEHAVIOR_INCLUDE.some((inc) => p === inc || p.startsWith(`${inc}/`))) return false;
    if (/\.test\.tsx?$/.test(p)) return false;
    for (const ex of BEHAVIOR_EXCLUDE) {
        if (ex.includes('*')) continue;
        if (p === ex || p.startsWith(`${ex}/`)) return false;
    }
    return true;
}

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
    'OPP_SCAN_VOLUME_FLOOR', 'OPP_SCAN_VOLUME_FLOOR_PREMARKET',
    // Live-loop WP1 (2026-09-05): the large-cap lane, the pre-market spread
    // hard multiple, the veto window and the spend cap all change WHICH
    // trades enter the sample (the cap by refusing evaluations, the prices
    // by deciding when it binds).
    'OPP_LARGECAP_LANE', 'OPP_LARGECAP_MIN_USD', 'OPP_LARGECAP_RESERVE',
    'PREMARKET_SPREAD_HARD_MULT', 'LIVE_VETO_WINDOW_MIN',
    'LLM_DAILY_SPEND_CAP_USD', 'LLM_PRICE_IN_USD_PER_MTOK', 'LLM_PRICE_OUT_USD_PER_MTOK',
    'FLAT_EXIT_SWEEP',
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
export function classifyWorkingTree(statusZ: string): { hasTrackedChanges: boolean; untrackedRuntime: string[]; changedBehavior: string[] } {
    const tokens = statusZ.split('\u0000').filter((t) => t.length > 0);
    const changedBehavior: string[] = [];
    const untrackedRuntime: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const entry = tokens[i];
        const xy = entry.slice(0, 2);
        const path = entry.slice(3);
        if (xy === '??') {
            // REQ-FP-001: only BEHAVIOR paths dirty the identity.
            if (isBehaviorPath(path)) untrackedRuntime.push(path);
            continue;
        }
        if (isBehaviorPath(path)) changedBehavior.push(path);
        if (/[RC]/.test(xy)) i++; // skip the origin-path token of a rename/copy
    }
    return { hasTrackedChanges: changedBehavior.length > 0, untrackedRuntime: untrackedRuntime.sort(), changedBehavior: changedBehavior.sort() };
}

/** Pure: `git ls-tree -r -z HEAD` output → sorted [path, blob sha] pairs
 *  for BEHAVIOR blobs only ("<mode> <type> <sha>\t<path>" per '\u0000' entry). */
export function behaviorBlobsFromLsTree(lsTreeZ: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const entry of lsTreeZ.split('\u0000')) {
        if (!entry) continue;
        const tab = entry.indexOf('\t');
        if (tab < 0) continue;
        const meta = entry.slice(0, tab).split(' ');
        const path = entry.slice(tab + 1);
        if (meta.length < 3 || meta[1] !== 'blob') continue;
        if (!isBehaviorPath(path)) continue;
        out.push([path, meta[2]]);
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
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
    // REQ-FP-001: one ls-tree over the include roots, filtered to behavior
    // blobs — a per-FILE identity, so an excluded observability file can
    // change (dirty or committed) without moving the digest, while any
    // behavior blob does. -z keeps paths with spaces intact.
    const lsTree = await execGit(['ls-tree', '-r', '-z', 'HEAD', '--', ...BEHAVIOR_INCLUDE], cwd, { raw: true });
    if (lsTree === null) return null; // not a repo / no HEAD — identity unprovable
    const blobs = behaviorBlobsFromLsTree(lsTree);
    if (blobs.length === 0) return null; // nothing behavior-tracked
    const base = createHash('sha256').update(blobs.map(([p, sha]) => `${p}:${sha}`).join('|')).digest('hex').slice(0, 12);
    // -z: NUL-delimited, unquoted paths (spaces survive); untracked-files
    // =all lists files INSIDE untracked directories individually and
    // overrides any config that would suppress untracked output. Scoped
    // to the include roots; classifyWorkingTree keeps behavior paths only.
    const status = await execGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...BEHAVIOR_INCLUDE], cwd, { raw: true });
    if (status === null) return null; // a clean state we cannot PROVE is not clean
    const tree = classifyWorkingTree(status);
    if (!tree.hasTrackedChanges && tree.untrackedRuntime.length === 0) return `tree.${base}`;
    const h = createHash('sha256');
    if (tree.hasTrackedChanges) {
        const diff = await execGit(['diff', '--binary', 'HEAD', '--', ...tree.changedBehavior], cwd);
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
    /** Review-26, REQUIRED: the scorer's EFFECTIVE weights + provenance
     *  (canonical, via the scorer's own resolution: override > file >
     *  defaults). scorer-weights.json directly moves composite scores,
     *  ranking and trigger eligibility — an edited-and-restarted weights
     *  file is a different selection policy. Null = unresolvable →
     *  fingerprint fails closed. */
    scorerWeights: string | null;
}

/** Pure core: null when any REQUIRED surface is null; else the 12-hex
 *  digest. Exported for the harness — the required/optional split is
 *  the review-19 contract under test. */
export function fingerprintFromSurfaces(s: FingerprintSurfaces): string | null {
    if (s.effectiveRules === null || s.codeIdentity === null || s.providerModel === null || s.scorerWeights === null) return null;
    return createHash('sha256')
        .update(s.effectiveRules).update('\u0000')
        .update(s.codeIdentity).update('\u0000')
        .update(s.providerModel).update('\u0000')
        .update(s.soul ?? 'absent').update('\u0000')
        .update(s.rules ?? 'absent').update('\u0000')
        .update(s.skills).update('\u0000')
        .update(s.behaviorEnv).update('\u0000')
        .update(s.judgmentConfig).update('\u0000')
        .update(s.scorerWeights)
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
    // Review-26: the scorer's effective weights via ITS OWN resolution —
    // defaults, file weights and in-process overrides cannot drift from
    // the fingerprint implementation. Required: unresolvable → null.
    let scorerWeights: string | null = null;
    try {
        scorerWeights = stableJson(getActiveWeightsInfo());
    } catch { /* required surface unavailable → null fingerprint */ }
    return fingerprintFromSurfaces({ effectiveRules, codeIdentity: code, providerModel, soul, rules, skills, behaviorEnv: behaviorEnvInput(), judgmentConfig: judgmentConfigInput(), scorerWeights });
}
