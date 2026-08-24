/**
 * Frozen-sample scorecard — THE evaluator VALIDATION-PROTOCOL.md names
 * (review 2026-08-21: the protocol advertised a weekly scorecard that did
 * not exist). Read-only over proposals.db. Run weekly during the sample
 * and once at completion; the definitions HERE are the protocol's
 * machine-readable form — changing them mid-sample ends the window.
 *
 *   bun run scripts/validation-scorecard.ts               # since baseline
 *   npx tsx scripts/validation-scorecard.ts               # same, node runtime
 *   ... scripts/validation-scorecard.ts 2026-08-25        # since a date (freeze tag day)
 *
 * Definitions (pinned):
 *   - Sample row: status='closed', entry filled, realized_pnl NOT NULL,
 *     exit_reason != 'cancelled', source != 'adopted', note free of the
 *     untrustworthy marker ('NOT trustworthy').
 *   - Net P&L: realized_pnl − commissions. A NULL commission is NOT zero:
 *     it is an accounting hole, counted against the integrity gate.
 *   - Profit factor: Σ net wins ÷ |Σ net losses|.
 *   - Deployable subset (REQ-VAL-008, 2026-08-23): every verdict criterion
 *     is computed over the classes enabled on live day one (intraday +
 *     swing). Shadow-only earnings bets are reported apart and never
 *     carry the aggregate.
 *   - Expectancy LCB (REQ-VAL-003/009): day-block bootstrap clustered by
 *     ENTRY cohort (resample entry days with replacement, 1000 replicates,
 *     seed 42) — the 95% one-sided lower confidence bound of mean net P&L
 *     per trade must be > 0. A positive sample mean carried by one fat day
 *     is not expectancy.
 *   - Live-scale band (REQ-VAL-007): the frozen epoch NetLiq must sit
 *     inside ±10% of the $11,700 live target — the sample must have been
 *     collected at the scale it is meant to predict.
 *   - Portfolio drawdown (REQ-VAL-006, the criterion): peak-to-trough of
 *     MARKED NetLiq from equity-series.jsonl (gateway sampler, 15 min) ≤
 *     2 × live max_daily_loss_pct, with coverage on every trade-close day
 *     (else NOT EVALUABLE). The closed-trade curve is informational only —
 *     it misses unrealized troughs and correlated open exposure. The old
 *     ×4 risk-ratio extrapolation is retired (REQ-SHADOW-004).
 *   - Score deciles: trades bucketed by score into 10 bins; scores above
 *     100 (composite-rank boosts) CLAMP into the top bin and are counted
 *     (REQ-VAL-001 — they used to fall out of every bucket); Spearman rank
 *     correlation computed over PER-TRADE (score, net P&L) pairs;
 *     monotonicity claim needs rho > 0 AND p < 0.05 (t-approximation).
 *   - Take-vs-target (REQ-EXIT-014): take-policy exits (exit_reason
 *     'target' with a stamped take_pct) report realized net, post-exit
 *     same-day MFE (left on the table), and the legacy-geometry
 *     counterfactual tally. Informational — the aggregate criteria judge.
 *   - Epoch fingerprint (REQ-VAL-004): SHA-256 of performance-epoch.json —
 *     the journal records it at tag time so the window's pin cannot drift
 *     silently (the epoch file is mutable JSON, not a git object).
 *   - Top/bottom band: score ≥ 80th percentile vs ≤ 20th percentile of
 *     the SAMPLE's scores, each needing n ≥ 10 to be evaluable.
 *   - Judgment purity: exactly one distinct non-null `model` across the
 *     sample; regime breadth: ≥ 2 distinct non-null, non-'unknown'
 *     `regime` tags; calendar breadth: ≥ 6 distinct ISO-8601 weeks.
 *   - Integrity gate (protocol "zero unresolved anomalies"): no
 *     placement-unconfirmed rows older than 24h, no in-window closes with
 *     NULL realized P&L (outside 'cancelled'), no sample rows missing
 *     commissions. Any anomaly freezes the evaluation: VERDICT is
 *     NOT-EVALUABLE, never PASS.
 *   - VERDICT: single aggregated line at the end; PASS requires EVERY
 *     criterion to hold on an evaluable, integrity-clean sample.
 */

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayBlockBootstrapLcb } from '../src/utils/day-bootstrap.js';
import { auditFreezeManifest, auditRuntimeAttestation, etDayOf, exposureCoverageGaps, fingerprintFreezeCheck, fingerprintPurity, parseEquitySeries, portfolioDrawdown, type SessionWindow } from '../src/utils/equity-series-math.js';
import { calendarCoverageStatus, isMarketHalfDay, isMarketHoliday } from '../src/utils/market-hours.js';
import { DEFAULT_RULES, parseFlatYaml, type RiskRules } from '../src/tools/ibkr/risk-rules.js';

const UNTRUSTWORTHY = '%NOT trustworthy%';
const dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');

// Pins (VALIDATION-PROTOCOL.md). The live target is €10K ≈ $11,700; the
// epoch NetLiq must sit inside ±10% of it (REQ-VAL-007) — FX drift and a
// round-number reset fit, a $49K or $4K account does not. Whole-share
// selection, concentration and commission burden all change with scale.
const TARGET_NETLIQ_USD = 11_700;
const TARGET_NETLIQ_TOLERANCE = 0.10;
/** Every live-ENABLED class must clear this on its own (REQ-VAL-011) —
 *  n≥10 was text, not a floor; 30 is the pre-registered minimum for a
 *  class-level expectancy claim. */
const MIN_TRADES_PER_ENABLED_CLASS = 30;
/** Broker-provenance allowlist (REQ-VAL-010): lanes production actually
 *  stamps. 'test'/'adopted' rows are excluded by the query; a source
 *  outside this list is an integrity anomaly, never a silent sample row. */
const KNOWN_SOURCES = new Set(['trigger', 'breadth', 'agent', 'tui', 'whatsapp', 'chase-continuation']);
const isKnownSource = (s: string) => KNOWN_SOURCES.has(s) || s.startsWith('cron:');

/** Classes enabled on LIVE DAY ONE (REQ-VAL-008/011) — read from the live
 *  rule files themselves, so the verdict's scope IS the deployable config:
 *  flipping a class flag changes what must pass, not just what trades. */
function liveConfig(): { classes: Set<string>; line: string; dailyLossPct: number; riskPerTradePct: number } {
    const cfgDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/config');
    const merged = {
        ...DEFAULT_RULES,
        ...parseFlatYaml(join(cfgDir, 'risk-rules.yaml')),
        ...parseFlatYaml(join(cfgDir, 'risk-rules.live.yaml')),
    } as RiskRules;
    const classes = new Set<string>(['intraday']);
    if (merged.swing_enabled) classes.add('swing');
    if (merged.earnings_bet_enabled) classes.add('earnings-bet');
    return {
        classes,
        line: `deployable classes (from risk-rules.live.yaml flags): ${[...classes].join(', ')} — live daily loss ${merged.max_daily_loss_pct}%`,
        // Review 2026-08-23 (omission 1): a hardcoded 3.0 pin survived the
        // yaml's halving to 1.5 — the drawdown bar would have passed at up
        // to 6% against a 3% reality. The CONFIG is the pin.
        dailyLossPct: merged.max_daily_loss_pct,
        riskPerTradePct: merged.max_risk_per_trade_pct,
    };
}
const { classes: DEPLOYABLE_CLASSES, line: deployableLine, dailyLossPct: LIVE_DAILY_LOSS_PCT, riskPerTradePct: LIVE_RISK_PER_TRADE_PCT } = liveConfig();

interface Row {
    id: string; symbol: string; trade_class: string | null; source: string;
    score: number | null; model: string | null; regime: string | null;
    realized_pnl: number; commissions: number | null; closed_at: number;
    entry_filled_at: number | null; order_perm_ids: string | null;
    exit_reason: string | null; take_pct: number | null;
    post_exit_mfe_pct: number | null; take_counterfactual: string | null;
    strategy_fingerprint: string | null;
}

interface SqliteQuery<T> { all(...params: unknown[]): T[] }
interface SqliteDb { query<T>(sql: string): SqliteQuery<T>; close(): void }

