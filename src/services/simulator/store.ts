/**
 * Simulator store (REQ-SIM-001/007, live-loop WP2) — `simulator.db`, its
 * OWN file beside proposals.db (same data dir). Landing precision over the
 * SPEC's domain delta (which named proposals.db): a separate database keeps
 * the behavior store's schema untouched, two writers never contend on one
 * file, and REQ-SIM-007 becomes structural — nothing here can reach the
 * broker: no order ids, no permIds, no path into acceptProposal.
 *
 * One row per (variant, source kind, source id); a re-settle REPLACES it.
 * Same REQ-TEST-001 discipline as the proposals store: under tests the data
 * dir must be a temp dir.
 */

import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertTestDataDirIsTemp } from '../trade-proposals.js';
import type { SimBarSource } from './bars.js';
import type { SimOutcome } from './fill-model.js';

export type SimStatus = 'open' | 'settled' | 'unknown';

export interface SimTrade {
    id?: number;
    variant: string;
    sourceKind: 'proposal' | 'refusal';
    sourceId: string;
    symbol: string;
    direction: 'long' | 'short';
    tradeClass: 'intraday' | 'swing' | 'earnings-bet';
    entryType: 'LMT' | 'MKT' | 'STP_LMT';
    entry: number | null;
    entryLimit: number | null;
    stop: number;
    target: number | null;
    /** Rung-sized quantity (REQ-SIM-005). */
    quantity: number;
    tif: 'DAY' | 'GTC';
    /** Source creation, epoch ms. */
    createdAt: number;
    barSource: SimBarSource | null;
    /** ET-frame ms. */
    fillAt: number | null;
    fillPrice: number | null;
    exitAt: number | null;
    exitPrice: number | null;
    outcome: SimOutcome;
    commissions: number | null;
    netUsd: number | null;
    netR: number | null;
    status: SimStatus;
    biasNote: string;
    settledAt: number;
    horizonDays: number;
    note: string | null;
}

interface SqliteQuery<T> { all(...params: unknown[]): T[]; run(...params: unknown[]): void }
interface SqliteDatabase { exec(sql: string): void; query<T>(sql: string): SqliteQuery<T>; close(): void }

let db: SqliteDatabase | null = null;

export function simulatorDbPath(dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data')): string {
    return join(dataDir, 'simulator.db');
}

