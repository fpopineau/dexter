/**
 * Nightly swing-pattern scan — stages 4–5 of the custom scanner plan.
 *
 * Runs the pure detectors (pattern-detectors.ts) over every symbol with
 * enough archived daily history (built by the nightly universe sweep),
 * ranks the matches, and persists a snapshot the agent reads via the
 * `swing_patterns` tool and the Pre-Market Brief consults for GTC swing
 * candidates. Local SQLite only — no IBKR requests, safe to re-run.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDailyBars, listDailySymbols } from './data-archive.js';
import { dailyAtrOf, detectPatterns, type PatternMatch } from './pattern-detectors.js';
import { isMarketHalfDay, isMarketHoliday } from '@/utils/market-hours.js';
import { logger } from '@/utils';

const ET = 'America/New_York';

const MIN_BARS = 120;          // enough history for the deepest detector
const MAX_STALE_DAYS = 5;      // skip symbols whose last bar is old (delisted/halted)
const TOP_N = 25;

export interface PatternCandidate extends PatternMatch {
    symbol: string;
    close: number;
    dailyAtr: number | null;
    lastBar: string;
}

export interface PatternScanSnapshot {
    ranAt: number;
    scanned: number;
    eligible: number;
    candidates: PatternCandidate[];
}

function snapshotPath(): string {
    return join(process.env.DEXTER_DATA_DIR || join('.dexter', 'data'), 'pattern-scan.json');
}

export async function runPatternScan(): Promise<PatternScanSnapshot> {
    const started = Date.now();
    const symbols = await listDailySymbols(MIN_BARS);
    const candidates: PatternCandidate[] = [];
    let eligible = 0;

    for (const symbol of symbols) {
        const bars = await getDailyBars(symbol);
        const lastBar = bars[bars.length - 1];
        const ageDays = (started - Date.parse(lastBar.time.slice(0, 4) + '-' + lastBar.time.slice(4, 6) + '-' + lastBar.time.slice(6, 8))) / 86_400_000;
        if (!Number.isFinite(ageDays) || ageDays > MAX_STALE_DAYS) continue;
        eligible++;

        const matches = detectPatterns(bars);
        if (matches.length === 0) continue;
        // Keep only the strongest pattern per symbol.
        candidates.push({
            symbol,
            close: lastBar.close,
            dailyAtr: dailyAtrOf(bars),
            lastBar: lastBar.time.slice(0, 8),
            ...matches[0],
        });
    }

    candidates.sort((a, b) => b.score - a.score);
    const snapshot: PatternScanSnapshot = {
        ranAt: started,
        scanned: symbols.length,
        eligible,
        candidates: candidates.slice(0, TOP_N),
    };
    writeFileSync(snapshotPath(), JSON.stringify(snapshot, null, 2));
    logger.info(
        `[pattern-scan] ${symbols.length} symbols with ≥${MIN_BARS}d history, ${eligible} fresh, ` +
        `${candidates.length} matches (kept top ${snapshot.candidates.length}) in ${Date.now() - started}ms`,
    );
    return snapshot;
}

/** Latest persisted scan, or null if none has run yet. */
export function getLatestPatternScan(): PatternScanSnapshot | null {
    try {
        return JSON.parse(readFileSync(snapshotPath(), 'utf-8')) as PatternScanSnapshot;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Startup catch-up — the scan is stage 4 of the nightly universe sweep, and
// the nightly gateway restart window (~22:00–22:33 UTC) killed that sweep
// mid-run six nights straight (Jul 31 → Aug 6, 2026): every Pre-Market
// Brief consumed week-old candidates. The fix is self-healing rather than
// schedule-juggling: whichever restart killed the sweep also boots the
// gateway that notices the snapshot is stale and re-scans (local SQLite
// only, seconds).
// ---------------------------------------------------------------------------

function toEtDate(input: Date | number): string {
    const et = new Date(new Date(input).toLocaleString('en-US', { timeZone: ET }));
    return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

/**
 * ET date of the most recent trading day whose regular session has ENDED.
 * Today counts only after its close (16:00 ET, 13:00 on half days);
 * weekends and holidays walk back.
 */
export function lastCompletedTradingDayEt(now: Date = new Date()): string {
    const et = new Date(now.toLocaleString('en-US', { timeZone: ET }));
    const closeHour = isMarketHalfDay(toEtDate(now)) ? 13 : 16;
    if (et.getHours() < closeHour) et.setDate(et.getDate() - 1);
    while (et.getDay() === 0 || et.getDay() === 6
        || isMarketHoliday(`${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`)) {
        et.setDate(et.getDate() - 1);
    }
    return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

/**
 * Stale = no snapshot, or one produced before the last completed session
 * ended. A scan run the evening of the last trading day (same ET date)
 * is fresh; so is one run later (e.g. this morning pre-market).
 */
export function isPatternScanStale(ranAtMs: number | null | undefined, now: Date = new Date()): boolean {
    if (ranAtMs == null || !Number.isFinite(ranAtMs)) return true;
    return toEtDate(ranAtMs) < lastCompletedTradingDayEt(now);
}

let catchUpRan = false;

/**
 * Re-run the scan at gateway startup when the persisted snapshot predates
 * the last completed trading day. Idempotent per process; never throws.
 */
export async function catchUpPatternScan(): Promise<void> {
    if (catchUpRan) return;
    catchUpRan = true;
    try {
        const latest = getLatestPatternScan();
        if (!isPatternScanStale(latest?.ranAt, new Date())) {
            logger.info('[pattern-scan] snapshot current — no startup catch-up needed');
            return;
        }
        const from = latest ? new Date(latest.ranAt).toISOString().slice(0, 10) : 'never';
        logger.info(`[pattern-scan] catch-up: snapshot from ${from} predates the last completed session — rescanning`);
        await runPatternScan();
    } catch (err) {
        logger.warn(`[pattern-scan] startup catch-up failed (stale snapshot stays): ${err}`);
    }
}
