/**
 * Lane-ranker chronological validation (REQ-DISC-005, WP8; audit AUD-08;
 * review 2026-09-06 findings 11–12).
 *
 * "Scores are comparable only inside a cohort; weight provenance visible;
 * chronological validation independent of weight selection." This
 * read-only script is that pass, with a PRE-REGISTERED verdict:
 *
 *   cohort   one per (lane, ranker version, source) — versions and sources
 *            are never mixed:
 *              ledger   closed proposals carrying a lane rank (proposals.db),
 *                       R = (realized − commissions) / (|fill − stop| × qty);
 *                       a row without commissions is INCOMPLETE and excluded
 *                       (as the epoch evaluator treats it), never a zero
 *              archive  the overnight candidate twins the WP7 benchmark
 *                       settled (candidate-archive.db), label = gross R (the
 *                       size-invariant one)
 *   day      the DECISION day (creation day for the ledger, capture day for
 *            the archive) — never the close day
 *   split    a PINNED calendar date: `--split YYYY-MM-DD`, or the date frozen
 *            once with `--freeze-split YYYY-MM-DD` into
 *            <data>/lane-ranker-split.json (refuses to overwrite). Days
 *            before the split are the SELECTION half, days from the split on
 *            the VALIDATION half. Without a pinned split the script prints
 *            the statistics and says UNPINNED — no verdict, because a
 *            boundary that moves with the data is not a holdout.
 *   verdict  PASS when the validation half has n ≥ 20, Spearman rho ≥ 0.15
 *            with p ≤ 0.05 and a top-tercile lift ≥ 0.10 R over the rest,
 *            AND the selection half agrees in sign on both; FAIL when the
 *            validation half is large enough and misses any criterion;
 *            INSUFFICIENT under n < 20 in either half.
 *
 * A reweighting is earned only by a PASS on a pinned split; this script
 * never writes anything but the frozen split file on explicit request.
 *
 *   bun run scripts/validate-lane-ranker.ts [--since 2026-09-08] [--split 2026-10-01 | --freeze-split 2026-10-01]
 */

import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RANKER_VERSIONS } from '../src/services/lane-rankers.js';
import { spearman } from '../src/utils/sequential-test.js';

const dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
const arg = (flag: string): string | null => { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null; };
const sinceArg = arg('--since');
const sinceMs = sinceArg ? Date.parse(sinceArg) : 0;
const sinceDay = sinceArg ?? '0000-00-00';

/** Pre-registered pass criteria (REQ-DISC-005). Change = a new pre-registration, recorded in SPEC. */
export const PASS_CRITERIA = { minPerHalf: 20, minRho: 0.15, maxP: 0.05, minTercileLiftR: 0.10 } as const;

// --- the pinned split ----------------------------------------------------------
const splitFile = join(dataDir, 'lane-ranker-split.json');
let split: string | null = arg('--split');
const freeze = arg('--freeze-split');
if (freeze) {
    if (existsSync(splitFile)) { console.log(`split already frozen in ${splitFile} — refusing to move it`); process.exit(1); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(freeze)) { console.log('--freeze-split needs YYYY-MM-DD'); process.exit(1); }
    writeFileSync(splitFile, JSON.stringify({ split: freeze, frozenAt: new Date().toISOString() }, null, 2));
    console.log(`split frozen at ${freeze} (${splitFile})`);
    split = freeze;
}
if (!split && existsSync(splitFile)) {
    try { split = (JSON.parse(readFileSync(splitFile, 'utf-8')) as { split: string }).split; } catch { split = null; }
}

interface Obs { day: string; rank: number; r: number }
const cohorts = new Map<string, Obs[]>();
const push = (key: string, o: Obs) => { const arr = cohorts.get(key) ?? []; arr.push(o); cohorts.set(key, arr); };