/** Same dual-driver pattern as the store: bun:sqlite under bun,
 *  better-sqlite3 under node/tsx (round-4 review: the script failed on
 *  the gateway's node runtime). */
async function openDb(): Promise<SqliteDb> {
    const dbPath = join(dataDir, 'proposals.db');
    try {
        const sqlite = await import('bun:sqlite');
        const raw = new sqlite.Database(dbPath, { readonly: true });
        return {
            query: <T>(sql: string) => ({ all: (...p: unknown[]) => raw.query(sql).all(...(p as never[])) as T[] }),
            close: () => raw.close(),
        };
    } catch {
        const mod = await import('better-sqlite3');
        const raw = new mod.default(dbPath, { readonly: true });
        return {
            query: <T>(sql: string) => ({ all: (...p: unknown[]) => raw.prepare(sql).all(...p) as T[] }),
            close: () => raw.close(),
        };
    }
}

/** ISO-8601 week label (round-4 review: the old Jan-1 arithmetic was
 *  wrong around year boundaries — week 1 is the week containing Jan 4). */
export function isoWeekLabel(ms: number): string {
    const d = new Date(ms);
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    // Shift to the Thursday of this week: its year IS the ISO year.
    const day = (t.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    t.setUTCDate(t.getUTCDate() - day + 3);
    const isoYear = t.getUTCFullYear();
    const jan4 = new Date(Date.UTC(isoYear, 0, 4));
    const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function spearman(pairs: Array<[number, number]>): { rho: number; p: number } | null {
    const n = pairs.length;
    if (n < 10) return null;
    const rank = (vals: number[]): number[] => {
        const idx = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
        const out = new Array<number>(n);
        let i = 0;
        while (i < n) {
            let j = i;
            while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
            const r = (i + j) / 2 + 1;
            for (let k = i; k <= j; k++) out[idx[k][1]] = r;
            i = j + 1;
        }
        return out;
    };
    const rx = rank(pairs.map((p) => p[0]));
    const ry = rank(pairs.map((p) => p[1]));
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const mx = mean(rx), my = mean(ry);
    let num = 0, dx = 0, dy = 0;
    for (let k = 0; k < n; k++) {
        num += (rx[k] - mx) * (ry[k] - my);
        dx += (rx[k] - mx) ** 2;
        dy += (ry[k] - my) ** 2;
    }
    if (dx === 0 || dy === 0) return { rho: 0, p: 1 };
    const rho = num / Math.sqrt(dx * dy);
    // t-approximation for the p-value (two-sided), adequate at n >= 10.
    const t = rho * Math.sqrt((n - 2) / Math.max(1e-12, 1 - rho * rho));
    const p = 2 * (1 - studentTCdf(Math.abs(t), n - 2));
    return { rho: Math.round(rho * 1000) / 1000, p: Math.round(p * 10_000) / 10_000 };
}

/** Student-t CDF via the incomplete beta (Abramowitz-Stegun continued fraction). */
function studentTCdf(t: number, df: number): number {
    const x = df / (df + t * t);
    return 1 - 0.5 * incompleteBeta(df / 2, 0.5, x);
}
function incompleteBeta(a: number, b: number, x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
    let f = 1, c = 1, d = 0;
    for (let i = 0; i <= 200; i++) {
        const m = Math.floor(i / 2);
        const numer = i === 0 ? 1
            : i % 2 === 0
                ? (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m))
                : -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
        d = 1 + numer * d;
        if (Math.abs(d) < 1e-30) d = 1e-30;
        d = 1 / d;
        c = 1 + numer / c;
        if (Math.abs(c) < 1e-30) c = 1e-30;
        f *= c * d;
        if (Math.abs(1 - c * d) < 1e-8) break;
    }
    return front * (f - 1);
}
function lgamma(z: number): number {
    const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
        12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1;
    let x = 0.99999999999980993;
    for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
    const t = z + g.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// ---------------------------------------------------------------------------

const db = await openDb();
const verdictFails: string[] = [];

// Review-26 P1: FINAL-MODE WINDOW AUTHORITY, resolved BEFORE anything
// reads sinceMs. The old order let a mutable performance-epoch.json (or
// an arbitrary CLI date) define the final window: a `performance reset`
// after losses moved the epoch forward, excluded them, and still
// produced a final verdict against the same tag. In final mode the
// window starts at the GIT TAG TIMESTAMP — the one clock nothing
// post-tag can move — and a conflicting `--since` is rejected.
const git = (args: string[]): string | null => {
    try { return execFileSync('git', args, { timeout: 10_000 }).toString(); } catch { return null; }
};
const FREEZE_TAG = 'validation-freeze-1';
const MANIFEST_REPO_PATH = 'docs/day2day/FREEZE-MANIFEST.md';
const tagExists = (git(['tag', '-l', FREEZE_TAG]) ?? '').trim().length > 0;
const finalMode = process.argv.includes('--final') || tagExists;
// Review-27: the window anchors to the ANNOTATED tag's TAGGER timestamp
// — `git log` gives the tagged commit's time, which can precede the tag
// by hours (leaking that interval's trades into "since the tag"), and a
// lightweight tag has no creation time at all. A lightweight or
// unresolvable tag poisons the window and fails.
let tagTimeMs: number | null = null;
if (tagExists) {
    const { resolveFreezeTagTime } = await import('../src/services/strategy-fingerprint.js');
    const resolved = await resolveFreezeTagTime(FREEZE_TAG);
    if (resolved.ok) {
        tagTimeMs = resolved.tagTimeMs;
        // Review-28 P1: the annotated OBJECT is immutable but the tag NAME
        // is a movable ref — a force-retag over a new manifest commit
        // would move the window while keeping the fingerprint and diff
        // checks green. Pin the tag-object sha OUTSIDE the repo
        // (DEXTER_DATA_DIR) on first sighting, trust-on-first-use; every
        // later evaluation compares. The true immutable anchor is the
        // REMOTE tag — the protocol instructs pushing it and recording
        // the object sha in the journal; this pin makes a local retag
        // tamper-EVIDENT even before that.
        // Review-29/30: the TOFU pin + mandatory remote anchor — the
        // fail-closed branch logic lives in verifyFreezeAnchor (tested
        // with fakes AND against a real temp repo with a bare origin);
        // this is only the wiring.
        const { verifyFreezeAnchor, makeFreezeAnchorDeps } = await import('../src/services/strategy-fingerprint.js');
        const anchor = verifyFreezeAnchor(FREEZE_TAG, resolved.tagObjectSha,
            makeFreezeAnchorDeps(FREEZE_TAG, process.cwd(), join(dataDir, 'freeze-tag-pin.json')));
        for (const n of anchor.notes) console.log(n);
        for (const pr of anchor.problems) verdictFails.push(pr);
    } else {
        verdictFails.push(`final window: ${resolved.reason}`);
    }
}

const sinceArg = process.argv[2];
let sinceMs: number;
let windowLabel: string;
// Round-6 review: the frozen denominator is read unconditionally — an
// explicit --since window previously lost it and could never PASS.
let epochNetliq: number | null = null;
try {
    const b = JSON.parse(readFileSync(join(dataDir, 'performance-epoch.json'), 'utf-8')) as { netLiq?: number };
    if (typeof b.netLiq === 'number' && b.netLiq > 0) epochNetliq = b.netLiq;
} catch { /* reported by the drawdown line */ }
if (tagExists) {
    // Final window: the tag's own clock. An epoch stamped AFTER the tag
    // is a post-tag reset — the exact laundering path review-26 named.
    if (tagTimeMs === null) {
        sinceMs = Number.MAX_SAFE_INTEGER;
        windowLabel = `since tag ${FREEZE_TAG} (UNRESOLVABLE — verdict fails)`;
        verdictFails.push('final window: the tag timestamp could not be resolved');
    } else {
        sinceMs = tagTimeMs;
        windowLabel = `since tag ${FREEZE_TAG} (${new Date(tagTimeMs).toISOString()} — authoritative final window)`;
        if (sinceArg && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(sinceArg)) {
            const requested = sinceArg.includes('T') ? Date.parse(sinceArg) : Date.parse(`${sinceArg}T00:00:00Z`);
            if (requested !== tagTimeMs) {
                verdictFails.push(`final window: explicit --since ${sinceArg} rejected — the window is tag-derived (${new Date(tagTimeMs).toISOString()})`);
            }
        }
        try {
            const b = JSON.parse(readFileSync(join(dataDir, 'performance-epoch.json'), 'utf-8')) as { epochMs?: number };
            if (typeof b.epochMs === 'number' && b.epochMs > tagTimeMs) {
                verdictFails.push(`final window: performance-epoch.json is stamped AFTER the tag (${new Date(b.epochMs).toISOString()}) — a post-tag reset excludes tagged-sample history`);
            }
        } catch { verdictFails.push('final window: performance-epoch.json unreadable — epoch consistency unproven'); }
    }
} else if (sinceArg && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(sinceArg)) {
    // Round-5 review: accept the exact tag TIMESTAMP, not just midnight —
    // a date-only argument floors to 00:00Z and admits pre-tag trades.
    sinceMs = sinceArg.includes('T') ? Date.parse(sinceArg) : Date.parse(`${sinceArg}T00:00:00Z`);
    windowLabel = `since ${sinceArg} (explicit — use the freeze tag's full timestamp)`;
} else {
    try {
        const p = join(dataDir, 'performance-epoch.json');
        const b = JSON.parse(readFileSync(p, 'utf-8')) as { epochMs: number; note?: string };
        sinceMs = b.epochMs;
        windowLabel = `since baseline ${new Date(b.epochMs).toISOString()}${b.note ? ` (${b.note})` : ''}`;
    } catch {
        sinceMs = 0;
        windowLabel = 'ALL HISTORY (no baseline found — pass a date)';
        verdictFails.push('no performance epoch — window undefined');
    }
}

// Paper equity denominator (round-5 review): the FREEZE-TIME NetLiq
// stored in the epoch file. The daily netliq-baseline.json is refreshed
// every trading date — weeks into the sample it is the final day's
// equity, not the equity the sample started from. Fallback is loud.
let paperNetliq: number | null = epochNetliq;
let netliqSource = 'frozen at epoch';
if (paperNetliq === null) {
    try {
        const b = JSON.parse(readFileSync(join(dataDir, 'netliq-baseline.json'), 'utf-8')) as { netLiq?: number };
        if (typeof b.netLiq === 'number' && b.netLiq > 0) {
            paperNetliq = b.netLiq;
            netliqSource = "TODAY'S capture — NOT freeze-time equity; re-freeze the epoch to pin it";
        }
    } catch { /* reported below */ }
}

// REQ-VAL-010: synthetic and adopted rows never qualify — the test-isolation
// failure of 2026-08-23 put source='test' rows INTO the deployable sample.
const SAMPLE_WHERE = `
    WHERE status = 'closed' AND created_at >= ? AND closed_at >= ?
      AND entry_fill_price IS NOT NULL AND realized_pnl IS NOT NULL
      AND (exit_reason IS NULL OR exit_reason != 'cancelled')
      AND source NOT IN ('adopted', 'test', 'smoke')
      AND (note IS NULL OR note NOT LIKE '${UNTRUSTWORTHY}')
    ORDER BY closed_at ASC`;
let allRows: Row[];
try {
    allRows = db.query<Row>(`
        SELECT id, symbol, trade_class, source, score, model, regime,
               realized_pnl, commissions, closed_at, entry_filled_at, order_perm_ids,
               exit_reason, take_pct, post_exit_mfe_pct, take_counterfactual,
               strategy_fingerprint
        FROM proposals ${SAMPLE_WHERE}
    `).all(sinceMs, sinceMs);
} catch {
    // Pre-migration database: the newer columns land with the store's
    // idempotent migration on the next gateway boot. Read-only here — fall
    // back honestly rather than crash or migrate out-of-band. Absent
    // fingerprints then FAIL the purity check below, by design.
    console.log('note: newer columns absent (DB pre-dates the current migration — restart the gateway); take-vs-target reports n/a');
    allRows = db.query<Row>(`
        SELECT id, symbol, trade_class, source, score, model, regime,
               realized_pnl, commissions, closed_at, entry_filled_at, order_perm_ids, exit_reason,
               NULL AS take_pct, NULL AS post_exit_mfe_pct, NULL AS take_counterfactual,
               NULL AS strategy_fingerprint
        FROM proposals ${SAMPLE_WHERE}
    `).all(sinceMs, sinceMs);
}
// REQ-VAL-008: the go-live verdict judges the DEPLOYABLE book — the classes
// enabled on live day one. Shadow-only classes (earnings bets) are reported
// apart and never carry the aggregate.
const rows = allRows.filter((r) => DEPLOYABLE_CLASSES.has(r.trade_class ?? 'intraday'));
const shadowOnlyRows = allRows.filter((r) => !DEPLOYABLE_CLASSES.has(r.trade_class ?? 'intraday'));
// created_at >= window start (round-5 review): "never count pre-freeze
// rows" means rows PROPOSED under the frozen policy — a pre-freeze trade
// that merely closes inside the window was judged by the old policy.

const net = (r: Row) => r.realized_pnl - (r.commissions ?? 0);
const n = rows.length;
console.log(`\n=== VALIDATION SCORECARD — ${windowLabel} ===`);
console.log(deployableLine);
console.log(`deployable sample n = ${n} (protocol needs >= 100)${shadowOnlyRows.length ? `; ${shadowOnlyRows.length} shadow-only row(s) reported separately` : ''}`);
if (n < 100) verdictFails.push(`deployable sample n=${n} < 100`);

// Integrity gate — anomalies freeze the evaluation (protocol: "zero
// unresolved fill/reconciliation anomalies at evaluation time").
const staleUnconfirmed = db.query<{ c: number }>(`
    SELECT COUNT(*) AS c FROM proposals
    WHERE status = 'executed' AND note LIKE '%placement-unconfirmed%'
      AND updated_at < ?
`).all(Date.now() - 24 * 3_600_000)[0]?.c ?? 0;
const pnlHoles = db.query<{ c: number }>(`
    SELECT COUNT(*) AS c FROM proposals
    WHERE status = 'closed' AND closed_at >= ?
      AND realized_pnl IS NULL
      AND (exit_reason IS NULL OR exit_reason != 'cancelled')
      AND source != 'adopted'
`).all(sinceMs)[0]?.c ?? 0;
const missingCommissions = rows.filter((r) => r.commissions === null).length;
// Round-5 review: adoptions ARE reconciliation events — unknown broker
// state appeared during the window; and a post-freeze row without its
// model/regime stamp is an instrumentation failure, not a shrug.
// Round-6: only UNRESOLVED adoptions block (protocol: zero unresolved
// anomalies AT EVALUATION TIME) — an adopted row since closed/resolved
// is history, not an outstanding discrepancy.
const adoptionsOpen = db.query<{ c: number }>(`
    SELECT COUNT(*) AS c FROM proposals WHERE source = 'adopted' AND created_at >= ?
      AND status NOT IN ('closed', 'cancelled', 'failed', 'rejected')
`).all(sinceMs)[0]?.c ?? 0;
const adoptionsResolved = (db.query<{ c: number }>(`
    SELECT COUNT(*) AS c FROM proposals WHERE source = 'adopted' AND created_at >= ?
`).all(sinceMs)[0]?.c ?? 0) - adoptionsOpen;
// Reconciliation truth persisted by the sweep (round-6): orphan orders,
// stale closes, and sweep freshness are now provable, not remembered.
let reconLine = 'reconciliation report: MISSING (.dexter/data/reconciliation-status.json — is the gateway sweep running?)';
let reconAnomalies: string[] = ['no reconciliation report'];
try {
    const rec = JSON.parse(readFileSync(join(dataDir, 'reconciliation-status.json'), 'utf-8')) as {
        at: number; snapshotComplete?: boolean; failures?: string[];
        orphanOrders: Array<{ orderId: number; symbol: string }>; staleCloses: Array<{ orderId: number; symbol: string }>;
        legAdoptions?: number; positionAdoptions?: number; foreignPositions?: number; resolvedAdoptions?: string[];
    };
    const ageH = (Date.now() - rec.at) / 3_600_000;
    reconAnomalies = [];
    // The sweep runs every 15 min while the gateway is up — a report older
    // than 2h means the sweep (or the gateway) is not running (round 7:
    // 24h let a stale clean report outlive a day of failing sweeps).
    if (ageH > 2) reconAnomalies.push(`reconciliation report is ${ageH.toFixed(1)}h old (sweep runs every 15min)`);
    if (rec.snapshotComplete === false) reconAnomalies.push('last open-orders snapshot INCOMPLETE — the clean book is unproven');
    for (const f of rec.failures ?? []) reconAnomalies.push(`sweep failure: ${f}`);
    if (rec.orphanOrders.length > 0) reconAnomalies.push(`${rec.orphanOrders.length} orphan order(s) outstanding: ${rec.orphanOrders.map((o) => `#${o.orderId} ${o.symbol}`).join(', ')}`);
    if ((rec.staleCloses ?? []).length > 0) reconAnomalies.push(`${rec.staleCloses.length} stale close order(s) on flat symbols`);
    // Round-8 review: foreign-account exposure on the connection violates
    // the single-account rule (D5) — never part of a CLEAN report.
    if ((rec.foreignPositions ?? 0) > 0) reconAnomalies.push(`${rec.foreignPositions} position(s) in a FOREIGN account (single-account rule D5)`);
    const info: string[] = [];
    if ((rec.legAdoptions ?? 0) > 0) info.push(`${rec.legAdoptions} leg adoption(s) last sweep`);
    if ((rec.positionAdoptions ?? 0) > 0) info.push(`${rec.positionAdoptions} position adoption(s) last sweep`);
    if ((rec.resolvedAdoptions ?? []).length > 0) info.push(`resolved: ${rec.resolvedAdoptions!.join(', ')}`);
    reconLine = `reconciliation report: ${new Date(rec.at).toISOString()} — ${reconAnomalies.length === 0 ? 'clean' : reconAnomalies.join('; ')}` +
        (info.length > 0 ? ` [${info.join('; ')}]` : '');
} catch { /* reconLine already says MISSING */ }
console.log(reconLine);
const missingStamps = rows.filter((r) => r.model === null || r.regime === null || r.regime === 'unknown').length;
// REQ-VAL-010: provenance. Every sample row must come from a known
// production lane AND carry broker execution identity (permIds, WP1) —
// a row without them was not proven to be a broker trade.
const unknownSources = [...new Set(rows.filter((r) => !isKnownSource(r.source)).map((r) => r.source))];
const missingPermIds = rows.filter((r) => {
    if (r.order_perm_ids === null) return true;
    try {
        const ids = JSON.parse(r.order_perm_ids) as Array<number | null>;
        return !ids.some((v) => typeof v === 'number' && v > 0);
    } catch { return true; }
}).length;
const anomalies: string[] = [];
if (unknownSources.length > 0) anomalies.push(`unrecognized proposal source(s) in the sample: ${unknownSources.join(', ')} — provenance unproven`);
if (missingPermIds > 0) anomalies.push(`${missingPermIds} sample row(s) without broker permIds — execution identity unproven (WP1)`);
if (staleUnconfirmed > 0) anomalies.push(`${staleUnconfirmed} placement-unconfirmed row(s) older than 24h`);
if (pnlHoles > 0) anomalies.push(`${pnlHoles} in-window close(s) with NULL realized P&L`);
if (missingCommissions > 0) anomalies.push(`${missingCommissions} sample row(s) missing commissions (net P&L overstated)`);
if (adoptionsOpen > 0) anomalies.push(`${adoptionsOpen} adopted position(s) still OPEN (unresolved reconciliation events)`);
if (adoptionsResolved > 0) console.log(`note: ${adoptionsResolved} in-window adoption(s) already resolved — informational, not blocking`);
for (const a of reconAnomalies) anomalies.push(a);
if (missingStamps > 0) anomalies.push(`${missingStamps} sample row(s) missing model/regime stamps (post-freeze instrumentation failure)`);
console.log(`integrity: ${anomalies.length === 0 ? 'CLEAN' : `ANOMALIES — ${anomalies.join('; ')}`}`);
for (const a of anomalies) verdictFails.push(`integrity: ${a}`);

if (n === 0) {
    console.log('No sample rows yet.');
    console.log(`\nVERDICT: NOT EVALUABLE (${verdictFails.join('; ')})\n`);
    db.close();
    process.exit(0);
}

// Core metrics
const nets = rows.map(net);
const total = nets.reduce((s, v) => s + v, 0);
const expectancy = total / n;
const wins = nets.filter((v) => v > 0);
const losses = nets.filter((v) => v < 0);
const pf = losses.length ? wins.reduce((s, v) => s + v, 0) / Math.abs(losses.reduce((s, v) => s + v, 0)) : Infinity;
console.log(`net P&L ${total.toFixed(2)}  expectancy/trade ${expectancy.toFixed(2)} (${expectancy > 0 ? 'PASS' : 'FAIL'} — must be > 0)`);
console.log(`profit factor ${Number.isFinite(pf) ? pf.toFixed(2) : '∞'} (${pf >= 1.3 ? 'PASS' : 'FAIL'} — must be >= 1.3)`);
console.log(`win rate ${(100 * wins.length / n).toFixed(1)}% (${wins.length}W/${losses.length}L/${n - wins.length - losses.length} flat)`);
if (expectancy <= 0) verdictFails.push(`expectancy ${expectancy.toFixed(2)} <= 0`);
if (pf < 1.3) verdictFails.push(`profit factor ${pf.toFixed(2)} < 1.3`);

// Expectancy lower confidence bound (REQ-VAL-003/009): day-block bootstrap
// clustered by ENTRY cohort — trades entered the same session share the
// tape, the regime and often the catalyst; a close date is an accident of
// holding time (review 2026-08-23). Rows without an entry stamp fall back
// to their close day, reported.
const byDay = new Map<string, number[]>();
let entryStampMissing = 0;
for (const r of rows) {
    const anchor = r.entry_filled_at ?? r.closed_at;
    if (r.entry_filled_at === null) entryStampMissing++;
    const day = etDayOf(anchor);
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(net(r));
}
const boot = dayBlockBootstrapLcb(byDay);
if (boot) {
    console.log(`expectancy 95% LCB ${boot.lcb.toFixed(2)}/trade (entry-cohort day-block bootstrap, ${boot.days} cohorts × ${boot.replicates} replicates, seed 42${entryStampMissing ? `; ${entryStampMissing} row(s) anchored on close day — no entry stamp` : ''}) (${boot.lcb > 0 ? 'PASS' : 'FAIL'} — must be > 0)`);
    if (boot.lcb <= 0) verdictFails.push(`expectancy LCB ${boot.lcb.toFixed(2)} <= 0 (mean may be outlier-carried)`);
} else {
    console.log(`expectancy LCB: not evaluable (< 5 distinct entry cohorts)`);
    verdictFails.push('expectancy LCB not evaluable (< 5 entry cohorts)');
}

// Live-scale band (REQ-VAL-007): the epoch NetLiq IS the scale the sample
// was collected at — it must be the live scale, inside a narrow band.
if (paperNetliq !== null) {
    const lo = TARGET_NETLIQ_USD * (1 - TARGET_NETLIQ_TOLERANCE);
    const hi = TARGET_NETLIQ_USD * (1 + TARGET_NETLIQ_TOLERANCE);
    const inBand = paperNetliq >= lo && paperNetliq <= hi;
    console.log(`epoch NetLiq ${paperNetliq.toFixed(0)} [${netliqSource}] vs live target ${TARGET_NETLIQ_USD} ±${TARGET_NETLIQ_TOLERANCE * 100}% [${lo.toFixed(0)}, ${hi.toFixed(0)}] (${inBand ? 'PASS' : 'FAIL'} — the sample must be collected at the live scale)`);
    if (netliqSource !== 'frozen at epoch') verdictFails.push('epoch NetLiq not frozen (epoch has no netLiq)');
    if (!inBand) verdictFails.push(`epoch NetLiq ${paperNetliq.toFixed(0)} outside the live-scale band [${lo.toFixed(0)}, ${hi.toFixed(0)}] — reset the paper account to ≈$${TARGET_NETLIQ_USD} before the freeze`);
} else {
    console.log('epoch NetLiq: NOT EVALUABLE — performance-epoch.json / netliq-baseline.json missing');
    verdictFails.push('epoch NetLiq not evaluable');
}

// Portfolio drawdown (REQ-VAL-006 — the verdict criterion): peak-to-trough
// of MARKED NetLiq from equity-series.jsonl, which sees the intraday and
// overnight troughs a closed-trade curve cannot. Coverage is part of the
// proof: every ET day a sample trade closed must carry at least one
// sample, or the criterion is not evaluable (fail-closed).
let seriesLine: string;
// Review-17 freeze integrity: fingerprints seen on IN-WINDOW equity
// samples, folded into the purity check below (null = no series at all —
// the drawdown criterion already fails on that separately).
let seriesFingerprints: Array<string | undefined> | null = null;
try {
    const series = parseEquitySeries(readFileSync(join(dataDir, 'equity-series.jsonl'), 'utf-8'));
    seriesFingerprints = series.filter((s) => s.ts >= sinceMs).map((s) => s.fingerprint);
    // Seeded with the FROZEN epoch NetLiq (review 2026-08-23): the curve
    // starts where the sample started — a loss before the first real sample
    // must not vanish.
    const seeded = epochNetliq !== null
        ? [{ ts: sinceMs, netLiq: epochNetliq }, ...series.filter((s) => s.ts > sinceMs)]
        : series;
    // Shadow-adjusted (review 2026-08-23): account NetLiq carries the
    // shadow-only classes' REALIZED P&L — nine fat bet winners could mask a
    // deployable drawdown. Subtract their cumulative realized net (a step
    // function at each shadow close); unrealized in-flight distortion is
    // bounded by the 1-bet budget cap and recorded in the protocol.
    const shadowSteps = shadowOnlyRows
        .map((r) => ({ ts: r.closed_at, net: net(r) }))
        .sort((a, b) => a.ts - b.ts);
    const shadowNetBefore = (ts: number) => {
        let sum = 0;
        for (const s of shadowSteps) { if (s.ts <= ts) sum += s.net; else break; }
        return sum;
    };
    // …and by the sampler's recorded UNREALIZED shadow marks (review
    // 2026-08-23: realized alone left in-flight shadow P&L moving the
    // deployable curve while a shadow swing/bet was open).
    const adjusted = seeded.map((s) => ({
        ts: s.ts,
        netLiq: s.netLiq - shadowNetBefore(s.ts) - (s.shadowUnrealized ?? 0),
    }));
    const incompleteMarks = series.filter((s) => s.ts >= sinceMs && s.shadowMarkComplete === false).length;
    if (incompleteMarks > 0) {
        verdictFails.push(`${incompleteMarks} equity sample(s) with INCOMPLETE shadow marks — the deployable curve is unproven on those intervals`);
    }
    const pdd = portfolioDrawdown(adjusted, sinceMs);
    if (!pdd || pdd.samples <= (epochNetliq !== null ? 1 : 0)) {
        seriesLine = 'portfolio drawdown: NOT EVALUABLE — no equity samples inside the window (is the gateway sampler running?)';
        verdictFails.push('portfolio drawdown not evaluable (no equity samples in window)');
    } else {
        const ok = pdd.maxDdPct <= 2 * LIVE_DAILY_LOSS_PCT;
        seriesLine = `portfolio drawdown ${pdd.maxDdPct.toFixed(2)}% of marked NetLiq, epoch-seeded (peak ${pdd.peak.toFixed(0)} → trough ${pdd.trough.toFixed(0)}, ${pdd.samples} samples over ${pdd.days.size} day(s)) (${ok ? 'PASS' : 'FAIL'} — must be <= ${2 * LIVE_DAILY_LOSS_PCT}%)`;
        if (!ok) verdictFails.push(`portfolio drawdown ${pdd.maxDdPct.toFixed(2)}% > ${2 * LIVE_DAILY_LOSS_PCT}%`);
        // Coverage (review 2026-08-23): the series must have been WATCHING
        // through every EXPOSURE interval — one sample per close day
        // certified a sampler that slept through the trough.
        const intervals = rows
            .filter((r) => r.entry_filled_at !== null)
            .map((r) => ({ from: r.entry_filled_at!, to: r.closed_at, label: r.id }));
        const noEntryStamp = rows.length - intervals.length;
        // Calendar-aware sessions (review 2026-08-23): a closed holiday owes
        // nothing, a half-day's extended session ends 17:00 ET, and a day
        // beyond the maintained holiday table cannot be certified at all.
        const sessionFor = (day: string): SessionWindow => {
            if (Number(day.slice(0, 4)) > calendarCoverageStatus(day).lastCoveredYear) return 'unknown';
            if (isMarketHoliday(day)) return 'closed';
            if (isMarketHalfDay(day)) return { startMin: 4 * 60, endMin: 17 * 60 };
            return { startMin: 4 * 60, endMin: 20 * 60 };
        };
        const gaps = exposureCoverageGaps(series, intervals, 20, sessionFor);
        if (noEntryStamp > 0) {
            seriesLine += `\n  ⚠ ${noEntryStamp} row(s) without an entry stamp — their exposure windows are unverifiable`;
            verdictFails.push(`${noEntryStamp} exposure window(s) unverifiable (no entry stamp)`);
        }
        if (gaps.length > 0) {
            seriesLine += `\n  ⚠ exposure coverage: ${gaps.slice(0, 4).join('; ')}${gaps.length > 4 ? `; +${gaps.length - 4} more` : ''} — criterion NOT EVALUABLE`;
            verdictFails.push(`portfolio drawdown coverage incomplete (${gaps.length} exposure gap(s))`);
        }
        // Scope caveat (review 2026-08-23, recorded): NetLiq marks the WHOLE
        // account — shadow-only bets and any manual position ride inside it.
        // Bets are capped at 1 concurrent / 1% worst-case budget, bounding
        // the distortion to a fraction of the 6% bar; separating accounts is
        // on the live-gate backlog.
        if (shadowOnlyRows.length > 0) {
            seriesLine += `\n  note: curve adjusted by −$${shadowNetBefore(Number.POSITIVE_INFINITY).toFixed(0)} cumulative REALIZED shadow-class P&L; unrealized in-flight distortion is bounded by the 1-bet budget cap (recorded caveat)`;
        }
    }
} catch {
    seriesLine = 'portfolio drawdown: NOT EVALUABLE — equity-series.jsonl missing (the gateway sampler writes it every 5 min; REQ-VAL-006)';
    verdictFails.push('portfolio drawdown not evaluable (no equity series)');
}
console.log(seriesLine);

// Closed-trade drawdown — INFORMATIONAL since 2026-08-23 (it was the
// criterion; it misses unrealized troughs and correlated open exposure).
let equity = 0, peak = 0, maxDd = 0;
for (const v of nets) { equity += v; if (equity > peak) peak = equity; maxDd = Math.max(maxDd, peak - equity); }
console.log(`closed-trade drawdown ${maxDd.toFixed(2)}${paperNetliq !== null ? ` = ${((maxDd / paperNetliq) * 100).toFixed(2)}% of epoch NetLiq` : ''} (informational — the portfolio series is the criterion)`);

// Per-class discipline (REQ-VAL-011, tightened review 2026-08-23):
// EVERY live-ENABLED class — earnings bets included the day their flag
// flips — must clear its own pre-registered floor: n >= 30, net > 0,
// PF >= 1.3, AND a positive entry-cohort bootstrap LCB ("30 trades and
// net positive" passes at +$1 or on one outlier; a class-level expectancy
// claim needs a class-level bound). Otherwise the verdict FAILS: disable
// the class in risk-rules.live.yaml or keep collecting.
console.log(`\nper-class (every ENABLED class: n>=${MIN_TRADES_PER_ENABLED_CLASS}, net>0, PF>=1.3, cohort LCB>0):`);
const byClass = new Map<string, Row[]>();
for (const r of rows) {
    const k = r.trade_class ?? 'intraday';
    (byClass.get(k) ?? byClass.set(k, []).get(k)!).push(r);
}
for (const cls of DEPLOYABLE_CLASSES) {
    const rs = byClass.get(cls) ?? [];
    const t = rs.reduce((s, r) => s + net(r), 0);
    const enough = rs.length >= MIN_TRADES_PER_ENABLED_CLASS;
    const clsWins = rs.map(net).filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const clsLosses = Math.abs(rs.map(net).filter((v) => v < 0).reduce((s, v) => s + v, 0));
    const clsPf = clsLosses > 0 ? clsWins / clsLosses : Infinity;
    const clsDays = new Map<string, number[]>();
    for (const r of rs) {
        const day = etDayOf(r.entry_filled_at ?? r.closed_at);
        (clsDays.get(day) ?? clsDays.set(day, []).get(day)!).push(net(r));
    }
    const clsBoot = dayBlockBootstrapLcb(clsDays);
    const pass = enough && t > 0 && clsPf >= 1.3 && clsBoot !== null && clsBoot.lcb > 0;
    console.log(
        `  ${cls}: n=${rs.length} net ${t.toFixed(2)} PF ${Number.isFinite(clsPf) ? clsPf.toFixed(2) : '∞'} ` +
        `LCB ${clsBoot ? clsBoot.lcb.toFixed(2) : 'n/a'} ${pass ? 'PASS' : 'FAIL'}` +
        `${enough ? '' : ` (n < ${MIN_TRADES_PER_ENABLED_CLASS} — an ENABLED class without its own record cannot go live: disable it or keep collecting)`}`,
    );
    if (!pass) {
        verdictFails.push(enough
            ? `class ${cls} fails its own bar (net ${t.toFixed(2)}, PF ${Number.isFinite(clsPf) ? clsPf.toFixed(2) : '∞'}, LCB ${clsBoot ? clsBoot.lcb.toFixed(2) : 'not evaluable'}) at n=${rs.length}`
            : `class ${cls} enabled but under-sampled (n=${rs.length} < ${MIN_TRADES_PER_ENABLED_CLASS}) — disable it in risk-rules.live.yaml or keep collecting`);
    }
}

// Right-censoring (review 2026-08-23 P1): a closed-only sample can reach
// 100 winners while slow losers sit open and excluded. The FINAL verdict
// refuses while any in-cohort trade (entered inside the window, still
// working) remains unresolved — freeze intake, wait, then evaluate.
const openInCohort = db.query<{ c: number }>(`
    SELECT COUNT(*) AS c FROM proposals
    WHERE status IN ('executing', 'executed') AND created_at >= ?
      AND source NOT IN ('adopted', 'test', 'smoke')
`).all(sinceMs)[0]?.c ?? 0;
if (openInCohort > 0) {
    console.log(`\ncohort completeness: ${openInCohort} in-cohort trade(s) still OPEN — the closed-trade sample is right-censored; a final PASS must wait for them`);
    verdictFails.push(`${openInCohort} in-cohort trade(s) still open (right-censored sample)`);
} else {
    console.log('\ncohort completeness: no in-cohort trades open — sample not right-censored');
}

// Shadow-only classes (REQ-VAL-008): classes DISABLED in the live config
// trade in shadow only to build the record their enable decision needs.
// Never in the verdict — a profitable experimental class must not carry a
// negative deployable book, nor sink it. Reported PER CLASS (review
// 2026-08-23: never lump all disabled classes under one label), each
// against the SAME bar an enabled class faces: n>=30, net>0, PF>=1.3.
if (shadowOnlyRows.length > 0) {
    const byShadowClass = new Map<string, Row[]>();
    for (const r of shadowOnlyRows) {
        const k = r.trade_class ?? 'intraday';
        (byShadowClass.get(k) ?? byShadowClass.set(k, []).get(k)!).push(r);
    }
    for (const [cls, rs] of byShadowClass) {
        const bNets = rs.map(net);
        const bTotal = bNets.reduce((s, v) => s + v, 0);
        const bWins = bNets.filter((v) => v > 0), bLosses = bNets.filter((v) => v < 0);
        const bPf = bLosses.length ? bWins.reduce((s, v) => s + v, 0) / Math.abs(bLosses.reduce((s, v) => s + v, 0)) : Infinity;
        // Review 2026-08-23 (omission 2): the shadow bar is the SAME bar an
        // enabled class faces — the cohort LCB included, or 'bar MET' could
        // print on an outlier-carried record.
        const bDays = new Map<string, number[]>();
        for (const r of rs) {
            const day = etDayOf(r.entry_filled_at ?? r.closed_at);
            (bDays.get(day) ?? bDays.set(day, []).get(day)!).push(net(r));
        }
        const bBoot = dayBlockBootstrapLcb(bDays);
        const barMet = rs.length >= MIN_TRADES_PER_ENABLED_CLASS && bTotal > 0 && bPf >= 1.3
            && bBoot !== null && bBoot.lcb > 0;
        console.log(
            `\nshadow-only ${cls} record (NOT in the verdict): n=${rs.length} net ${bTotal.toFixed(2)} ` +
            `expectancy ${(bTotal / rs.length).toFixed(2)} PF ${Number.isFinite(bPf) ? bPf.toFixed(2) : '∞'} ` +
            `LCB ${bBoot ? bBoot.lcb.toFixed(2) : 'n/a'} ` +
            `win ${(100 * bWins.length / rs.length).toFixed(1)}% — ` +
            `${barMet
                ? 'class bar MET (enable is a deliberate operator flag flip, recorded in the journal — never automatic)'
                : rs.length >= MIN_TRADES_PER_ENABLED_CLASS
                    ? 'class bar NOT met — stays disabled'
                    : `below ${MIN_TRADES_PER_ENABLED_CLASS} trades — stays disabled regardless`}`,
        );
    }
}

// Per-lane split (informational)
console.log('\nper-lane (informational):');
const byLane = new Map<string, number[]>();
for (const r of rows) (byLane.get(r.source) ?? byLane.set(r.source, []).get(r.source)!).push(net(r));
for (const [k, vs] of byLane) console.log(`  ${k}: n=${vs.length} net ${vs.reduce((s, v) => s + v, 0).toFixed(2)}`);

// Take-vs-target (REQ-EXIT-014, informational): what the take policy
// banked vs what it left on the table, plus the legacy-geometry replay.
const takes = rows.filter((r) => r.exit_reason === 'target' && r.take_pct !== null);
if (takes.length > 0) {
    const takeNet = takes.reduce((s, r) => s + net(r), 0);
    const withPost = takes.filter((r) => r.post_exit_mfe_pct !== null);
    const meanPost = withPost.length
        ? withPost.reduce((s, r) => s + (r.post_exit_mfe_pct ?? 0), 0) / withPost.length
        : null;
    const cf = { 'target-first': 0, 'stop-first': 0, neither: 0, pending: 0 };
    for (const r of takes) {
        if (r.take_counterfactual === 'target-first') cf['target-first']++;
        else if (r.take_counterfactual === 'stop-first') cf['stop-first']++;
        else if (r.take_counterfactual === 'neither') cf.neither++;
        else cf.pending++;
    }
    console.log(
        `\ntake-vs-target (take-policy exits): n=${takes.length} net ${takeNet.toFixed(2)} mean ${(takeNet / takes.length).toFixed(2)}` +
        `\n  left on the table: mean post-exit MFE ${meanPost !== null ? `${meanPost.toFixed(2)}%` : 'n/a'} (${withPost.length}/${takes.length} measured)` +
        `\n  legacy 1×/2×ATR counterfactual: target-first ${cf['target-first']}, stop-first ${cf['stop-first']}, neither ${cf.neither}, pending ${cf.pending}`,
    );
} else {
    console.log('\ntake-vs-target: no take-policy exits in the sample yet');
}

// Score deciles + Spearman (confidence-sizing gate — NOT part of the
// go-live verdict; it decides flat-vs-banded sizing separately).
const scored = rows.filter((r) => r.score !== null) as Array<Row & { score: number }>;
// REQ-VAL-001: composite-rank boosts push some scores past 100 — they
// clamp into the top bin (and are counted) instead of silently escaping
// every bucket and biasing the decile table toward the unboosted lanes.
const over100 = scored.filter((r) => r.score > 100).length;
console.log(`\nscore deciles (scored n=${scored.length}${over100 > 0 ? `, ${over100} score(s) > 100 clamped into 90+` : ''}):`);
for (let d = 0; d < 10; d++) {
    const lo = d * 10, hi = lo + 10;
    const rs = scored.filter((r) => r.score >= lo && (d === 9 ? true : r.score < hi));
    if (rs.length) {
        const t = rs.reduce((s, r) => s + net(r), 0);
        console.log(`  ${lo}-${d === 9 ? '100+' : hi}: n=${rs.length} net ${t.toFixed(2)} mean ${(t / rs.length).toFixed(2)}`);
    }
}
const sp = spearman(scored.map((r) => [r.score, net(r)]));
if (sp) {
    const pass = sp.rho > 0 && sp.p < 0.05;
    console.log(`Spearman(score, net) over trades: rho=${sp.rho} p=${sp.p} → confidence sizing ${pass ? 'MAY leave flat (also needs band check)' : 'stays FLAT'}`);
    const scores = scored.map((r) => r.score).sort((a, b) => a - b);
    const p20 = scores[Math.floor(0.2 * (scores.length - 1))];
    const p80 = scores[Math.floor(0.8 * (scores.length - 1))];
    const top = scored.filter((r) => r.score >= p80);
    const bot = scored.filter((r) => r.score <= p20);
    const wr = (rs: typeof top) => rs.length ? rs.filter((r) => net(r) > 0).length / rs.length : NaN;
    console.log(`top band (score>=${p80}, n=${top.length}) win ${(100 * wr(top)).toFixed(1)}% vs bottom (score<=${p20}, n=${bot.length}) win ${(100 * wr(bot)).toFixed(1)}%` +
        `${top.length >= 10 && bot.length >= 10 ? (wr(top) > wr(bot) ? ' — band check PASS' : ' — band check FAIL') : ' — bands not evaluable (n<10)'}`);
} else {
    console.log('Spearman: not evaluable (scored n < 10) — confidence sizing stays FLAT');
}

// Epoch fingerprint (REQ-VAL-004): the window is pinned by a mutable JSON
// file — hash it so the journal can prove the pin never drifted.
try {
    const raw = readFileSync(join(dataDir, 'performance-epoch.json'));
    console.log(`\nepoch fingerprint: sha256 ${createHash('sha256').update(raw).digest('hex')} (record in the validation journal at tag time)`);
} catch {
    console.log('\nepoch fingerprint: performance-epoch.json unreadable');
}

// Purity + breadth
const models = new Set(rows.map((r) => r.model ?? 'NULL'));
// 'unknown' is the regime service's fallback tag, not an observed regime —
// it must not satisfy breadth (round-4 review).
const regimes = new Set(rows.map((r) => r.regime).filter((v): v is string => v !== null && v !== 'unknown'));
const weeks = new Set(rows.map((r) => isoWeekLabel(r.closed_at)));
const purityOk = models.size === 1 && !models.has('NULL');
console.log(`\njudgment purity: models = [${[...models].join(', ')}] ${purityOk ? 'PASS' : 'FAIL — sample must be single-model, no NULLs'}`);
console.log(`regime breadth: ${regimes.size} tag(s) [${[...regimes].join(', ')}] (${regimes.size >= 2 ? 'PASS' : 'FAIL'} — needs >= 2 real tags; NULL/'unknown' do not count)`);
console.log(`calendar breadth: ${weeks.size} ISO week(s) (${weeks.size >= 6 ? 'PASS' : 'FAIL'} — needs >= 6)`);
if (!purityOk) verdictFails.push('judgment purity (multiple or NULL models)');
if (regimes.size < 2) verdictFails.push(`regime breadth ${regimes.size} < 2`);
if (weeks.size < 6) verdictFails.push(`calendar breadth ${weeks.size} < 6 ISO weeks`);

// Review-17/18 freeze integrity: exactly ONE strategy fingerprint across
// the sample rows AND the in-window equity samples. A mid-sample rules
// edit, profile flip, judgment-doc/skill rewrite, model switch or code
// deploy is a DIFFERENT strategy, not more data — and an absent stamp
// means the instrumentation cannot prove otherwise. The single surviving
// value is what the freeze manifest records.
// Review-32 P1: the evaluator's OWN fingerprint must be computed in the
// SAME resolution context the gateway runs in. The connection layer
// calls setAccountProfile('paper') when the paper account verifies, and
// DEXTER_RISK_PROFILE=live escalates on top (shadow-live); a standalone
// evaluator never sees the account event, resolves the PAPER rules, and
// would compute a fingerprint no correct gateway can ever match. Mirror
// the verified-paper context through the SHARED setter before hashing.
let currentFp: string | null = null;
try {
    const { setAccountProfile } = await import('../src/tools/ibkr/risk-rules.js');
    setAccountProfile('paper');
    currentFp = await (await import('../src/services/strategy-fingerprint.js')).strategyFingerprint();
} catch { currentFp = null; }

const fpValues = [...rows.map((r) => r.strategy_fingerprint), ...(seriesFingerprints ?? [])];
if (fpValues.length > 0) {
    const fp = fingerprintPurity(fpValues);
    console.log(`strategy fingerprint: [${fp.distinct.join(', ')}] (${fp.ok ? 'PASS' : 'FAIL — the window must carry exactly one fingerprint, no ABSENT stamps'}; record it in the freeze manifest)`);
    if (!fp.ok) verdictFails.push('strategy fingerprint mixed or absent (rules/judgment/skills/model/code changed mid-sample, or pre-fingerprint rows in the cohort)');

    // Review-21: internal purity is NOT identity — a sample collected on
    // a dirty tree and committed afterwards would evaluate clean with a
    // pure historical fingerprint. The sample's fingerprint must equal
    // the fingerprint of THIS evaluating runtime, and the manifest's
    // recorded one once it is filled.
    const sampleFp = fp.ok ? fp.distinct[0] : null;
    // Review-22/23: once the freeze tag exists (or on an explicit --final
    // run) the manifest is MANDATORY and is read FROM THE TAG — the
    // working-tree copy is mutable after tagging (docs edits deliberately
    // do not dirty the runtime identity), so trusting it would let a
    // post-tag edit make the manifest match anything. The working-tree
    // manifest serves ONLY explicitly-labelled pre-tag diagnostics.
    const parseManifestFp = (man: string): string | null =>
        /Strategy fingerprint[^|\n]*\|\s*([0-9a-f]{12})\s*\|/.exec(man)?.[1] ?? null;
    let manifestFp: string | null = null;
    let manifestSource: string;
    if (finalMode) {
        manifestSource = `tag ${FREEZE_TAG}`;
        if (!tagExists) {
            manifestSource = 'MISSING TAG';
            verdictFails.push(`freeze identity: --final requires the ${FREEZE_TAG} tag to exist`);
        } else {
            const tagged = git(['show', `${FREEZE_TAG}:${MANIFEST_REPO_PATH}`]);
            if (tagged === null) {
                verdictFails.push('freeze identity: manifest unreadable FROM THE TAG');
            } else {
                // Review-24: the WHOLE manifest is enforced mechanically —
                // every unfilled placeholder (ratification, observations,
                // waivers, epoch fields), the recorded tag name, and the
                // recorded deployable scope. Fingerprint parsing alone let
                // a template full of _pending_ rows pass a final verdict.
                const audit = auditFreezeManifest(tagged, { tag: FREEZE_TAG, deployableClasses: [...DEPLOYABLE_CLASSES] });
                manifestFp = audit.fingerprint;
                for (const p of audit.problems) verdictFails.push(`freeze manifest: ${p}`);
                // Review-26 P1: the tagged epoch hash must equal the LIVE
                // epoch file — a `performance reset` after the tag is a
                // different denominator and a different window seed.
                if (audit.epochSha !== null) {
                    let currentEpochSha: string | null = null;
                    try {
                        currentEpochSha = createHash('sha256').update(readFileSync(join(dataDir, 'performance-epoch.json'))).digest('hex');
                    } catch { /* unreadable */ }
                    if (currentEpochSha === null) {
                        verdictFails.push('freeze identity: performance-epoch.json unreadable — cannot compare with the tagged epoch hash');
                    } else if (currentEpochSha !== audit.epochSha) {
                        verdictFails.push(`freeze identity: performance-epoch.json hash ${currentEpochSha.slice(0, 12)}… != the hash recorded in the tagged manifest — the epoch was reset or modified after the tag`);
                    }
                }
                // The manifest's Tagged-at must agree with the TAGGER clock —
                // review-27: a tight tolerance (10 min), because the manifest
                // is written moments before the tag is placed; anything wider
                // re-opens the commit-before-tag interval.
                if (audit.taggedAtMs === null) {
                    verdictFails.push("freeze manifest: 'Tagged at (UTC)' is not a parseable timestamp");
                } else if (tagTimeMs !== null && Math.abs(audit.taggedAtMs - tagTimeMs) > 10 * 60_000) {
                    verdictFails.push(`freeze manifest: 'Tagged at (UTC)' differs from the tag's tagger timestamp by more than 10 minutes`);
                }
                if (audit.baselineSha === null) {
                    verdictFails.push('freeze identity: the tagged manifest declares no behavioral baseline SHA');
                } else if (git(['merge-base', '--is-ancestor', audit.baselineSha, FREEZE_TAG]) === null) {
                    verdictFails.push(`freeze identity: declared baseline ${audit.baselineSha.slice(0, 8)} is NOT an ancestor of the tag`);
                } else {
                    // Ancestry alone proves order, not content. Review-25:
                    // every branch here FAILS CLOSED — an unresolvable tag
                    // commit, baseline == tag (no manifest commit exists),
                    // a failed diff, and an empty diff each fail; the
                    // changed set must be EXACTLY [the manifest].
                    const tagSha = git(['rev-parse', `${FREEZE_TAG}^{commit}`]);
                    const diffOut = git(['diff', '--name-only', `${audit.baselineSha}..${FREEZE_TAG}`]);
                    if (tagSha === null || !/^[0-9a-f]{40}$/.test(tagSha)) {
                        verdictFails.push('freeze identity: the tag commit could not be resolved');
                    } else if (tagSha === audit.baselineSha) {
                        verdictFails.push('freeze identity: baseline EQUALS the tag commit — no manifest-only commit exists over the baseline');
                    } else if (diffOut === null) {
                        verdictFails.push('freeze identity: the baseline→tag diff could not be computed — manifest-only transition unproven');
                    } else {
                        const changed = diffOut.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
                        const offenders = changed.filter((path) => path !== MANIFEST_REPO_PATH);
                        if (offenders.length > 0) {
                            verdictFails.push(
                                `freeze identity: baseline→tag diff touches non-manifest path(s): ` +
                                `${offenders.slice(0, 5).join(', ')}${offenders.length > 5 ? ', …' : ''} — the tag is not a manifest-only commit over its baseline`,
                            );
                        } else if (changed.length === 0) {
                            verdictFails.push('freeze identity: the baseline→tag diff is EMPTY — the tag commit does not change the manifest');
                        }
                    }
                }
            }
        }
    } else {
        manifestSource = 'working tree (pre-tag diagnostics)';
        try {
            manifestFp = parseManifestFp(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), `../${MANIFEST_REPO_PATH}`), 'utf-8'));
        } catch { manifestFp = null; }
    }
    const freeze = fingerprintFreezeCheck({ sampleFp, currentFp, manifestFp, requireManifest: finalMode });
    console.log(`freeze identity: sample=${sampleFp ?? 'n/a'} current=${currentFp ?? 'UNRESOLVABLE'} manifest=${manifestFp ?? 'not filled'} [${manifestSource}${finalMode ? ' — FINAL, manifest required' : ''}]${freeze.ok ? ' — MATCH' : ''}`);
    for (const p of freeze.problems) verdictFails.push(`freeze identity: ${p}`);

}

