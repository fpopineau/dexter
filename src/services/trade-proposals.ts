/**
 * Trade proposal store — persisted, human-actionable trade recommendations.
 *
 * Lifecycle: open → executed | rejected | expired | failed
 * The LLM may CREATE proposals; only a human can accept one (via the
 * WhatsApp command router or the approval-gated accept_proposal tool).
 *
 * Storage: SQLite at DEXTER_DATA_DIR/proposals.db.
 */

import { logger } from '@/utils';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ProposalStatus = 'open' | 'executed' | 'rejected' | 'expired' | 'failed';

export interface TradeProposal {
    id: string;
    createdAt: number;
    expiresAt: number;
    updatedAt: number;
    status: ProposalStatus;
    symbol: string;
    direction: 'long' | 'short';
    entryType: 'LMT' | 'MKT';
    entry: number | null;
    stop: number;
    target: number;
    quantity: number;
    score: number | null;
    rationale: string;
    /** Who created it: cron job name, 'trigger', 'tui', … */
    source: string;
    /** Set after execution: parent/takeProfit/stop order ids. */
    orderIds: number[] | null;
    /** Failure or rejection detail. */
    note: string | null;
}

const DEFAULT_EXPIRY_MIN = 120;

// ---------------------------------------------------------------------------
// SQLite (dual-driver pattern shared with the other services)
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

async function getDb(): Promise<SqliteDatabase> {
    if (db) return db;
    const dbDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
    const dbPath = join(dbDir, 'proposals.db');
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
        CREATE TABLE IF NOT EXISTS proposals (
            id          TEXT PRIMARY KEY,
            created_at  INTEGER NOT NULL,
            expires_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL,
            status      TEXT NOT NULL,
            symbol      TEXT NOT NULL,
            direction   TEXT NOT NULL,
            entry_type  TEXT NOT NULL,
            entry       REAL,
            stop        REAL NOT NULL,
            target      REAL NOT NULL,
            quantity    INTEGER NOT NULL,
            score       REAL,
            rationale   TEXT NOT NULL,
            source      TEXT NOT NULL,
            order_ids   TEXT,
            note        TEXT
        );
    `);
    return db;
}

interface Row {
    id: string;
    created_at: number;
    expires_at: number;
    updated_at: number;
    status: ProposalStatus;
    symbol: string;
    direction: 'long' | 'short';
    entry_type: 'LMT' | 'MKT';
    entry: number | null;
    stop: number;
    target: number;
    quantity: number;
    score: number | null;
    rationale: string;
    source: string;
    order_ids: string | null;
    note: string | null;
}

function fromRow(r: Row): TradeProposal {
    return {
        id: r.id,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        updatedAt: r.updated_at,
        status: r.status,
        symbol: r.symbol,
        direction: r.direction,
        entryType: r.entry_type,
        entry: r.entry,
        stop: r.stop,
        target: r.target,
        quantity: r.quantity,
        score: r.score,
        rationale: r.rationale,
        source: r.source,
        orderIds: r.order_ids ? (JSON.parse(r.order_ids) as number[]) : null,
        note: r.note,
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateProposalInput {
    symbol: string;
    direction: 'long' | 'short';
    entryType: 'LMT' | 'MKT';
    entry?: number;
    stop: number;
    target: number;
    quantity: number;
    score?: number;
    rationale: string;
    source: string;
    expiresMinutes?: number;
}

export async function createProposal(input: CreateProposalInput): Promise<TradeProposal> {
    const database = await getDb();
    const now = Date.now();
    const expiry = now + (input.expiresMinutes ?? DEFAULT_EXPIRY_MIN) * 60_000;

    let id = '';
    for (let attempt = 0; attempt < 5; attempt++) {
        id = `P-${randomBytes(2).toString('hex').toUpperCase()}`;
        const clash = database.query<Row>(`SELECT id FROM proposals WHERE id = ?`).all(id);
        if (clash.length === 0) break;
        id = '';
    }
    if (!id) throw new Error('[proposals] could not allocate a unique id');

    database.query<void>(
        `INSERT INTO proposals
         (id, created_at, expires_at, updated_at, status, symbol, direction, entry_type,
          entry, stop, target, quantity, score, rationale, source, order_ids, note)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
        id, now, expiry, now,
        input.symbol.trim().toUpperCase(), input.direction, input.entryType,
        input.entry ?? null, input.stop, input.target, input.quantity,
        input.score ?? null, input.rationale, input.source,
    );

    logger.info(`[proposals] created ${id}: ${input.direction} ${input.quantity} ${input.symbol} (source: ${input.source})`);
    const created = await getProposal(id);
    if (!created) throw new Error(`[proposals] just-created ${id} not found`);
    return created;
}

export async function getProposal(id: string): Promise<TradeProposal | null> {
    const database = await getDb();
    const rows = database.query<Row>(`SELECT * FROM proposals WHERE id = ?`).all(id.trim().toUpperCase());
    return rows.length ? fromRow(rows[0]) : null;
}

export async function listProposals(status?: ProposalStatus, limit = 20): Promise<TradeProposal[]> {
    const database = await getDb();
    await expireStale();
    const rows = status
        ? database.query<Row>(`SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit)
        : database.query<Row>(`SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?`).all(limit);
    return rows.map(fromRow);
}

export async function setProposalStatus(
    id: string,
    status: ProposalStatus,
    extra?: { orderIds?: number[]; note?: string },
): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET status = ?, updated_at = ?, order_ids = COALESCE(?, order_ids), note = COALESCE(?, note) WHERE id = ?`,
    ).run(
        status,
        Date.now(),
        extra?.orderIds ? JSON.stringify(extra.orderIds) : null,
        extra?.note ?? null,
        id.trim().toUpperCase(),
    );
}

/** Mark all overdue open proposals as expired. */
export async function expireStale(): Promise<number> {
    const database = await getDb();
    const now = Date.now();
    const stale = database.query<Row>(`SELECT id FROM proposals WHERE status = 'open' AND expires_at < ?`).all(now);
    for (const r of stale) {
        database.query<void>(`UPDATE proposals SET status = 'expired', updated_at = ? WHERE id = ?`).run(now, r.id);
    }
    if (stale.length) logger.info(`[proposals] expired ${stale.length} stale proposal(s)`);
    return stale.length;
}

/** One-line human summary (used in WhatsApp messages). */
export function formatProposalLine(p: TradeProposal): string {
    const entry = p.entryType === 'MKT' ? 'MKT' : `@${p.entry}`;
    return `${p.id} ${p.direction.toUpperCase()} ${p.quantity} ${p.symbol} ${entry} stop ${p.stop} target ${p.target}` +
        (p.score != null ? ` (score ${p.score})` : '') + ` [${p.status}]`;
}