function etDay(ms: number): string {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// --- ledger: one cohort per (lane, ranker version) ------------------------------
const proposalsPath = join(dataDir, 'proposals.db');
let excludedNoCommissions = 0;
if (existsSync(proposalsPath)) {
    const db = new Database(proposalsPath, { readonly: true });
    const columns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(proposals)').all().map((c) => c.name));
    if (columns.has('lane_rank')) {
        interface R { strategy_id: string | null; lane_rank: number | null; ranker_version: string | null; realized_pnl: number | null; commissions: number | null; entry_fill_price: number | null; stop: number; quantity: number; created_at: number }
        const rows = db.query<R, [number]>(
            `SELECT strategy_id, lane_rank, ranker_version, realized_pnl, commissions, entry_fill_price, stop, quantity, created_at
             FROM proposals WHERE status = 'closed' AND lane_rank IS NOT NULL AND entry_fill_price IS NOT NULL AND realized_pnl IS NOT NULL
               AND created_at >= ? AND source NOT IN ('adopted', 'test', 'smoke') AND (exit_reason IS NULL OR exit_reason != 'cancelled')`,
        ).all(sinceMs);
        for (const r of rows) {
            if (r.commissions === null) { excludedNoCommissions++; continue; } // incomplete, never a zero
            const risk = Math.abs((r.entry_fill_price as number) - r.stop) * r.quantity;
            if (!(risk > 0)) continue;
            push(`${r.strategy_id ?? 'legacy'} · ${r.ranker_version ?? 'unversioned'} · ledger (net R)`, {
                day: etDay(r.created_at), rank: r.lane_rank as number, r: ((r.realized_pnl as number) - r.commissions) / risk,
            });
        }
    } else {
        console.log('proposals.db has no lane_rank column yet (WP8 migration runs at the next gateway boot)');
    }
    db.close();
}

// --- archive: overnight twins, one cohort per ranker version, label = gross R ----
const archivePath = join(dataDir, 'candidate-archive.db');
if (existsSync(archivePath)) {
    const db = new Database(archivePath, { readonly: true });
    const columns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(candidates)').all().map((c) => c.name));
    if (columns.has('gross_r')) {
        interface C { day: string; rank: number | null; ranker_version: string | null; gross_r: number | null }
        const rows = db.query<C, [string]>(
            `SELECT day, rank, ranker_version, gross_r FROM candidates
             WHERE lane = 'overnight' AND eligible = 1 AND replay_status = 'settled' AND gross_r IS NOT NULL AND rank IS NOT NULL AND day >= ?`,
        ).all(sinceDay);
        for (const r of rows) push(`overnight · ${r.ranker_version ?? 'unversioned'} · archive twins (gross R)`, { day: r.day, rank: r.rank as number, r: r.gross_r as number });
    }
    db.close();
}

// --- provenance -------------------------------------------------------------------
let weightsSource = 'defaults (no scorer-weights.json)';
try {
    const w = JSON.parse(readFileSync(join(dataDir, 'scorer-weights.json'), 'utf-8')) as Record<string, unknown>;
    weightsSource = `scorer-weights.json ${JSON.stringify(w)}`;
} catch { /* defaults */ }
console.log(`ranker versions: ${Object.entries(RANKER_VERSIONS).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`intraday composite weight provenance: ${weightsSource}`);
console.log(`pass criteria: n ≥ ${PASS_CRITERIA.minPerHalf} per half, rho ≥ ${PASS_CRITERIA.minRho} with p ≤ ${PASS_CRITERIA.maxP}, top-tercile lift ≥ ${PASS_CRITERIA.minTercileLiftR} R, selection half agrees in sign`);
console.log(split ? `split pinned at ${split} (selection < split ≤ validation)` : 'split UNPINNED — descriptive statistics only, no verdict (pin with --split or --freeze-split)');
if (excludedNoCommissions) console.log(`${excludedNoCommissions} closed row(s) without commissions excluded (incomplete, not zero)`);
console.log('');

// --- per-cohort halves ------------------------------------------------------------
interface HalfStats { n: number; rho: number | null; p: number | null; lift: number | null }
function halfStats(obs: Obs[]): HalfStats {
    if (obs.length === 0) return { n: 0, rho: null, p: null, lift: null };
    const s = spearman(obs.map((o) => [o.rank, o.r] as [number, number]));
    const sorted = [...obs].sort((a, b) => b.rank - a.rank);
    const k = Math.max(1, Math.floor(sorted.length / 3));
    const mean = (xs: Obs[]) => (xs.length ? xs.reduce((a, o) => a + o.r, 0) / xs.length : NaN);
    const lift = sorted.length > k ? mean(sorted.slice(0, k)) - mean(sorted.slice(k)) : null;
    return { n: obs.length, rho: s?.rho ?? null, p: s?.p ?? null, lift: lift !== null && Number.isFinite(lift) ? lift : null };
}
function verdict(sel: HalfStats, val: HalfStats): string {
    if (!split) return 'UNPINNED';
    if (sel.n < PASS_CRITERIA.minPerHalf || val.n < PASS_CRITERIA.minPerHalf) return `INSUFFICIENT (need ${PASS_CRITERIA.minPerHalf} per half)`;
    const valOk = val.rho !== null && val.p !== null && val.lift !== null && val.rho >= PASS_CRITERIA.minRho && val.p <= PASS_CRITERIA.maxP && val.lift >= PASS_CRITERIA.minTercileLiftR;
    const selAgrees = sel.rho !== null && sel.lift !== null && sel.rho > 0 && sel.lift > 0;
    return valOk && selAgrees ? 'PASS' : `FAIL (${[!valOk ? 'validation criteria not met' : null, !selAgrees ? 'selection half disagrees' : null].filter(Boolean).join('; ')})`;
}
const f = (x: number | null, d = 3) => (x === null ? '—' : x.toFixed(d));
const fmt = (h: HalfStats) => `n ${h.n} rho ${f(h.rho)} p ${f(h.p)} top-tercile lift ${f(h.lift)} R`;

if (cohorts.size === 0) console.log('no ranked outcomes yet — the ledger and the archive fill after the first epoch days');
for (const [key, obs] of [...cohorts.entries()].sort()) {
    const days = [...new Set(obs.map((o) => o.day))].sort();
    const sel = split ? obs.filter((o) => o.day < split!) : obs;
    const val = split ? obs.filter((o) => o.day >= split!) : [];
    const s = halfStats(sel);
    const v = halfStats(val);
    console.log(`${key}: ${obs.length} rows over ${days.length} decision days (${days[0] ?? '—'} → ${days[days.length - 1] ?? '—'})`);
    console.log(`  ${split ? 'selection ' : 'all       '} ${fmt(s)}`);
    if (split) console.log(`  validation ${fmt(v)}`);
    console.log(`  verdict    ${verdict(s, v)}`);
}
console.log('\nA reweighting is earned only by a PASS on a pinned split; nothing here writes except --freeze-split.');
