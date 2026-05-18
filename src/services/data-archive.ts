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
 * Fetch historical bars for a single symbol and upsert into SQLite.
 * Returns the number of bars written.
 */
async function archiveSymbol(
    symbol: string,
    barSize: BarSizeSetting,
    barSizeLabel: string,
    duration: string,
    whatToShow: string,
    useRTH: boolean,
): Promise<number> {
    const api = await getIBApi();
    const reqId = allocReqId();
    const database = await getDb();

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
            resolve(); // partial is fine
        }, 30_000);

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
            '', // empty = now
            duration,
            barSize,
            whatToShow as WhatToShow,
            useRTH ? 1 : 0,
            1, // formatDate
            false, // keepUpToDate
        );
    });

    // Upsert bars into SQLite
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

/**
 * Close the archive database connection.
 */
export function closeArchiveDb(): void {
    if (db) {
        db.close();
        db = null;
    }
}
