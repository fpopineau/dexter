/**
 * Mark the legacy unknown-outcome rows (audit 2026-09-05 §5.3, operator
 * decision "mark legacy").
 *
 * 17 `agent`-sourced rows closed between 2026-07-14 and 2026-08-06 have an
 * entry fill but no realized P&L (pre-tracker era). They predate every
 * epoch and never enter a look; they are NOT statistically neutral for the
 * legacy scorecard, so the decision is to label them honestly rather than
 * reconstruct outcomes. The note tag is appended, never replaces.
 *
 *   bun run scripts/ops/mark-legacy-unknown.ts            # dry run: list
 *   bun run scripts/ops/mark-legacy-unknown.ts --apply    # write the tag
 *
 * Bounded by construction: status closed, entry filled, realized NULL,
 * not cancelled, source 'agent', created before the 2026-08-26 epoch, not
 * already tagged. Idempotent.
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

const dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
const apply = process.argv.includes('--apply');
const CUTOFF_MS = Date.UTC(2026, 7, 26); // the 2026-08-26 performance epoch
const TAG = 'legacy/unreconciled: outcome unknown — pre-epoch row, never enters a look (operator decision 2026-09-05, AUDIT-2026-09-05.md §5.3)';

interface Row { id: string; symbol: string; source: string; created_at: number; closed_at: number | null; note: string | null }

// bun:sqlite builds its open flags from the options given: `{ readonly:
// false }` yields NO flag (SQLITE_MISUSE) — name the mode explicitly.
const db = new Database(join(dataDir, 'proposals.db'), apply ? { readwrite: true } : { readonly: true });
db.run('PRAGMA busy_timeout = 5000');
const rows = db.query<Row, [number]>(
    `SELECT id, symbol, source, created_at, closed_at, note FROM proposals
     WHERE status = 'closed' AND entry_fill_price IS NOT NULL AND realized_pnl IS NULL
       AND (exit_reason IS NULL OR exit_reason != 'cancelled')
       AND source = 'agent' AND created_at < ?
       AND (note IS NULL OR note NOT LIKE '%legacy/unreconciled%')
     ORDER BY created_at`,
).all(CUTOFF_MS);

console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${rows.length} legacy unknown-outcome row(s) in ${dataDir}`);
for (const r of rows) {
    console.log(`  ${r.id} ${r.symbol.padEnd(6)} created ${new Date(r.created_at).toISOString().slice(0, 10)} closed ${r.closed_at ? new Date(r.closed_at).toISOString().slice(0, 10) : '—'}${r.note ? ` note: ${r.note.slice(0, 60)}` : ''}`);
}
if (apply && rows.length > 0) {
    const upd = db.query<void, [string, string, number, string]>(
        `UPDATE proposals SET note = CASE WHEN note IS NULL OR note = '' THEN ? ELSE note || ' | ' || ? END, updated_at = ? WHERE id = ?`,
    );
    const now = Date.now();
    db.run('BEGIN');
    try {
        for (const r of rows) upd.run(TAG, TAG, now, r.id);
        db.run('COMMIT');
    } catch (err) {
        db.run('ROLLBACK');
        throw err;
    }
    console.log(`tagged ${rows.length} row(s).`);
} else if (!apply) {
    console.log('no changes written (pass --apply).');
}
db.close();