// Review-31/32: the deployable line above prints the YAML — and this
// audit runs UNCONDITIONALLY (review-32 P2: it used to sit inside the
// fingerprint block and was skipped on a clean pre-sample run, the exact
// moment the protocol needs runtime confirmation). — only the
// RUNNING gateway's own attestation proves what the process loaded.
// Missing, stale (heartbeat is hourly; 2h = dead), wrong-profile,
// wrong-account and fingerprint-mismatched records each fail.
let attestation: Parameters<typeof auditRuntimeAttestation>[0] = null;
try {
    attestation = JSON.parse(readFileSync(join(dataDir, 'runtime-attestation.json'), 'utf-8')) as NonNullable<Parameters<typeof auditRuntimeAttestation>[0]>;
} catch { attestation = null; }
// Review-32: a fresh FILE is not a running PROCESS — probe the attested
// PID (signal 0: ESRCH = gone; EPERM = alive but ours to not touch).
let pidAlive: boolean | null = null;
if (attestation !== null && typeof attestation.pid === 'number') {
    try { process.kill(attestation.pid, 0); pidAlive = true; }
    catch (err) { pidAlive = (err as NodeJS.ErrnoException).code === 'EPERM' ? true : false; }
}
const attProblems = auditRuntimeAttestation(attestation, {
    maxDailyLossPct: LIVE_DAILY_LOSS_PCT,
    maxRiskPerTradePct: LIVE_RISK_PER_TRADE_PCT,
    currentFp,
    nowMs: Date.now(),
    // 3× the 15-min heartbeat: a dead gateway is caught within ~45 min.
    maxAgeMs: 45 * 60_000,
    pidAlive,
});
if (attProblems.length === 0 && attestation !== null) {
    console.log(`runtime attestation: live profile on paper account CONFIRMED by the running gateway (fingerprint ${attestation.strategyFingerprint}, ${Math.round((Date.now() - (attestation.at ?? 0)) / 60_000)} min old)`);
}
for (const p of attProblems) verdictFails.push(p);

