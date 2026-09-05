/**
 * Overnight benchmark table (REQ-BENCH-005, WP7) — read-only.
 *
 * Prints one capture day's overnight universe from candidate-archive.db:
 * rank, symbol, direction, capture price, mechanical levels, eligibility
 * reasons, what the system did with it (proposed / refused / not admitted),
 * and the mechanical twin's outcome (gap, fill, exit, R). Then the same
 * common-perimeter summary the nightly WhatsApp line carries.
 *
 *   bun run scripts/overnight-benchmark.ts [--day 2026-09-10] [--lane cup-and-handle]
 *
 * Without --day: the most recent capture day. Changes nothing.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_RULES } from '../src/tools/ibkr/risk-rules.js';
import type { CandidateRow } from '../src/services/candidate-archive.js';
import { formatOvernightReport } from '../src/services/overnight-benchmark.js';

const dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
const arg = (flag: string): string | null => { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null; };
const lane = arg('--lane') ?? 'overnight';

const dbPath = join(dataDir, 'candidate-archive.db');
if (!existsSync(dbPath)) { console.log(`no candidate archive yet at ${dbPath} — the first 15:35 ET capture creates it`); process.exit(0); }
const db = new Database(dbPath, { readonly: true });
const day = arg('--day') ?? db.query<{ day: string }, [string]>('SELECT MAX(day) AS day FROM candidates WHERE lane = ?').get(lane)?.day ?? null;
if (!day) { console.log(`no ${lane} captures archived yet`); process.exit(0); }

interface R {
    id: number; day: string; lane: string; symbol: string; direction: string; captured_at: number; source: string; rank: number | null; ranker_version: string | null; price: number;
    daily_atr: number | null; day_move_pct: number | null; eligible: number; reasons: string; levels_version: string; entry_type: string; entry: number | null;
    entry_limit: number | null; stop: number | null; target: number | null; exit_deadline: number | null; detector_version: string | null; state: string | null;
    disposition: string; disposition_ref: string | null; replay_status: string; bar_source: string | null; fill_at: number | null; fill_price: number | null;
    exit_at: number | null; exit_price: number | null; outcome: string | null; gap_pct: number | null; quantity: number | null; commissions: number | null;
    net_usd: number | null; net_r: number | null; mfe_pct: number | null; mae_pct: number | null; replayed_at: number | null; note: string | null;
}
const raw = db.query<R, [string, string]>('SELECT * FROM candidates WHERE day = ? AND lane = ? ORDER BY rank DESC, symbol').all(day, lane);
db.close();

const rows: CandidateRow[] = raw.map((r) => ({
    id: r.id, day: r.day, lane: r.lane === 'cup-and-handle' ? 'cup-and-handle' : 'overnight', symbol: r.symbol, direction: r.direction === 'short' ? 'short' : 'long',
    capturedAt: r.captured_at, source: r.source, rank: r.rank, rankerVersion: r.ranker_version ?? null, price: r.price, dailyAtr: r.daily_atr, dayMovePct: r.day_move_pct, eligible: r.eligible === 1,
    reasons: JSON.parse(r.reasons) as string[], levelsVersion: r.levels_version, entryType: r.entry_type === 'STP_LMT' ? 'STP_LMT' : 'MKT', entry: r.entry,
    entryLimit: r.entry_limit, stop: r.stop, target: r.target, exitDeadline: r.exit_deadline, detectorVersion: r.detector_version, state: r.state,
    disposition: r.disposition as CandidateRow['disposition'], dispositionRef: r.disposition_ref, replayStatus: r.replay_status as CandidateRow['replayStatus'],
    barSource: r.bar_source, fillAt: r.fill_at, fillPrice: r.fill_price, exitAt: r.exit_at, exitPrice: r.exit_price, outcome: r.outcome, gapPct: r.gap_pct,
    quantity: r.quantity, commissions: r.commissions, netUsd: r.net_usd, netR: r.net_r, mfePct: r.mfe_pct, maePct: r.mae_pct, replayedAt: r.replayed_at, note: r.note,
}));

const f = (x: number | null, d = 2) => (x === null ? '—' : x.toFixed(d));
const pad = (s: string, n: number) => s.padEnd(n);
console.log(`${lane} universe captured ${day} (${rows.length} rows, levels ${rows[0]?.levelsVersion ?? '—'})\n`);
console.log(pad('rank', 5) + pad('symbol', 7) + pad('dir', 6) + pad('price', 9) + pad('stop', 9) + pad('target', 9) + pad('elig', 5) + pad('disposition', 22) + pad('outcome', 10) + pad('gap%', 7) + pad('fill', 9) + pad('exit', 9) + pad('R', 7) + 'reasons / note');
for (const r of rows) {
    console.log(
        pad(f(r.rank, 0), 5) + pad(r.symbol, 7) + pad(r.direction, 6) + pad(f(r.price), 9) + pad(f(r.stop), 9) + pad(f(r.target), 9) + pad(r.eligible ? 'yes' : 'no', 5) +
        pad(`${r.disposition}${r.dispositionRef ? `:${r.dispositionRef}` : ''}`, 22) + pad(r.outcome ?? r.replayStatus, 10) + pad(f(r.gapPct, 1), 7) +
        pad(f(r.fillPrice), 9) + pad(f(r.exitPrice), 9) + pad(f(r.netR), 7) + [...r.reasons, ...(r.note ? [r.note] : [])].join('; '),
    );
}
if (lane === 'overnight') console.log('\n' + formatOvernightReport(day, rows, DEFAULT_RULES));
