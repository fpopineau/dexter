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
 *   - Drawdown: worst peak-to-trough of the cumulative-net-P&L series in
 *     close order, as % of the CAPTURED paper NetLiq baseline
 *     (netliq-baseline.json — round-4 review: the old hardcoded 1M was 4×
 *     the real paper account and understated drawdown 4×), scaled by
 *     (live max_risk_per_trade_pct ÷ paper max_risk_per_trade_pct);
 *     PASS bar: ≤ 2 × live max_daily_loss_pct.
 *   - Score deciles: trades bucketed by score into 10 equal-width bins
 *     0–100; Spearman rank correlation computed over PER-TRADE
 *     (score, net P&L) pairs; monotonicity claim needs rho > 0 AND
 *     p < 0.05 (t-approximation).
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const UNTRUSTWORTHY = '%NOT trustworthy%';
const dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');

interface Row {
    id: string; symbol: string; trade_class: string | null; source: string;
    score: number | null; model: string | null; regime: string | null;
    realized_pnl: number; commissions: number | null; closed_at: number;
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
if (sinceArg && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(sinceArg)) {
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

const rows = db.query<Row>(`
    SELECT id, symbol, trade_class, source, score, model, regime,
           realized_pnl, commissions, closed_at
    FROM proposals
    WHERE status = 'closed' AND created_at >= ? AND closed_at >= ?
      AND entry_fill_price IS NOT NULL AND realized_pnl IS NOT NULL
      AND (exit_reason IS NULL OR exit_reason != 'cancelled')
      AND source != 'adopted'
      AND (note IS NULL OR note NOT LIKE '${UNTRUSTWORTHY}')
    ORDER BY closed_at ASC
`).all(sinceMs, sinceMs);
// created_at >= window start (round-5 review): "never count pre-freeze
// rows" means rows PROPOSED under the frozen policy — a pre-freeze trade
// that merely closes inside the window was judged by the old policy.

const net = (r: Row) => r.realized_pnl - (r.commissions ?? 0);
const n = rows.length;
console.log(`\n=== VALIDATION SCORECARD — ${windowLabel} ===`);
console.log(`sample n = ${n} (protocol needs >= 100)`);
if (n < 100) verdictFails.push(`sample n=${n} < 100`);

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
        legAdoptions?: number; positionAdoptions?: number; resolvedAdoptions?: string[];
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
    const info: string[] = [];
    if ((rec.legAdoptions ?? 0) > 0) info.push(`${rec.legAdoptions} leg adoption(s) last sweep`);
    if ((rec.positionAdoptions ?? 0) > 0) info.push(`${rec.positionAdoptions} position adoption(s) last sweep`);
    if ((rec.resolvedAdoptions ?? []).length > 0) info.push(`resolved: ${rec.resolvedAdoptions!.join(', ')}`);
    reconLine = `reconciliation report: ${new Date(rec.at).toISOString()} — ${reconAnomalies.length === 0 ? 'clean' : reconAnomalies.join('; ')}` +
        (info.length > 0 ? ` [${info.join('; ')}]` : '');
} catch { /* reconLine already says MISSING */ }
console.log(reconLine);
const missingStamps = rows.filter((r) => r.model === null || r.regime === null || r.regime === 'unknown').length;
const anomalies: string[] = [];
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

// Drawdown (protocol formula)
let equity = 0, peak = 0, maxDd = 0;
for (const v of nets) { equity += v; if (equity > peak) peak = equity; maxDd = Math.max(maxDd, peak - equity); }
const liveRisk = 1.0, paperRisk = 0.25, liveDailyLoss = 3.0; // risk-rules.live.yaml pins
if (paperNetliq !== null) {
    const ddPct = (maxDd / paperNetliq) * 100 * (liveRisk / paperRisk);
    console.log(`max drawdown ${maxDd.toFixed(2)} on paper NetLiq ${paperNetliq.toFixed(0)} [${netliqSource}] → scaled ${ddPct.toFixed(2)}% of live equity (${ddPct <= 2 * liveDailyLoss ? 'PASS' : 'FAIL'} — must be <= ${2 * liveDailyLoss}%)`);
    if (netliqSource !== 'frozen at epoch') verdictFails.push('drawdown denominator not frozen (epoch has no netLiq)');
    if (ddPct > 2 * liveDailyLoss) verdictFails.push(`scaled drawdown ${ddPct.toFixed(2)}% > ${2 * liveDailyLoss}%`);
} else {
    console.log(`max drawdown ${maxDd.toFixed(2)} — NOT EVALUABLE: netliq-baseline.json missing/unreadable`);
    verdictFails.push('drawdown not evaluable (no netliq baseline)');
}

// Per-class discipline
console.log('\nper-class (each class with n>=10 must be net-positive alone):');
const byClass = new Map<string, Row[]>();
for (const r of rows) {
    const k = r.trade_class ?? 'intraday';
    (byClass.get(k) ?? byClass.set(k, []).get(k)!).push(r);
}
for (const [k, rs] of byClass) {
    const t = rs.reduce((s, r) => s + net(r), 0);
    const evaluable = rs.length >= 10;
    console.log(`  ${k}: n=${rs.length} net ${t.toFixed(2)} ${evaluable ? (t > 0 ? 'PASS' : 'FAIL') : '(below 10 — stays paper-only)'}`);
    if (evaluable && t <= 0) verdictFails.push(`class ${k} net ${t.toFixed(2)} <= 0 at n=${rs.length}`);
}

// Per-lane split (informational)
console.log('\nper-lane (informational):');
const byLane = new Map<string, number[]>();
for (const r of rows) (byLane.get(r.source) ?? byLane.set(r.source, []).get(r.source)!).push(net(r));
for (const [k, vs] of byLane) console.log(`  ${k}: n=${vs.length} net ${vs.reduce((s, v) => s + v, 0).toFixed(2)}`);

// Score deciles + Spearman (confidence-sizing gate — NOT part of the
// go-live verdict; it decides flat-vs-banded sizing separately).
const scored = rows.filter((r) => r.score !== null) as Array<Row & { score: number }>;
console.log(`\nscore deciles (scored n=${scored.length}):`);
for (let d = 0; d < 10; d++) {
    const lo = d * 10, hi = lo + 10;
    const rs = scored.filter((r) => r.score >= lo && (d === 9 ? r.score <= 100 : r.score < hi));
    if (rs.length) {
        const t = rs.reduce((s, r) => s + net(r), 0);
        console.log(`  ${lo}-${hi}: n=${rs.length} net ${t.toFixed(2)} mean ${(t / rs.length).toFixed(2)}`);
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
