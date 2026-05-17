/**
 * IBKR Streaming Service — subscribes to real-time 5-second bars and
 * maintains an in-memory ring buffer per symbol. Optionally persists bars
 * to SQLite for offline analysis.
 *
 * Lifecycle: start() → runs until stop() is called.
 * Other tools/services query the buffer via getLatestBars() / getLatestPrice().
 */

import { allocReqId, getIBApi } from '@/tools/ibkr/connection.js';
import { logger } from '@/utils';
import { Contract, EventName, SecType, WhatToShow } from '@stoqey/ib';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamBar {
    time: number;   // Unix seconds
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    wap: number;
    count: number;
}

interface SymbolState {
    reqId: number;
    symbol: string;
    bars: StreamBar[];     // ring buffer (newest at end)
    maxBars: number;
    lastPrice: number;
    lastUpdate: number;    // Date.now()
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const subscriptions = new Map<string, SymbolState>();
let running = false;

// ---------------------------------------------------------------------------
// SQLite persistence (optional, lazy init)
// ---------------------------------------------------------------------------

interface SqliteQuery<T> {
    all(...params: unknown[]): T[];
    run(...params: unknown[]): void;
}

interface SqliteDatabase {
    exec(sql: string): void;
    query<T>(sql: string): SqliteQuery<T>;
    close(): void;
}

let db: SqliteDatabase | null = null;

async function getDb(): Promise<SqliteDatabase | null> {
    if (db) return db;
    const dbDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
    const dbPath = join(dbDir, 'stream-bars.db');
    try {
        await mkdir(dirname(dbPath), { recursive: true });
        try {
            const sqlite = await import('bun:sqlite');
            const DatabaseCtor = sqlite.Database as new (p: string) => SqliteDatabase;
            db = new DatabaseCtor(dbPath);
        } catch {
            const mod = await import('better-sqlite3');
            const Database = mod.default;
            const raw = new Database(dbPath);
            db = {
                exec: (sql: string) => raw.exec(sql),
                query: <T>(sql: string): SqliteQuery<T> => {
                    const stmt = raw.prepare(sql);
                    return {
                        all: (...params: unknown[]) => stmt.all(...params) as T[],
                        run: (...params: unknown[]) => { stmt.run(...params); },
                    };
                },
                close: () => raw.close(),
            };
        }
        db.exec(`
            CREATE TABLE IF NOT EXISTS stream_bars (
                symbol TEXT NOT NULL,
                time   INTEGER NOT NULL,
                open   REAL, high REAL, low REAL, close REAL,
                volume REAL, wap REAL, count INTEGER,
                PRIMARY KEY (symbol, time)
            );
        `);
        return db;
    } catch (err) {
        logger.warn(`[ibkr-stream] SQLite init failed, running in-memory only: ${err}`);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------

async function subscribe(symbol: string, maxBars = 2000): Promise<void> {
    if (subscriptions.has(symbol)) return;

    const api = await getIBApi();
    const reqId = allocReqId();

    const contract: Contract = {
        symbol,
        secType: SecType.STK,
        exchange: 'SMART',
        currency: 'USD',
    };

    const state: SymbolState = {
        reqId,
        symbol,
        bars: [],
        maxBars,
        lastPrice: 0,
        lastUpdate: 0,
    };
    subscriptions.set(symbol, state);

    api.on(EventName.realtimeBar, (
        id: number,
        date: number,
        open: number,
        high: number,
        low: number,
        close: number,
        volume: number,
        WAP: number,
        count: number,
    ) => {
        if (id !== reqId) return;
        const bar: StreamBar = { time: date, open, high, low, close, volume, wap: WAP, count };
        state.bars.push(bar);
        if (state.bars.length > state.maxBars) {
            state.bars.shift();
        }
        state.lastPrice = close;
        state.lastUpdate = Date.now();

        // Async persist (fire-and-forget)
        void persistBar(symbol, bar);
    });

    // Request 5-second real-time bars
    api.reqRealTimeBars(
        reqId,
        contract,
        5,                  // barSize (always 5s)
        WhatToShow.TRADES,
        false,              // useRTH = false → include extended hours
    );

    logger.info(`[ibkr-stream] Subscribed to ${symbol} (reqId=${reqId})`);
}

async function unsubscribe(symbol: string): Promise<void> {
    const state = subscriptions.get(symbol);
    if (!state) return;

    try {
        const api = await getIBApi();
        api.cancelRealTimeBars(state.reqId);
    } catch { /* connection may be gone */ }

    subscriptions.delete(symbol);
    logger.info(`[ibkr-stream] Unsubscribed from ${symbol}`);
}

async function persistBar(symbol: string, bar: StreamBar): Promise<void> {
    try {
        const database = await getDb();
        if (!database) return;
        database.query<void>(
            `INSERT OR REPLACE INTO stream_bars (symbol, time, open, high, low, close, volume, wap, count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(symbol, bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.wap, bar.count);
    } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the streaming service for a list of symbols.
 * Idempotent — symbols already subscribed are skipped.
 */
export async function start(symbols: string[]): Promise<void> {
    if (running && symbols.length === 0) return;
    running = true;
    for (const sym of symbols) {
        await subscribe(sym.toUpperCase());
    }
}

/**
 * Stop the streaming service and cancel all subscriptions.
 */
export async function stop(): Promise<void> {
    running = false;
    for (const symbol of [...subscriptions.keys()]) {
        await unsubscribe(symbol);
    }
    if (db) {
        db.close();
        db = null;
    }
}

/**
 * Add a symbol to the live stream (while running).
 */
export async function addSymbol(symbol: string): Promise<void> {
    await subscribe(symbol.toUpperCase());
}

/**
 * Remove a symbol from the live stream.
 */
export async function removeSymbol(symbol: string): Promise<void> {
    await unsubscribe(symbol.toUpperCase());
}

/**
 * Get the latest N bars for a symbol from the in-memory buffer.
 * Returns empty array if not subscribed.
 */
export function getLatestBars(symbol: string, count = 100): StreamBar[] {
    const state = subscriptions.get(symbol.toUpperCase());
    if (!state) return [];
    return state.bars.slice(-count);
}

/**
 * Get the most recent price for a symbol.
 * Returns null if not subscribed or no data yet.
 */
export function getLatestPrice(symbol: string): { price: number; updatedAt: number } | null {
    const state = subscriptions.get(symbol.toUpperCase());
    if (!state || state.lastUpdate === 0) return null;
    return { price: state.lastPrice, updatedAt: state.lastUpdate };
}

/**
 * Get all currently subscribed symbols.
 */
export function getSubscribedSymbols(): string[] {
    return [...subscriptions.keys()];
}

/**
 * Check if the streaming service is running.
 */
export function isStreaming(): boolean {
    return running;
}
