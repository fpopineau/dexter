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
import { logger } from '@/utils';

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
