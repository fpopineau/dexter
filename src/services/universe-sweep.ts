/**
 * Universe sweep — nightly maintenance of the midcap universe and its
 * daily-bar history. OPT-IN (UNIVERSE_SWEEP=true); nothing in the default
 * pipeline changes when disabled.
 *
 * Each trading night at 18:00 ET, within a bounded IBKR request budget:
 *   1. refresh the listing directory (weekly) and attach CIKs;
 *   2. enrich shares outstanding from SEC EDGAR (paced, free);
 *   3. price-probe entries with unknown caps (one short daily-bar request
 *      each) so cap = shares × close becomes known — the universe
 *      converges over a few nights;
 *   4. archive ~400 days of DAILY bars for entries inside the cap band
 *      (resumable — incremental after the first pass).
 *
 * The result: market-archive.db accumulates the daily history that swing /
 * cup-and-handle pattern scanners need, for exactly the names in the band.
 *
 * Environment:
 *   UNIVERSE_SWEEP          'true' enables the nightly job (default off)
 *   UNIVERSE_CAP_MIN        band lower bound, USD (default 1e9)
 *   UNIVERSE_CAP_MAX        band upper bound, USD (default 5e9)
 *   UNIVERSE_MAX_REQUESTS   IBKR historical requests per night (default 1200)
 *   UNIVERSE_PACE_MS        pacing between IBKR requests (default 3000)
 *   UNIVERSE_SEC_BUDGET     EDGAR requests per night (default 2000)
 *   UNIVERSE_SEC_UA         User-Agent for SEC requests
 */

import { loadArchive } from '@/backtest/data-loader.js';
import { logger } from '@/utils';
import { isMarketHoliday } from '@/utils/market-hours.js';
import { Cron } from 'croner';
import { archiveBarsRange } from './data-archive.js';
import {
    attachCiks,
    computeCaps,
    enrichShares,
    getUniverse,
    loadUniverse,
    refreshDirectory,
    saveUniverse,
    type UniverseStore,
} from './universe-builder.js';

const SWEEP_CRON = '0 18 * * 1-5'; // 18:00 ET, after the intraday archive job
const ET = 'America/New_York';
const DAY_MS = 24 * 3600_000;
const DIRECTORY_MAX_AGE_MS = 7 * DAY_MS;
const CLOSE_MAX_AGE_MS = 7 * DAY_MS;

export function isUniverseSweepEnabled(): boolean {
    return (process.env.UNIVERSE_SWEEP ?? '').trim().toLowerCase() === 'true';
}

function envNum(name: string, dflt: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : dflt;
}

