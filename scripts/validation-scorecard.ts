/**
 * Frozen-sample scorecard — THE evaluator VALIDATION-PROTOCOL.md names
 * (review 2026-08-21: the protocol advertised a weekly scorecard that did
 * not exist). Read-only over proposals.db. Run weekly during the sample
 * and once at completion; the definitions HERE are the protocol's
 * machine-readable form — changing them mid-sample ends the window.
 *
 *   bun run scripts/validation-scorecard.ts               # since baseline
 *   bun run scripts/validation-scorecard.ts 2026-08-25    # since a date (freeze tag day)
 *
 * Definitions (pinned):
 *   - Sample row: status='closed', entry filled, realized_pnl NOT NULL,
 *     exit_reason != 'cancelled', source != 'adopted', note free of the
 *     untrustworthy marker ('NOT trustworthy').
 *   - Net P&L: realized_pnl − commissions.
 *   - Profit factor: Σ net wins ÷ |Σ net losses|.
 *   - Drawdown: worst peak-to-trough of the cumulative-net-P&L series in
 *     close order, as % of the PAPER baseline NetLiq (1,000,000), scaled
 *     by (live max_risk_per_trade_pct ÷ paper max_risk_per_trade_pct);
 *     PASS bar: ≤ 2 × live max_daily_loss_pct.
 *   - Score deciles: trades bucketed by score into 10 equal-width bins
 *     0–100; Spearman rank correlation computed over PER-TRADE
 *     (score, net P&L) pairs; monotonicity claim needs rho > 0 AND
 *     p < 0.05 (t-approximation).
 *   - Top/bottom band: score ≥ 80th percentile vs ≤ 20th percentile of
 *     the SAMPLE's scores, each needing n ≥ 10 to be evaluable.
 *   - Judgment purity: exactly one distinct non-null `model` across the
 *     sample; regime breadth: ≥ 2 distinct non-null `regime` tags and
 *     ≥ 6 distinct ISO calendar weeks of closes.
 */

import 'dotenv/config';
import { join } from 'node:path';

const PAPER_BASELINE_NETLIQ = 1_000_000;
const UNTRUSTWORTHY = '%NOT trustworthy%';

interface Row {
    id: string; symbol: string; trade_class: string | null; source: string;
    score: number | null; model: string | null; regime: string | null;
    realized_pnl: number; commissions: number | null; closed_at: number;
}

async function openDb() {
    const dbPath = join(process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data'), 'proposals.db');
    const sqlite = await import('bun:sqlite');
    return new sqlite.Database(dbPath, { readonly: true });
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
const sinceArg = process.argv[2];
let sinceMs: number;
let windowLabel: string;
if (sinceArg && /^\d{4}-\d{2}-\d{2}$/.test(sinceArg)) {
    sinceMs = Date.parse(`${sinceArg}T00:00:00Z`);
    windowLabel = `since ${sinceArg} (explicit — use the freeze-tag date)`;
} else {
    try {
        const { readFileSync } = await import('node:fs');
        const p = join(process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data'), 'performance-epoch.json');
        const b = JSON.parse(readFileSync(p, 'utf-8')) as { epochMs: number; note?: string };
        sinceMs = b.epochMs;
        windowLabel = `since baseline ${new Date(b.epochMs).toISOString()}${b.note ? ` (${b.note})` : ''}`;
    } catch {
        sinceMs = 0;
        windowLabel = 'ALL HISTORY (no baseline found — pass a date)';
    }
}

const rows = db.query<Row, [number]>(`
    SELECT id, symbol, trade_class, source, score, model, regime,
           realized_pnl, commissions, closed_at
    FROM proposals
    WHERE status = 'closed' AND closed_at >= ?
      AND entry_fill_price IS NOT NULL AND realized_pnl IS NOT NULL
      AND (exit_reason IS NULL OR exit_reason != 'cancelled')
      AND source != 'adopted'
      AND (note IS NULL OR note NOT LIKE '${UNTRUSTWORTHY}')
    ORDER BY closed_at ASC
`).all(sinceMs);

const net = (r: Row) => r.realized_pnl - (r.commissions ?? 0);
const n = rows.length;
console.log(`\n=== VALIDATION SCORECARD — ${windowLabel} ===`);
console.log(`sample n = ${n} (protocol needs >= 100)`);
if (n === 0) {
    console.log('No sample rows yet.');
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

// Drawdown (protocol formula)
let equity = 0, peak = 0, maxDd = 0;
for (const v of nets) { equity += v; if (equity > peak) peak = equity; maxDd = Math.max(maxDd, peak - equity); }
const liveRisk = 1.0, paperRisk = 0.25, liveDailyLoss = 3.0; // risk-rules.live.yaml pins
const ddPct = (maxDd / PAPER_BASELINE_NETLIQ) * 100 * (liveRisk / paperRisk);
console.log(`max drawdown ${maxDd.toFixed(2)} → scaled ${ddPct.toFixed(2)}% of live equity (${ddPct <= 2 * liveDailyLoss ? 'PASS' : 'FAIL'} — must be <= ${2 * liveDailyLoss}%)`);

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
}

// Per-lane split (informational)
console.log('\nper-lane (informational):');
const byLane = new Map<string, number[]>();
for (const r of rows) (byLane.get(r.source) ?? byLane.set(r.source, []).get(r.source)!).push(net(r));
for (const [k, vs] of byLane) console.log(`  ${k}: n=${vs.length} net ${vs.reduce((s, v) => s + v, 0).toFixed(2)}`);

// Score deciles + Spearman (confidence-sizing gate)
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
const regimes = new Set(rows.map((r) => r.regime).filter((v): v is string => v !== null));
const weeks = new Set(rows.map((r) => {
    const d = new Date(r.closed_at);
    const y = d.getUTCFullYear();
    const onejan = Date.UTC(y, 0, 1);
    return `${y}-w${Math.ceil(((r.closed_at - onejan) / 86_400_000 + new Date(onejan).getUTCDay() + 1) / 7)}`;
}));
console.log(`\njudgment purity: models = [${[...models].join(', ')}] ${models.size === 1 && !models.has('NULL') ? 'PASS' : 'FAIL — sample must be single-model, no NULLs'}`);
console.log(`regime breadth: ${regimes.size} tag(s) [${[...regimes].join(', ')}] (${regimes.size >= 2 ? 'PASS' : 'FAIL'} — needs >= 2)`);
console.log(`calendar breadth: ${weeks.size} ISO week(s) (${weeks.size >= 6 ? 'PASS' : 'FAIL'} — needs >= 6)`);
console.log('');
db.close();
