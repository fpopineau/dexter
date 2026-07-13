/**
 * Data archive service — continuously collects intraday bars from IBKR
 * and persists them to SQLite for offline analysis and backtesting.
 *
 * Designed to be invoked by a cron job during market hours.
 */

import { allocReqId, getIBApi, isNonFatalIbkrError } from '@/tools/ibkr/connection.js';
import { logger } from '@/utils';
import type { Bar } from '@stoqey/ib';
import { BarSizeSetting, Contract, EventName, SecType, WhatToShow } from '@stoqey/ib';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// SQLite abstraction (mirrors memory/database.ts pattern)
// ---------------------------------------------------------------------------

interface SqliteQuery<T> {
    all(...params: unknown[]): T[];
    get(...params: unknown[]): T | null;
    run(...params: unknown[]): void;
}

interface SqliteDatabase {
    exec(sql: string): void;
    query<T>(sql: string): SqliteQuery<T>;
    close(): void;
}

async function openSqlite(path: string): Promise<SqliteDatabase> {
    await mkdir(dirname(path), { recursive: true });
    try {
        const sqlite = await import('bun:sqlite');
        const DatabaseCtor = sqlite.Database as new (dbPath: string) => SqliteDatabase;
        return new DatabaseCtor(path);
    } catch {
        const mod = await import('better-sqlite3');
        const Database = mod.default;
        const raw = new Database(path);
        return {
            exec: (sql: string) => raw.exec(sql),
            query: <T>(sql: string): SqliteQuery<T> => {
                const stmt = raw.prepare(sql);
                return {
                    all: (...params: unknown[]) => stmt.all(...params) as T[],
                    get: (...params: unknown[]) => (stmt.get(...params) as T) ?? null,
                    run: (...params: unknown[]) => { stmt.run(...params); },
                };
            },
            close: () => raw.close(),
        };
    }
}

// ---------------------------------------------------------------------------
// Schema and DB lifecycle
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = join('.dexter', 'data', 'market-archive.db');

let db: SqliteDatabase | null = null;

