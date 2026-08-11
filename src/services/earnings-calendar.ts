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
import { isMarketHoliday } from '@/utils/market-hours.js';

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

/**
 * The next `count` ET TRADING dates strictly after today (weekends and
 * market holidays skipped). Forward-looking guards must walk trading
 * days: a Friday check that walks calendar days inspects Saturday and
 * declares the weekend safe while Monday's pre-market print waits on the
 * other side — the position rides three nights into it (the weekend
 * blind spot, audit 2026-08-11). Unlike the backward look, a forward
 * holiday miss is NOT safe, so holidays are skipped via the exchange
 * calendar (a Friday before a holiday Monday reaches Tuesday).
 */
export function nextTradingDates(count: number, now: Date = new Date()): string[] {
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const out: string[] = [];
    while (out.length < count) {
        et.setDate(et.getDate() + 1);
        if (et.getDay() === 0 || et.getDay() === 6) continue;
        const iso = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
        if (isMarketHoliday(iso)) continue;
        out.push(iso);
    }
    return out;
}

/** The dates a `withinDays`-deep earnings guard must inspect: today plus
 *  the next `withinDays` trading days. Pure; exported for tests. */
export function guardDates(withinDays: number, now: Date = new Date()): string[] {
    return [etDatePlus(0, now), ...nextTradingDates(withinDays, now)];
}

/** Previous weekday's ET date (Mon → Fri). Holidays are not modeled: a
 *  holiday-Monday look-back lands on an empty calendar day, which simply
 *  yields "no earnings" — a safe miss, never a false positive. */
export function previousTradingDate(now: Date = new Date()): string {
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    do {
        et.setDate(et.getDate() - 1);
    } while (et.getDay() === 0 || et.getDay() === 6);
    return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

/**
 * Pure core of reportedRecently: did the symbol report within the last
 * session, judged from today's and the previous trading day's calendars?
 * A gap TODAY comes from yesterday's after-hours print or today's
 * pre-market print; 'unknown' timing counts on both sides (Nasdaq omits
 * the slot often enough that excluding it would gut the exception).
 * Null = the needed data was unavailable — callers must stay strict.
 */
export function decideReportedRecently(input: {
    symbol: string;
    todayEntries: EarningsEntry[] | null;
    prevEntries: EarningsEntry[] | null;
}): boolean | null {
    const sym = input.symbol.trim().toUpperCase();
    const inToday = input.todayEntries?.some(
        (e) => e.symbol === sym && (e.time === 'pre-market' || e.time === 'unknown'),
    );
    const inPrev = input.prevEntries?.some(
        (e) => e.symbol === sym && (e.time === 'after-hours' || e.time === 'unknown'),
    );
    if (inToday || inPrev) return true;
    if (input.todayEntries === null || input.prevEntries === null) return null;
    return false;
}

/** Did `symbol` report earnings within the last trading session? Consumed
 *  by the extension guard's earnings-gap exception. Null = could not
 *  verify (the guard then stays strict). */
export async function reportedRecently(symbol: string, now: Date = new Date()): Promise<boolean | null> {
    const [todayEntries, prevEntries] = await Promise.all([
        getEarningsForDate(etDatePlus(0, now)),
        getEarningsForDate(previousTradingDate(now)),
    ]);
    return decideReportedRecently({ symbol, todayEntries, prevEntries });
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
        // Drop stale past days so the file does not grow forever — but keep
        // the previous trading day: the extension guard's earnings-gap
        // exception looks one session back.
        const keepFrom = previousTradingDate();
        for (const day of Object.keys(cache.days)) {
            if (day < keepFrom) delete cache.days[day];
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
 * Which of `symbols` report today or within the next `withinDays`
 * TRADING days? (Since 2026-08-11 the walk skips weekends and holidays —
 * `withinDays: 1` on a Friday inspects Friday AND Monday, so a keep never
 * rides the weekend into a Monday pre-market print unseen. `daysAway` is
 * the trading-day offset; `date` carries the actual calendar date.)
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
    const dates = guardDates(withinDays);
    for (let d = 0; d < dates.length; d++) {
        const date = dates[d];
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
