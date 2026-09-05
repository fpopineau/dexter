/**
 * Lane-ranker chronological validation (REQ-DISC-005, WP8; audit AUD-08).
 *
 * "Scores are comparable only inside a cohort; weight provenance visible;
 * chronological validation independent of weight selection." This
 * read-only script is that pass. Per lane it gathers every ranked outcome
 * the system has —
 *   ledger   closed proposals carrying a lane rank (proposals.db)
 *   archive  the overnight candidate twins the WP7 benchmark settled
 *            (candidate-archive.db), the universe the judgment picked from
 * — orders the rows by day, splits the DAYS chronologically (first 60 %
 * selection, last 40 % validation), and reports on EACH half: n, Spearman
 * rank→R, and the top-tercile-by-rank mean R against the rest. Nothing is
 * fitted here, so the validation half is untouched by any weight choice;
 * a ranker earns a reweighting only when the validation half agrees with
 * the selection half. Under 20 rows per half the verdict is "insufficient".
 *
 *   bun run scripts/validate-lane-ranker.ts [--since 2026-09-08]
 */

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RANKER_VERSIONS } from '../src/services/lane-rankers.js';
import { spearman } from '../src/utils/sequential-test.js';

const dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
const sinceIdx = process.argv.indexOf('--since');
const sinceMs = sinceIdx >= 0 && process.argv[sinceIdx + 1] ? Date.parse(process.argv[sinceIdx + 1]) : 0;
const MIN_PER_HALF = 20;

interface Obs { day: string; rank: number; netR: number; version: string | null }

function etDay(ms: number): string {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// --- ledger ---------------------------------------------------------------
const byLane = new Map<string, Obs[]>();
const push = (lane: string, o: Obs) => { const arr = byLane.get(lane) ?? []; arr.push(o); byLane.set(lane, arr); };

const proposalsPath = join(dataDir, 'proposals.db');
if (existsSync(proposalsPath)) {
    const db = new Database(proposalsPath, { readonly: true });
    const columns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(proposals)').all().map((c) => c.name));
    if (columns.has('lane_rank')) {
        interface R { strategy_id: string | null; lane_rank: number | null; ranker_version: string | null; realized_pnl: number | null; commissions: number | null; entry_fill_price: number | null; stop: number; quantity: number; closed_at: number | null; created_at: number }
        const rows = db.query<R, [number]>(
            `SELECT strategy_id, lane_rank, ranker_version, realized_pnl, commissions, entry_fill_price, stop, quantity, closed_at, created_at
             FROM proposals WHERE status = 'closed' AND lane_rank IS NOT NULL AND entry_fill_price IS NOT NULL AND realized_pnl IS NOT NULL
               AND created_at >= ? AND source NOT IN ('adopted', 'test', 'smoke') AND (exit_reason IS NULL OR exit_reason != 'cancelled')`,
        ).all(sinceMs);
        for (const r of rows) {
            const risk = Math.abs((r.entry_fill_price as number) - r.stop) * r.quantity;
            if (!(risk > 0)) continue;
            const netR = ((r.realized_pnl as number) - (r.commissions ?? 0)) / risk;
            push(`${r.strategy_id ?? 'legacy'} (ledger)`, { day: etDay(r.closed_at ?? r.created_at), rank: r.lane_rank as number, netR, version: r.ranker_version });
        }
    } else {
        console.log('proposals.db has no lane_rank column yet (WP8 migration runs at the next gateway boot)');
    }
    db.close();
}

// --- candidate archive (overnight twins) -----------------------------------
const archivePath = join(dataDir, 'candidate-archive.db');
if (existsSync(archivePath)) {
    const db = new Database(archivePath, { readonly: true });
    interface C { day: string; rank: number | null; ranker_version: string | null; net_r: number | null }
    const rows = db.query<C, []>(
        `SELECT day, rank, ranker_version, net_r FROM candidates WHERE lane = 'overnight' AND eligible = 1 AND replay_status = 'settled' AND net_r IS NOT NULL AND rank IS NOT NULL`,
    ).all();
    for (const r of rows) push('overnight (archive twins)', { day: r.day, rank: r.rank as number, netR: r.net_r as number, version: r.ranker_version });
    db.close();
}

// --- provenance -------------------------------------------------------------
let weightsSource = 'defaults (no scorer-weights.json)';
try {
    const w = JSON.parse(readFileSync(join(dataDir, 'scorer-weights.json'), 'utf-8')) as Record<string, unknown>;
    weightsSource = `scorer-weights.json ${JSON.stringify(w)}`;
} catch { /* defaults */ }
console.log(`ranker versions: ${Object.entries(RANKER_VERSIONS).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`intraday composite weight provenance: ${weightsSource}\n`);

// --- per-lane chronological split ------------------------------------------
function half(obs: Obs[]): string {
    if (obs.length < MIN_PER_HALF) return `n ${obs.length} — insufficient (< ${MIN_PER_HALF})`;
    const s = spearman(obs.map((o) => [o.rank, o.netR] as [number, number]));
    const sorted = [...obs].sort((a, b) => b.rank - a.rank);
    const k = Math.max(1, Math.floor(sorted.length / 3));
    const top = sorted.slice(0, k);
    const rest = sorted.slice(k);
    const mean = (xs: Obs[]) => (xs.length ? xs.reduce((a, o) => a + o.netR, 0) / xs.length : NaN);
    const versions = [...new Set(obs.map((o) => o.version ?? '?'))].join('/');
    return `n ${obs.length} (${versions}) rho ${s ? s.rho.toFixed(3) : '—'} p ${s ? s.p.toFixed(3) : '—'} · top-tercile meanR ${mean(top).toFixed(3)} vs rest ${mean(rest).toFixed(3)}`;
}

if (byLane.size === 0) console.log('no ranked outcomes yet — the ledger and the archive fill after the first epoch days');
for (const [lane, obs] of [...byLane.entries()].sort()) {
    const days = [...new Set(obs.map((o) => o.day))].sort();
    const cut = Math.floor(days.length * 0.6);
    const selDays = new Set(days.slice(0, cut));
    const sel = obs.filter((o) => selDays.has(o.day));
    const val = obs.filter((o) => !selDays.has(o.day));
    console.log(`${lane}: ${obs.length} rows over ${days.length} days (split at ${days[cut] ?? '—'})`);
    console.log(`  selection  ${half(sel)}`);
    console.log(`  validation ${half(val)}`);
}
console.log('\nA reweighting is earned only when the validation half agrees with the selection half; nothing here writes.');