async function getDb(): Promise<SqliteDatabase> {
    if (db) return db;
    const dbPath = process.env.DATA_ARCHIVE_PATH || DEFAULT_DB_PATH;
    db = await openSqlite(dbPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS bars (
      symbol     TEXT    NOT NULL,
      bar_size   TEXT    NOT NULL,
      time       TEXT    NOT NULL,
      open       REAL,
      high       REAL,
      low        REAL,
      close      REAL,
      volume     INTEGER,
      count      INTEGER,
      wap        REAL,
      PRIMARY KEY (symbol, bar_size, time)
    );
    CREATE INDEX IF NOT EXISTS idx_bars_symbol_time ON bars (symbol, time);
  `);
    return db;
}

// ---------------------------------------------------------------------------
// Archive logic
// ---------------------------------------------------------------------------

interface ArchiveOptions {
    /** Ticker symbols to archive. */
    symbols: string[];
    /** Bar size to collect. Defaults to '5 mins'. */
    barSize?: string;
    /** Duration lookback. Defaults to '1 D'. */
    duration?: string;
    /** What data to show. Defaults to 'TRADES'. */
    whatToShow?: string;
    /** Use regular trading hours only. Defaults to true. */
    useRTH?: boolean;
}

const BAR_SIZE_MAP: Record<string, BarSizeSetting> = {
    '1 min': BarSizeSetting.MINUTES_ONE,
    '5 mins': BarSizeSetting.MINUTES_FIVE,
    '15 mins': BarSizeSetting.MINUTES_FIFTEEN,
    '30 mins': BarSizeSetting.MINUTES_THIRTY,
    '1 hour': BarSizeSetting.HOURS_ONE,
    '1 day': BarSizeSetting.DAYS_ONE,
};

/**
 * One reqHistoricalData round-trip. Returns the received bars.
 *
 * endDateTime '' means "duration ending now". IBKR reuses error code 162
 * for both "no data in this window" (benign — resolves empty) and pacing
 * violations (thrown with `pacing` in the message so callers can back off).
 * When partialOk is false, a stalled request rejects instead of returning
 * whatever arrived — backfill must never silently record a hole.
 */
async function fetchHistoricalBars(params: {
    symbol: string;
    endDateTime: string;
    duration: string;
    barSize: BarSizeSetting;
    whatToShow: string;
    useRTH: boolean;
    partialOk: boolean;
    timeoutMs?: number;
}): Promise<Bar[]> {
    const api = await getIBApi();
    const reqId = allocReqId();
    const { symbol } = params;

    const contract: Contract = {
        symbol,
        secType: SecType.STK,
        exchange: 'SMART',
        currency: 'USD',
    };

    const bars: Bar[] = [];

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            if (params.partialOk) resolve();
            else reject(new Error(`[DataArchive] timeout for ${symbol} (${params.endDateTime || 'now'}, ${params.duration})`));
        }, params.timeoutMs ?? 60_000);

        const onHistoricalData = (
            id: number,
            time: string,
            open: number,
            high: number,
            low: number,
            close: number,
            volume: number,
            count: number | undefined,
            WAP: number,
            _hasGaps?: boolean | undefined,
        ) => {
            if (id !== reqId) return;
            if (typeof time === 'string' && time.startsWith('finished')) {
                clearTimeout(timeout);
                cleanup();
                resolve();
                return;
            }
            bars.push({ time, open, high, low, close, volume, count, WAP });
        };

        const onError = (err: Error, code: number, id: number) => {
            if (id !== reqId) return;
            if (isNonFatalIbkrError(code)) return;
            if (code === 162 && /no data/i.test(err.message)) {
                // Benign: the window has no bars (holiday, halted, not yet listed).
                clearTimeout(timeout);
                cleanup();
                resolve();
                return;
            }
            clearTimeout(timeout);
            cleanup();
            reject(new Error(`[DataArchive] Error ${code} for ${symbol}: ${err.message}`));
        };

        function cleanup() {
            api.off(EventName.historicalData, onHistoricalData);
            api.off(EventName.error, onError);
        }

        api.on(EventName.historicalData, onHistoricalData);
        api.on(EventName.error, onError);

        api.reqHistoricalData(
            reqId,
            contract,
            params.endDateTime,
            params.duration,
            params.barSize,
            params.whatToShow as WhatToShow,
            params.useRTH ? 1 : 0,
            1, // formatDate
            false, // keepUpToDate
        );
    });

    return bars;
}

/** Upsert bars into the archive. Returns the number of rows written. */
async function upsertBars(symbol: string, barSizeLabel: string, bars: Bar[]): Promise<number> {
    const database = await getDb();
    const insert = database.query<void>(
        `INSERT OR REPLACE INTO bars (symbol, bar_size, time, open, high, low, close, volume, count, wap)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const bar of bars) {
        insert.run(
            symbol,
            barSizeLabel,
            bar.time ?? '',
            bar.open ?? null,
            bar.high ?? null,
            bar.low ?? null,
            bar.close ?? null,
            bar.volume ?? null,
            bar.count ?? null,
            bar.WAP ?? null,
        );
    }
    return bars.length;
}

/**
 * Fetch historical bars for a single symbol (duration ending now) and
 * upsert into SQLite. Returns the number of bars written.
 */
async function archiveSymbol(
    symbol: string,
    barSize: BarSizeSetting,
    barSizeLabel: string,
    duration: string,
    whatToShow: string,
    useRTH: boolean,
): Promise<number> {
    const bars = await fetchHistoricalBars({
        symbol,
        endDateTime: '',
        duration,
        barSize,
        whatToShow,
        useRTH,
        partialOk: true, // daily post-close collection: partial beats nothing
        timeoutMs: 30_000,
    });
    return upsertBars(symbol, barSizeLabel, bars);
}

/**
 * Archive intraday bars for a list of symbols.
 * Call this from a cron job or directly.
 */