async function getDb(): Promise<SqliteDatabase> {
    if (db) return db;
    assertTestDataDirIsTemp(process.env.DEXTER_DATA_DIR, process.env.NODE_ENV, tmpdir());
    const dbPath = simulatorDbPath();
    await mkdir(dirname(dbPath), { recursive: true });
    try {
        const sqlite = await import('bun:sqlite');
        const DatabaseCtor = sqlite.Database as new (p: string) => SqliteDatabase;
        db = new DatabaseCtor(dbPath);
    } catch {
        const mod = await import('better-sqlite3');
        const raw = new mod.default(dbPath);
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
        CREATE TABLE IF NOT EXISTS sim_trades (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            variant      TEXT NOT NULL,
            source_kind  TEXT NOT NULL,
            source_id    TEXT NOT NULL,
            symbol       TEXT NOT NULL,
            direction    TEXT NOT NULL,
            trade_class  TEXT NOT NULL,
            entry_type   TEXT NOT NULL,
            entry        REAL,
            entry_limit  REAL,
            stop         REAL NOT NULL,
            target       REAL,
            quantity     INTEGER NOT NULL,
            tif          TEXT NOT NULL,
            created_at   INTEGER NOT NULL,
            bar_source   TEXT,
            fill_at      INTEGER,
            fill_price   REAL,
            exit_at      INTEGER,
            exit_price   REAL,
            outcome      TEXT NOT NULL,
            commissions  REAL,
            net_usd      REAL,
            net_r        REAL,
            status       TEXT NOT NULL,
            bias_note    TEXT NOT NULL,
            settled_at   INTEGER NOT NULL,
            horizon_days INTEGER NOT NULL,
            note         TEXT,
            UNIQUE (variant, source_kind, source_id)
        );
        CREATE INDEX IF NOT EXISTS ix_sim_trades_created ON sim_trades (created_at);
        CREATE INDEX IF NOT EXISTS ix_sim_trades_status ON sim_trades (status);
    `);
    return db;
}

interface Row {
    id: number; variant: string; source_kind: string; source_id: string; symbol: string; direction: string; trade_class: string;
    entry_type: string; entry: number | null; entry_limit: number | null; stop: number; target: number | null; quantity: number;
    tif: string; created_at: number; bar_source: string | null; fill_at: number | null; fill_price: number | null;
    exit_at: number | null; exit_price: number | null; outcome: string; commissions: number | null; net_usd: number | null;
    net_r: number | null; status: string; bias_note: string; settled_at: number; horizon_days: number; note: string | null;
}

function fromRow(r: Row): SimTrade {
    return {
        id: r.id,
        variant: r.variant,
        sourceKind: r.source_kind === 'refusal' ? 'refusal' : 'proposal',
        sourceId: r.source_id,
        symbol: r.symbol,
        direction: r.direction === 'short' ? 'short' : 'long',
        tradeClass: r.trade_class === 'swing' || r.trade_class === 'earnings-bet' ? r.trade_class : 'intraday',
        entryType: r.entry_type === 'MKT' || r.entry_type === 'STP_LMT' ? r.entry_type : 'LMT',
        entry: r.entry,
        entryLimit: r.entry_limit,
        stop: r.stop,
        target: r.target,
        quantity: r.quantity,
        tif: r.tif === 'GTC' ? 'GTC' : 'DAY',
        createdAt: r.created_at,
        barSource: (r.bar_source as SimBarSource | null) ?? null,
        fillAt: r.fill_at,
        fillPrice: r.fill_price,
        exitAt: r.exit_at,
        exitPrice: r.exit_price,
        outcome: r.outcome as SimOutcome,
        commissions: r.commissions,
        netUsd: r.net_usd,
        netR: r.net_r,
        status: (r.status as SimStatus) ?? 'unknown',
        biasNote: r.bias_note,
        settledAt: r.settled_at,
        horizonDays: r.horizon_days,
        note: r.note,
    };
}

export async function upsertSimTrade(t: SimTrade): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `INSERT INTO sim_trades (variant, source_kind, source_id, symbol, direction, trade_class, entry_type, entry, entry_limit, stop, target,
             quantity, tif, created_at, bar_source, fill_at, fill_price, exit_at, exit_price, outcome, commissions, net_usd, net_r, status,
             bias_note, settled_at, horizon_days, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(variant, source_kind, source_id) DO UPDATE SET
             symbol = excluded.symbol, direction = excluded.direction, trade_class = excluded.trade_class, entry_type = excluded.entry_type,
             entry = excluded.entry, entry_limit = excluded.entry_limit, stop = excluded.stop, target = excluded.target,
             quantity = excluded.quantity, tif = excluded.tif, created_at = excluded.created_at, bar_source = excluded.bar_source,
             fill_at = excluded.fill_at, fill_price = excluded.fill_price, exit_at = excluded.exit_at, exit_price = excluded.exit_price,
             outcome = excluded.outcome, commissions = excluded.commissions, net_usd = excluded.net_usd, net_r = excluded.net_r,
             status = excluded.status, bias_note = excluded.bias_note, settled_at = excluded.settled_at,
             horizon_days = excluded.horizon_days, note = excluded.note`,
    ).run(
        t.variant, t.sourceKind, t.sourceId, t.symbol.toUpperCase(), t.direction, t.tradeClass, t.entryType, t.entry, t.entryLimit, t.stop, t.target,
        t.quantity, t.tif, t.createdAt, t.barSource, t.fillAt, t.fillPrice, t.exitAt, t.exitPrice, t.outcome, t.commissions, t.netUsd, t.netR, t.status,
        t.biasNote, t.settledAt, t.horizonDays, t.note,
    );
}

export async function findSimTrade(variant: string, kind: 'proposal' | 'refusal', sourceId: string): Promise<SimTrade | null> {
    const database = await getDb();
    const rows = database.query<Row>(`SELECT * FROM sim_trades WHERE variant = ? AND source_kind = ? AND source_id = ?`).all(variant, kind, sourceId);
    return rows.length ? fromRow(rows[0]) : null;
}

export async function listSimTrades(filter: { sinceMs?: number; variant?: string; status?: SimStatus }): Promise<SimTrade[]> {
    const database = await getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.sinceMs !== undefined) { where.push('created_at >= ?'); params.push(filter.sinceMs); }
    if (filter.variant !== undefined) { where.push('variant = ?'); params.push(filter.variant); }
    if (filter.status !== undefined) { where.push('status = ?'); params.push(filter.status); }
    const sql = `SELECT * FROM sim_trades${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC, id ASC`;
    return database.query<Row>(sql).all(...params).map(fromRow);
}

export async function listOpenSimTrades(): Promise<SimTrade[]> {
    return listSimTrades({ status: 'open' });
}
