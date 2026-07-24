/**
 * Earnings calendar — free, keyless, from Nasdaq's public endpoint.
 *
 * The missing catalyst layer: MU/INTC/COIN all gapped on earnings the
 * system could not anticipate, and the overnight-risk rule ("flag earnings
 * within 2 days") had no data source. This fills both, without another
 * paid subscription.
 *
 * Fetches per-day calendars (today .. +LOOKAHEAD_DAYS), caches to
 * earnings-calendar.json (per-day entries survive restarts; a day is
 * refetched when older than CACHE_TTL_MS). Failure degrades gracefully —
 * an empty day is reported as unknown, never as "no earnings".
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/utils';

const LOOKAHEAD_DAYS = 7;
const CACHE_TTL_MS = 6 * 3600_000;
const FETCH_TIMEOUT_MS = 15_000;

export interface EarningsEntry {
    symbol: string;
    name: string;
    /** 'pre-market' | 'after-hours' | 'unknown' */
    time: string;
    epsForecast: string | null;
    marketCap: string | null;
}

interface DayCache {
    fetchedAt: number;
    entries: EarningsEntry[];
}

interface CalendarCache {
    days: Record<string, DayCache>;
}

// ---------------------------------------------------------------------------
// Pure parsing (unit-tested)
// ---------------------------------------------------------------------------

/** Parse Nasdaq's calendar JSON into entries. Unknown shapes → []. */
export function parseNasdaqEarnings(json: unknown): EarningsEntry[] {
    const rows = (json as { data?: { rows?: unknown } })?.data?.rows;
    if (!Array.isArray(rows)) return [];
    const timeMap: Record<string, string> = {
        'time-pre-market': 'pre-market',
        'time-after-hours': 'after-hours',
    };
    return rows
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .filter((r) => typeof r.symbol === 'string' && r.symbol.length > 0)
        .map((r) => ({
            symbol: String(r.symbol).toUpperCase(),
            name: typeof r.name === 'string' ? r.name : '',
            time: timeMap[String(r.time)] ?? 'unknown',
            epsForecast: typeof r.epsForecast === 'string' && r.epsForecast ? r.epsForecast : null,
            marketCap: typeof r.marketCap === 'string' && r.marketCap ? r.marketCap : null,
        }));
}

/** ET calendar date string for now + N days: 'YYYY-MM-DD'. */
export function etDatePlus(days: number, now: Date = new Date()): string {
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    et.setDate(et.getDate() + days);
    return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

function cachePath(): string {
    return join(process.env.DEXTER_DATA_DIR || join('.dexter', 'data'), 'earnings-calendar.json');
}

function loadCache(): CalendarCache {
    try {
        return JSON.parse(readFileSync(cachePath(), 'utf-8')) as CalendarCache;
    } catch {
        return { days: {} };
    }
}

function saveCache(cache: CalendarCache): void {
    try {
        // Drop stale past days so the file does not grow forever.
        const today = etDatePlus(0);
        for (const day of Object.keys(cache.days)) {
            if (day < today) delete cache.days[day];
        }
        writeFileSync(cachePath(), JSON.stringify(cache, null, 2));
    } catch (err) {
        logger.warn(`[earnings-calendar] cache persist failed: ${err}`);
    }
}

async function fetchDay(date: string): Promise<EarningsEntry[] | null> {
    try {
        const res = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseNasdaqEarnings(await res.json());
    } catch (err) {
        logger.warn(`[earnings-calendar] fetch ${date} failed: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}

/** Entries for one ET date (cached). Null = data unavailable (≠ empty day). */
export async function getEarningsForDate(date: string): Promise<EarningsEntry[] | null> {
    const cache = loadCache();
    const hit = cache.days[date];
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.entries;

    const fetched = await fetchDay(date);
    if (fetched === null) return hit?.entries ?? null; // stale beats nothing
    cache.days[date] = { fetchedAt: Date.now(), entries: fetched };
    saveCache(cache);
    return fetched;
}

export interface UpcomingEarnings {
    symbol: string;
    date: string;
    daysAway: number;
    time: string;
    epsForecast: string | null;
}

/**
 * Which of `symbols` report within the next `withinDays` ET days?
 * Days whose data is unavailable are listed in `unknownDays` — the caller
 * must treat those as "could not verify", never as "no earnings".
 */
export async function findUpcomingEarnings(
    symbols: string[],
    withinDays = 2,
): Promise<{ hits: UpcomingEarnings[]; unknownDays: string[] }> {
    const wanted = new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean));
    const hits: UpcomingEarnings[] = [];
    const unknownDays: string[] = [];
    for (let d = 0; d <= withinDays; d++) {
        const date = etDatePlus(d);
        const entries = await getEarningsForDate(date);
        if (entries === null) { unknownDays.push(date); continue; }
        for (const e of entries) {
            if (wanted.has(e.symbol)) {
                hits.push({ symbol: e.symbol, date, daysAway: d, time: e.time, epsForecast: e.epsForecast });
            }
        }
    }
    return { hits, unknownDays };
}

/** Prefetch the lookahead window (used by the daily brief path). */
export async function prefetchEarningsWindow(): Promise<void> {
    for (let d = 0; d <= LOOKAHEAD_DAYS; d++) {
        await getEarningsForDate(etDatePlus(d));
        await new Promise((r) => setTimeout(r, 400));
    }
}