export async function archiveBars(options: ArchiveOptions): Promise<Record<string, number>> {
    const barSizeLabel = options.barSize || '5 mins';
    const barSize = BAR_SIZE_MAP[barSizeLabel];
    if (!barSize) {
        throw new Error(`[DataArchive] Invalid barSize '${barSizeLabel}'. Valid: ${Object.keys(BAR_SIZE_MAP).join(', ')}`);
    }

    const duration = options.duration || '1 D';
    const whatToShow = options.whatToShow || 'TRADES';
    const useRTH = options.useRTH ?? true;

    const results: Record<string, number> = {};

    for (const symbol of options.symbols) {
        try {
            const count = await archiveSymbol(
                symbol.trim().toUpperCase(),
                barSize,
                barSizeLabel,
                duration,
                whatToShow,
                useRTH,
            );
            results[symbol] = count;
            logger.info(`[DataArchive] Archived ${count} bars for ${symbol}`);
            // Small delay between symbols to respect IBKR rate limits
            await new Promise((r) => setTimeout(r, 500));
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.error(`[DataArchive] Failed to archive ${symbol}: ${msg}`);
            results[symbol] = -1;
        }
    }

    return results;
}

// ---------------------------------------------------------------------------
// Range backfill (historical gap filling)
// ---------------------------------------------------------------------------

export interface ArchiveRangeOptions {
    /** Ticker symbols to backfill. */
    symbols: string[];
    /** Inclusive start date, YYYY-MM-DD. */
    from: string;
    /** Inclusive end date, YYYY-MM-DD. */
    to: string;
    /** Bar size. Defaults to '1 min'. */
    barSize?: string;
    /** Calendar days per request chunk. Defaults to 7 (safe for 1-min bars). */
    chunkDays?: number;
    /** Regular trading hours only. Defaults to false (extended hours,
     *  matching the FirstRate archives). */
    useRTH?: boolean;
    /** What to show. Defaults to 'TRADES' (as-traded — see the note below). */
    whatToShow?: string;
    /** Delay between historical requests. Defaults to 11 s
     *  (IBKR pacing: max 60 historical requests / 10 min). */
    paceMs?: number;
    /** Skip the part of the range already in the archive. Defaults to true. */
    resume?: boolean;
    /** Also store a daily ADJUSTED_LAST series (label '1 day adj') so
     *  split/dividend adjustment factors can be derived. Defaults to true. */
    withDailyAdjusted?: boolean;
    /** Progress callback (chunk-level). */
    onProgress?: (msg: string) => void;
}

export interface ArchiveRangeResult {
    /** Bars written per symbol (−1 = failed). */
    bars: Record<string, number>;
    chunksFetched: number;
    chunksFailed: number;
}

const DAY_MS = 24 * 3600_000;