function isoDaysAgo(days: number): string {
    const d = new Date(Date.now() - days * DAY_MS);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Update lastClose for a symbol from the archived daily bars. */
async function refreshCloseFromArchive(store: UniverseStore, symbol: string): Promise<void> {
    try {
        const bars = await loadArchive(symbol, '1 day');
        const last = bars[bars.length - 1];
        if (last && Number.isFinite(last.close) && last.close > 0) {
            const entry = store.entries[symbol];
            if (entry) {
                entry.lastClose = last.close;
                entry.closeAt = Date.now();
            }
        }
    } catch { /* no bars archived yet */ }
}

/** One full sweep. Exported for manual runs and scripts. */
export async function runUniverseSweepOnce(): Promise<void> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: ET });
    if (isMarketHoliday(today)) {
        logger.info(`[universe-sweep] ${today} is a market holiday — skipping`);
        return;
    }

    const capMin = envNum('UNIVERSE_CAP_MIN', 1e9);
    const capMax = envNum('UNIVERSE_CAP_MAX', 5e9);
    const ibkrBudget = envNum('UNIVERSE_MAX_REQUESTS', 1200);
    const paceMs = envNum('UNIVERSE_PACE_MS', 3000);
    const secBudget = envNum('UNIVERSE_SEC_BUDGET', 2000);

    const store = loadUniverse();

    // 1. Directory + CIKs (weekly)
    if (Date.now() - store.directoryAt > DIRECTORY_MAX_AGE_MS) {
        try {
            await refreshDirectory(store);
            await attachCiks(store);
            saveUniverse(store);
        } catch (err) {
            logger.error(`[universe-sweep] directory refresh failed: ${err}`);
            if (Object.keys(store.entries).length === 0) return; // nothing to work with
        }
    }

    // 2. EDGAR shares (free, paced)
    try {
        await enrichShares(store, { budget: secBudget });
        saveUniverse(store);
    } catch (err) {
        logger.error(`[universe-sweep] shares enrichment failed: ${err}`);
    }

    // 3+4. IBKR daily bars within the request budget.
    let spent = 0;

    // In-band names first: deepen/refresh their daily history (the data
    // pattern scanners will read). Resume makes this incremental.
    const inBand = getUniverse(store, { minCapUsd: capMin, maxCapUsd: capMax });
    logger.info(`[universe-sweep] band $${(capMin / 1e9).toFixed(1)}–${(capMax / 1e9).toFixed(1)}B: ${inBand.length} names known in band`);

    for (const entry of inBand) {
        if (spent >= ibkrBudget * 0.5 && hasUnknowns(store)) break; // leave budget for discovery
        if (spent >= ibkrBudget) break;
        const result = await archiveBarsRange({
            symbols: [entry.symbol],
            from: isoDaysAgo(400),
            to: isoDaysAgo(1),
            barSize: '1 day',
            chunkDays: 365,
            useRTH: true,
            paceMs,
            resume: true,
            withDailyAdjusted: false,
        });
        spent += result.chunksFetched + result.chunksFailed;
        await refreshCloseFromArchive(store, entry.symbol);
    }

    // Discovery probes: unknown-cap names get one short daily request each.
    const unknowns = Object.values(store.entries)
        .filter((e) => e.shares !== undefined &&
            (e.capUsd === undefined || (e.closeAt !== undefined && Date.now() - e.closeAt > CLOSE_MAX_AGE_MS)))
        .sort((a, b) => (a.closeAt ?? 0) - (b.closeAt ?? 0));

    let probed = 0;
    for (const entry of unknowns) {
        if (spent >= ibkrBudget) break;
        const result = await archiveBarsRange({
            symbols: [entry.symbol],
            from: isoDaysAgo(10),
            to: isoDaysAgo(1),
            barSize: '1 day',
            chunkDays: 10,
            useRTH: true,
            paceMs,
            resume: false,
            withDailyAdjusted: false,
        });
        spent += Math.max(1, result.chunksFetched + result.chunksFailed);
        await refreshCloseFromArchive(store, entry.symbol);
        probed++;
    }

    const capsKnown = computeCaps(store);
    saveUniverse(store);

    const finalBand = getUniverse(store, { minCapUsd: capMin, maxCapUsd: capMax });
    logger.info(
        `[universe-sweep] done: ${spent}/${ibkrBudget} IBKR requests (${probed} probes), ` +
        `${capsKnown} caps known, ${finalBand.length} names in band, ` +
        `${unknowns.length - probed} still awaiting probes`,
    );

    // Stage 4: swing-pattern scan over the freshly extended daily history.
    // Local reads only — a failure must never mark the sweep failed.
    try {
        const { runPatternScan } = await import('./pattern-scanner.js');
        await runPatternScan();
    } catch (err) {
        logger.error(`[universe-sweep] pattern scan failed: ${err}`);
    }
}

function hasUnknowns(store: UniverseStore): boolean {
    return Object.values(store.entries).some((e) => e.shares !== undefined && e.capUsd === undefined);
}

// ---------------------------------------------------------------------------
// Scheduler lifecycle
// ---------------------------------------------------------------------------

let job: Cron | null = null;
let running = false;

/** Start the nightly sweep (idempotent; only when UNIVERSE_SWEEP=true). */
export function startUniverseSweep(): void {
    if (job) return;
    job = new Cron(SWEEP_CRON, { timezone: ET }, async () => {
        if (running) {
            logger.warn('[universe-sweep] previous sweep still running — skipping this trigger');
            return;
        }
        running = true;
        try {
            await runUniverseSweepOnce();
        } catch (err) {
            logger.error(`[universe-sweep] sweep failed: ${err}`);
        } finally {
            running = false;
        }
    });
    const next = job.nextRun();
    logger.info(`[universe-sweep] started (next run ${next ? next.toISOString() : 'unknown'})`);
}

export function stopUniverseSweep(): void {
    if (job) {
        job.stop();
        job = null;
        logger.info('[universe-sweep] stopped');
    }
}