// Review-18: the DB-level one-thesis guarantee is real only when its
// partial unique index actually exists — migration deliberately survives
// a legacy DB with duplicates (loudly), so the evaluator must check.
try {
    const idx = db.query<{ name: string }>(`PRAGMA index_list('proposals')`).all();
    if (!idx.some((i) => i.name === 'ux_one_working_thesis')) {
        console.log('one-thesis index: ABSENT (FAIL — the DB pre-dates the migration (restart the gateway), or duplicate working rows blocked creation (resolve them); the DB-level accept exclusion is unproven either way)');
        verdictFails.push('one-thesis unique index absent — restart the gateway to migrate, or resolve duplicate executing/executed rows');
    } else {
        console.log('one-thesis index: present (DB-enforced single working thesis per symbol)');
    }
} catch (err) {
    console.log(`one-thesis index: UNVERIFIABLE (${err instanceof Error ? err.message : err})`);
    verdictFails.push('one-thesis unique index unverifiable');
}

// Review-20: the frozen behavior must be RECONSTRUCTIBLE from the tag.
// A checkout whose runtime files differ from HEAD ran behavior no tag
// can reproduce; unresolvable identity proves nothing. (Identity-
// irrelevant untracked noise — .claude/, docs — does not dirty it.)
try {
    const { codeIdentity } = await import('../src/services/strategy-fingerprint.js');
    const code = await codeIdentity();
    if (code === null) {
        console.log('code identity: UNRESOLVABLE (git unavailable, or unprovable untracked runtime content) — FAIL');
        verdictFails.push('code identity unresolvable');
    } else if (code.includes('+dirty.')) {
        console.log(`code identity: ${code} (FAIL — runtime files differ from HEAD; the tag cannot reconstruct this behavior)`);
        verdictFails.push('checkout dirty (runtime files) — commit or revert before evaluating');
    } else {
        console.log(`code identity: ${code} (clean checkout)`);
    }
} catch (err) {
    console.log(`code identity: UNVERIFIABLE (${err instanceof Error ? err.message : err})`);
    verdictFails.push('code identity unverifiable');
}

// One unambiguous line (round-4 review: the criteria were printed but
// never combined). Anomalies make the sample NOT-EVALUABLE, never PASS.
if (anomalies.length > 0) {
    console.log(`\nVERDICT: NOT EVALUABLE — resolve integrity anomalies first (${anomalies.join('; ')})\n`);
} else if (verdictFails.length === 0) {
    console.log('\nVERDICT: PASS — every protocol criterion holds on a clean sample. Record this run in the validation journal with the git SHA.\n');
} else {
    console.log(`\nVERDICT: FAIL — ${verdictFails.join('; ')}\n`);
}
db.close();