function ymdCompact(d: Date): string {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function parseYmd(s: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) throw new Error(`[DataArchive] invalid date '${s}' (expected YYYY-MM-DD)`);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Latest archived bar date (YYYYMMDD) for (symbol, barSize), or null. */
async function latestArchivedDay(symbol: string, barSizeLabel: string): Promise<string | null> {
    const database = await getDb();
    const row = database.query<{ t: string | null }>(
        `SELECT MAX(time) AS t FROM bars WHERE symbol = ? AND bar_size = ?`,
    ).get(symbol, barSizeLabel);
    const t = row?.t;
    return t && t.length >= 8 ? t.slice(0, 8) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Backfill a date range of historical bars into the archive.
 *
 * Chunked (endDateTime + duration), paced for IBKR limits, resumable
 * (re-runs skip what is already archived; upserts make overlap harmless),
 * with one retry after a 60 s back-off per failed chunk.
 *
 * Adjustment note: IBKR's ADJUSTED_LAST is only served for requests ending
 * "now", so ranged chunks use TRADES (as-traded prices). To keep the data
 * adjustable, withDailyAdjusted also stores a daily ADJUSTED_LAST series
 * per symbol ('1 day adj'): dividing it by the as-traded daily closes gives
 * the per-day factor to adjust intraday bars when a split/dividend matters.
 */
export async function archiveBarsRange(options: ArchiveRangeOptions): Promise<ArchiveRangeResult> {
    const barSizeLabel = options.barSize || '1 min';
    const barSize = BAR_SIZE_MAP[barSizeLabel];
    if (!barSize) {
        throw new Error(`[DataArchive] Invalid barSize '${barSizeLabel}'. Valid: ${Object.keys(BAR_SIZE_MAP).join(', ')}`);
    }
    const from = parseYmd(options.from);
    const to = parseYmd(options.to);
    if (from > to) throw new Error(`[DataArchive] from ${options.from} is after to ${options.to}`);

    const chunkDays = Math.max(1, options.chunkDays ?? 7);
    const useRTH = options.useRTH ?? false;
    const whatToShow = options.whatToShow || 'TRADES';
    const paceMs = Math.max(2_000, options.paceMs ?? 11_000);
    const resume = options.resume ?? true;
    const progress = options.onProgress ?? ((msg: string) => logger.info(`[DataArchive] ${msg}`));

    const result: ArchiveRangeResult = { bars: {}, chunksFetched: 0, chunksFailed: 0 };

    for (const rawSymbol of options.symbols) {
        const symbol = rawSymbol.trim().toUpperCase();
        let written = 0;
        let failed = false;

        // Resume: start after the last archived day (repeat it, upsert dedupes).
        let start = from;
        if (resume) {
            const latest = await latestArchivedDay(symbol, barSizeLabel);
            if (latest) {
                const latestDate = new Date(
                    Number(latest.slice(0, 4)), Number(latest.slice(4, 6)) - 1, Number(latest.slice(6, 8)),
                );
                if (latestDate > start) start = latestDate;
                if (start > to) {
                    progress(`${symbol}: already archived through ${latest}, nothing to do`);
                    result.bars[symbol] = 0;
                    continue;
                }
            }
        }

        // Walk the range in chunks, oldest first.
        for (let chunkStart = start; chunkStart <= to; chunkStart = new Date(chunkStart.getTime() + chunkDays * DAY_MS)) {
            const chunkEnd = new Date(Math.min(chunkStart.getTime() + (chunkDays - 1) * DAY_MS, to.getTime()));
            const endDateTime = `${ymdCompact(chunkEnd)} 23:59:59 US/Eastern`;
            const duration = `${chunkDays} D`;

            let bars: Bar[] | null = null;
            for (let attempt = 0; attempt < 2 && bars === null; attempt++) {
                try {
                    bars = await fetchHistoricalBars({
                        symbol, endDateTime, duration, barSize, whatToShow, useRTH, partialOk: false,
                    });
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (attempt === 0) {
                        progress(`${symbol} ${options.barSize ?? '1 min'} ← ${endDateTime}: ${msg} — backing off 60s and retrying`);
                        await sleep(60_000);
                    } else {
                        logger.error(`[DataArchive] ${symbol} chunk ending ${endDateTime} failed twice: ${msg}`);
                        result.chunksFailed++;
                        failed = true;
                    }
                }
            }
            if (bars !== null) {
                written += await upsertBars(symbol, barSizeLabel, bars);
                result.chunksFetched++;
                progress(`${symbol}: ${bars.length} bars ← ${ymdCompact(chunkStart)}..${ymdCompact(chunkEnd)} (total ${written})`);
            }
            await sleep(paceMs);
        }

        // Daily ADJUSTED_LAST series for adjustment factors (ending now by
        // IBKR constraint; covers the whole backfilled window and then some).
        if (options.withDailyAdjusted ?? true) {
            try {
                const spanYears = Math.min(5, Math.ceil((Date.now() - from.getTime()) / (365 * DAY_MS)) + 1);
                const daily = await fetchHistoricalBars({
                    symbol,
                    endDateTime: '',
                    duration: `${spanYears} Y`,
                    barSize: BarSizeSetting.DAYS_ONE,
                    whatToShow: 'ADJUSTED_LAST',
                    useRTH: true,
                    partialOk: false,
                });
                await upsertBars(symbol, '1 day adj', daily);
                progress(`${symbol}: ${daily.length} daily ADJUSTED_LAST bars stored ('1 day adj')`);
            } catch (err) {
                logger.warn(`[DataArchive] ${symbol}: daily ADJUSTED_LAST fetch failed: ${err}`);
            }
            await sleep(paceMs);
        }

        result.bars[symbol] = failed && written === 0 ? -1 : written;
    }

    return result;
}

/**
 * Close the archive database connection.
 */
export function closeArchiveDb(): void {
    if (db) {
        db.close();
        db = null;
    }
}
