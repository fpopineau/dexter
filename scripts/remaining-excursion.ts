/**
 * Remaining-excursion evidence (REQ-LANE-009; audit 2026-09-05, AUD-02).
 *
 * A target should reflect the favourable excursion still AVAILABLE after an
 * executable entry, not the day's whole ATR. This read-only script
 * tabulates, from the closed ledger, the post-entry MFE / MAE (% of the fill,
 * measured by the outcome tracker over the held window) by entry hour (ET),
 * risk class and lane, plus the share of trades whose MFE reached +3 %. It
 * produces evidence for a time-remaining rule; it changes nothing.
 *
 *   bun run scripts/remaining-excursion.ts [--since 2026-08-26]
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

const dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
const sinceIdx = process.argv.indexOf('--since');
const sinceMs = sinceIdx >= 0 && process.argv[sinceIdx + 1] ? Date.parse(process.argv[sinceIdx + 1]) : 0;

interface Row {
    id: string; symbol: string; trade_class: string | null; strategy_id: string | null; source: string;
    entry_filled_at: number | null; closed_at: number | null; entry_fill_price: number | null;
    mfe_pct: number | null; mae_pct: number | null; realized_pnl: number | null; commissions: number | null;
    minutes_since_open: number | null; exit_reason: string | null;
}

const db = new Database(join(dataDir, 'proposals.db'), { readonly: true });
// The lane column arrives with the WP5 migration (first gateway boot on that
// build); a ledger written by an older build reads every row as legacy.
const columns = new Set(db.query<{ name: string }, []>('PRAGMA table_info(proposals)').all().map((c) => c.name));
const laneCol = columns.has('strategy_id') ? 'strategy_id' : 'NULL AS strategy_id';
const rows = db.query<Row, [number]>(
    `SELECT id, symbol, trade_class, ${laneCol}, source, entry_filled_at, closed_at, entry_fill_price, mfe_pct, mae_pct,
            realized_pnl, commissions, minutes_since_open, exit_reason
     FROM proposals
     WHERE status = 'closed' AND entry_fill_price IS NOT NULL AND mfe_pct IS NOT NULL AND created_at >= ?
       AND source NOT IN ('adopted', 'test', 'smoke') AND (exit_reason IS NULL OR exit_reason != 'cancelled')`,
).all(sinceMs);
db.close();

function etHour(ms: number | null): string {
    if (ms === null) return 'unknown';
    const h = Number(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
    if (h < 10) return '09:30-10';
    if (h >= 15) return '15-16';
    return `${String(h).padStart(2, '0')}-${String(h + 1).padStart(2, '0')}`;
}

interface Cell { n: number; mfe: number[]; mae: number[]; hit3: number; netUsd: number }
const cells = new Map<string, Cell>();
const add = (key: string, r: Row) => {
    const c = cells.get(key) ?? { n: 0, mfe: [], mae: [], hit3: 0, netUsd: 0 };
    c.n++;
    c.mfe.push(r.mfe_pct ?? 0);
    c.mae.push(r.mae_pct ?? 0);
    if ((r.mfe_pct ?? 0) >= 3) c.hit3++;
    c.netUsd += (r.realized_pnl ?? 0) - (r.commissions ?? 0);
    cells.set(key, c);
};
for (const r of rows) {
    add(`hour|${etHour(r.entry_filled_at)}`, r);
    add(`class|${r.trade_class ?? 'unclassed'}`, r);
    add(`lane|${r.strategy_id ?? 'legacy'}`, r);
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

console.log(`\n=== REMAINING EXCURSION — ${rows.length} closed, filled rows with MFE${sinceMs ? ` since ${new Date(sinceMs).toISOString().slice(0, 10)}` : ''} (read-only) ===`);
console.log('MFE/MAE are % of the entry fill over the held window (tracker, bar resolution). "hit +3%" = MFE ≥ 3%.');
for (const group of ['hour', 'class', 'lane']) {
    console.log(`\n--- by ${group === 'hour' ? 'entry hour (ET)' : group} ---`);
    console.log('bucket           |   n | MFE mean | MFE med | MAE mean | hit +3% | net USD');
    const keys = [...cells.keys()].filter((k) => k.startsWith(`${group}|`)).sort();
    for (const k of keys) {
        const c = cells.get(k)!;
        console.log(`${k.slice(group.length + 1).padEnd(16)} | ${String(c.n).padStart(3)} | ${mean(c.mfe).toFixed(2).padStart(8)} | ${median(c.mfe).toFixed(2).padStart(7)} | ${mean(c.mae).toFixed(2).padStart(8)} | ${`${((100 * c.hit3) / c.n).toFixed(0)}%`.padStart(7)} | ${c.netUsd.toFixed(2).padStart(9)}`);
    }
}
console.log('\nReading: a time-remaining target rule would set x by the MFE distribution of the entry hour, not by the day ATR. This is evidence, not a rule (REQ-LANE-009).\n');
