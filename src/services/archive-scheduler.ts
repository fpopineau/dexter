/**
 * Archive scheduler — daily post-close data collection.
 *
 * At 16:20 ET on trading days, archives intraday bars for the day's
 * watched universe to the market-archive SQLite database
 * (DATA_ARCHIVE_PATH, default .dexter/data/market-archive.db):
 *
 *   universe = today's Opportunity Engine snapshot symbols
 *            ∪ symbols with proposals created today
 *            ∪ DATA_ARCHIVE_SYMBOLS (comma-separated env watchlist)
 *     capped at DATA_ARCHIVE_MAX_SYMBOLS (default 30, IBKR pacing)
 *
 *   passes  = 1-min bars × 1 day  (granular record of the session)
 *           + 5-min bars × 2 days (context window, catches late fixes)
 *
 * Every day this runs, the local training corpus grows — this is the data
 * the ML pipeline (signal-weight optimization, regime detection) trains on.
 * Deterministic, no LLM. Disable with DATA_ARCHIVE=false.
 */

import { logger } from '@/utils';
import { isMarketHoliday } from '@/utils/market-hours.js';
import { Cron } from 'croner';
import { archiveBars } from './data-archive.js';
import { getSnapshotSymbolsSince } from './opportunity-engine.js';
import { etDayStartMs, listProposalSymbolsSince } from './trade-proposals.js';

/** '20 16 * * 1-5' — 16:20 ET, after the close auction settles. */
const ARCHIVE_CRON = '20 16 * * 1-5';
const ET = 'America/New_York';

/** Gateway auto-start gate: on unless DATA_ARCHIVE=false. */
export function isArchiveSchedulerEnabled(): boolean {
    return (process.env.DATA_ARCHIVE ?? '').trim().toLowerCase() !== 'false';
}

function maxSymbols(): number {
    const n = Number(process.env.DATA_ARCHIVE_MAX_SYMBOLS);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 30;
}

function watchlistSymbols(): string[] {
    return (process.env.DATA_ARCHIVE_SYMBOLS ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
}

function etDateString(now = new Date()): string {
    const et = new Date(now.toLocaleString('en-US', { timeZone: ET }));
    return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

/**
 * Build today's archival universe. Watchlist symbols come first so a tight
 * cap never silently drops what the user explicitly asked to keep.
 */
export async function buildArchiveUniverse(): Promise<string[]> {
    const dayStart = etDayStartMs();
    const ordered: string[] = [...watchlistSymbols()];

    const [proposalSymbols, snapshotSymbols] = await Promise.all([
        listProposalSymbolsSince(dayStart).catch(() => [] as string[]),
        getSnapshotSymbolsSince(dayStart).catch(() => [] as string[]),
    ]);
    ordered.push(...proposalSymbols.map((s) => s.toUpperCase()));
    ordered.push(...snapshotSymbols.map((s) => s.toUpperCase()));

    const unique = [...new Set(ordered)];
    const cap = maxSymbols();
    if (unique.length > cap) {
        logger.warn(`[archive-scheduler] universe ${unique.length} symbols capped at ${cap} (DATA_ARCHIVE_MAX_SYMBOLS)`);
    }
    return unique.slice(0, cap);
}

/** One archival run. Exported for manual invocation and scripts. */
export async function runArchiveOnce(): Promise<void> {
    const today = etDateString();
    if (isMarketHoliday(today)) {
        logger.info(`[archive-scheduler] ${today} is a market holiday — skipping`);
        return;
    }
    const symbols = await buildArchiveUniverse();
    if (symbols.length === 0) {
        logger.info('[archive-scheduler] empty universe today — nothing to archive');
        return;
    }
    logger.info(`[archive-scheduler] archiving ${symbols.length} symbol(s): ${symbols.join(', ')}`);

    const oneMin = await archiveBars({ symbols, barSize: '1 min', duration: '1 D' });
    const fiveMin = await archiveBars({ symbols, barSize: '5 mins', duration: '2 D' });

    const count = (r: Record<string, number>) => Object.values(r).filter((n) => n >= 0).reduce((a, b) => a + b, 0);
    const failures = Object.entries(oneMin).filter(([, n]) => n < 0).map(([s]) => s);
    logger.info(
        `[archive-scheduler] done: ${count(oneMin)} 1-min bars, ${count(fiveMin)} 5-min bars` +
        (failures.length ? ` (failed: ${failures.join(', ')})` : ''),
    );
}

let job: Cron | null = null;

/** Start the daily post-close archival job (idempotent). */
export function startArchiveScheduler(): void {
    if (job) return;
    job = new Cron(ARCHIVE_CRON, { timezone: ET }, () => {
        runArchiveOnce().catch((err) => logger.error(`[archive-scheduler] run failed: ${err}`));
    });
    const next = job.nextRun();
    logger.info(`[archive-scheduler] started (next run ${next ? next.toISOString() : 'unknown'})`);
}

/** Stop the archival job. */
export function stopArchiveScheduler(): void {
    if (job) {
        job.stop();
        job = null;
        logger.info('[archive-scheduler] stopped');
    }
}
