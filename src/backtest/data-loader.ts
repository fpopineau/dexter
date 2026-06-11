/**
 * Backtest data loader — loads historical OHLCV bars from FirstRate ZIP
 * archives or from the local data-archive SQLite database.
 *
 * FirstRate data format:
 *   ZIP per letter (stock-A.zip … stock-Z.zip), each containing
 *   one {TICKER}.txt CSV: DateTime,Open,High,Low,Close,Volume
 *   1-minute bars, US Eastern Time, split+dividend adjusted.
 */

import type { OHLCV } from '@/tools/ibkr/ta-indicators.js';
import { logger } from '@/utils';
import AdmZip from 'adm-zip';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single OHLCV bar (row-oriented, used during loading). */
export interface Bar {
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface LoadOptions {
    /** Start date (inclusive), ISO or 'YYYY-MM-DD'. */
    startDate?: string;
    /** End date (inclusive), ISO or 'YYYY-MM-DD'. */
    endDate?: string;
    /**
     * Resample to a coarser timeframe.
     * '1m' (no resampling), '5m', '15m', '30m', '1h', '1d'.
     * Default: '5m'.
     */
    timeframe?: string;
}

// ---------------------------------------------------------------------------
// FirstRate ZIP loader
// ---------------------------------------------------------------------------

const DEFAULT_FIRSTRATE_DIR =
    process.env.FIRSTRATE_DATA_DIR || join('ActivTradesFX', 'data', 'FirstRate', 'stock');

/**
 * Load 1-minute bars for a ticker from FirstRate ZIP archives.
 *
 * @param ticker  e.g. 'AAPL'
 * @param options date range and resampling
 * @param dataDir override FirstRate directory (default: ActivTradesFX/data/FirstRate/stock/)
 */
export function loadFirstRate(
    ticker: string,
    options: LoadOptions = {},
    dataDir: string = DEFAULT_FIRSTRATE_DIR,
): Bar[] {
    const symbol = ticker.toUpperCase();
    const letter = symbol.charAt(0);
    const zipPath = join(dataDir, `stock-${letter}.zip`);

    if (!existsSync(zipPath)) {
        throw new Error(`[data-loader] ZIP not found: ${zipPath}`);
    }

    logger.info(`[data-loader] Loading ${symbol} from ${zipPath}`);
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntry(`${symbol}.txt`);

    if (!entry) {
        throw new Error(`[data-loader] Ticker ${symbol}.txt not found in ${zipPath}`);
    }

    const csv = entry.getData().toString('utf-8');
    const bars = parseCsv(csv, options.startDate, options.endDate);

    logger.info(`[data-loader] Loaded ${bars.length} 1-min bars for ${symbol}`);

    const tf = options.timeframe ?? '5m';
    if (tf === '1m') return bars;
    return resample(bars, tf);
}

/**
 * Load bars from the local data-archive SQLite database.
 */
export async function loadArchive(
    ticker: string,
    barSize: string,
    options: LoadOptions = {},
): Promise<Bar[]> {
    const { openSqliteReadonly } = await getArchiveDb();
    const db = await openSqliteReadonly();

    const symbol = ticker.toUpperCase();
    let sql = `SELECT time, open, high, low, close, volume FROM bars WHERE symbol = ? AND bar_size = ?`;
    const params: unknown[] = [symbol, barSize];

    if (options.startDate) {
        sql += ` AND time >= ?`;
        params.push(options.startDate);
    }
    if (options.endDate) {
        sql += ` AND time <= ?`;
        params.push(options.endDate);
    }
    sql += ` ORDER BY time ASC`;

    const rows = db.query<Bar>(sql).all(...params);
    db.close();

    const tf = options.timeframe;
    if (!tf || tf === barSize) return rows;
    return resample(rows, tf);
}

// ---------------------------------------------------------------------------
// SQLite helper (reuses data-archive pattern)
// ---------------------------------------------------------------------------

interface SqliteQuery<T> {
    all(...params: unknown[]): T[];
}

interface SqliteDatabase {
    query<T>(sql: string): SqliteQuery<T>;
    close(): void;
}

async function getArchiveDb() {
    const dbPath = process.env.DATA_ARCHIVE_PATH ?? join('.dexter', 'data', 'market-archive.db');

    async function openSqliteReadonly(): Promise<SqliteDatabase> {
        try {
            const sqlite = await import('bun:sqlite');
            const DatabaseCtor = sqlite.Database as new (path: string, opts?: { readonly?: boolean }) => SqliteDatabase;
            return new DatabaseCtor(dbPath, { readonly: true });
        } catch {
            const mod = await import('better-sqlite3');
            const Database = mod.default;
            const raw = new Database(dbPath, { readonly: true });
            return {
                query: <T>(sql: string): SqliteQuery<T> => {
                    const stmt = raw.prepare(sql);
                    return { all: (...params: unknown[]) => stmt.all(...params) as T[] };
                },
                close: () => raw.close(),
            };
        }
    }

    return { openSqliteReadonly };
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Parse FirstRate CSV format:
 *   DateTime,Open,High,Low,Close,Volume
 *   2020-01-02 09:30:00,300.12,300.50,299.80,300.25,52340
 */
function parseCsv(csv: string, startDate?: string, endDate?: string): Bar[] {
    const bars: Bar[] = [];
    const lines = csv.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('DateTime')) continue; // skip header if present

        const parts = line.split(',');
        if (parts.length < 6) continue;

        const time = parts[0];

        // Date filtering (string comparison works for ISO dates)
        if (startDate && time < startDate) continue;
        if (endDate && time > endDate + ' 23:59:59') continue;

        const open = Number(parts[1]);
        const high = Number(parts[2]);
        const low = Number(parts[3]);
        const close = Number(parts[4]);
        const volume = Number(parts[5]);

        if (Number.isNaN(close)) continue;

        bars.push({ time, open, high, low, close, volume });
    }

    return bars;
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

const TIMEFRAME_MINUTES: Record<string, number> = {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '4h': 240,
    '1d': 1440,
};

/**
 * Resample 1-minute bars to a coarser timeframe.
 * Groups by floored time bucket and aggregates OHLCV.
 */
export function resample(bars: Bar[], timeframe: string): Bar[] {
    const minutes = TIMEFRAME_MINUTES[timeframe];
    if (!minutes || minutes <= 1) return bars;

    if (timeframe === '1d') return resampleDaily(bars);

    const result: Bar[] = [];
    let bucket: Bar | null = null;
    let bucketKey = '';

    for (const bar of bars) {
        const key = getBucketKey(bar.time, minutes);
        if (key !== bucketKey) {
            if (bucket) result.push(bucket);
            bucket = { ...bar };
            bucketKey = key;
        } else if (bucket) {
            bucket.high = Math.max(bucket.high, bar.high);
            bucket.low = Math.min(bucket.low, bar.low);
            bucket.close = bar.close;
            bucket.volume += bar.volume;
        }
    }
    if (bucket) result.push(bucket);

    return result;
}

function getBucketKey(time: string, minutes: number): string {
    // Parse "YYYY-MM-DD HH:MM:SS" without Date object overhead
    const hour = Number(time.substring(11, 13));
    const min = Number(time.substring(14, 16));
    const totalMin = hour * 60 + min;
    const floored = Math.floor(totalMin / minutes) * minutes;
    const h = String(Math.floor(floored / 60)).padStart(2, '0');
    const m = String(floored % 60).padStart(2, '0');
    return time.substring(0, 10) + ' ' + h + ':' + m;
}

function resampleDaily(bars: Bar[]): Bar[] {
    const result: Bar[] = [];
    let current: Bar | null = null;
    let currentDate = '';

    for (const bar of bars) {
        const date = bar.time.substring(0, 10);
        if (date !== currentDate) {
            if (current) result.push(current);
            current = { ...bar, time: date };
            currentDate = date;
        } else if (current) {
            current.high = Math.max(current.high, bar.high);
            current.low = Math.min(current.low, bar.low);
            current.close = bar.close;
            current.volume += bar.volume;
        }
    }
    if (current) result.push(current);
    return result;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert row-oriented bars to the columnar OHLCV format used by ta-indicators.
 */
export function barsToOHLCV(bars: Bar[]): OHLCV {
    const time: string[] = [];
    const open: number[] = [];
    const high: number[] = [];
    const low: number[] = [];
    const close: number[] = [];
    const volume: number[] = [];

    for (const b of bars) {
        time.push(b.time);
        open.push(b.open);
        high.push(b.high);
        low.push(b.low);
        close.push(b.close);
        volume.push(b.volume);
    }

    return { time, open, high, low, close, volume };
}

/**
 * Get list of available tickers in a FirstRate ZIP.
 */
export function listFirstRateTickers(
    letter: string,
    dataDir: string = DEFAULT_FIRSTRATE_DIR,
): string[] {
    const zipPath = join(dataDir, `stock-${letter.toUpperCase()}.zip`);
    if (!existsSync(zipPath)) return [];
    const zip = new AdmZip(zipPath);
    return zip
        .getEntries()
        .map((e) => e.entryName.replace('.txt', ''))
        .filter((n) => n.length > 0)
        .sort();
}

/**
 * Load the master ticker list from FirstRate's stock.txt.
 */
export function loadTickerList(dataDir: string = DEFAULT_FIRSTRATE_DIR): string[] {
    const listPath = join(dataDir, '..', 'stock.txt');
    if (!existsSync(listPath)) return [];
    return readFileSync(listPath, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}
