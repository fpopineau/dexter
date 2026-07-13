/**
 * Trade proposal store — persisted, human-actionable trade recommendations.
 *
 * Lifecycle: open → executed → closed
 *                 ↘ rejected | expired | failed
 * The LLM may CREATE proposals; only a human can accept one (via the
 * WhatsApp command router or the approval-gated accept_proposal tool).
 * Creation passes the deterministic risk gate (proposal-risk-gate.ts):
 * proposals violating risk-rules.yaml are never persisted.
 *
 * Once executed, the outcome tracker (outcome-tracker.ts) watches the
 * bracket's fills and closes the proposal with exit reason and realized
 * P&L — the labeled-outcome record that performance reporting and future
 * ML training are built on.
 *
 * Storage: SQLite at DEXTER_DATA_DIR/proposals.db.
 */

import { logger } from '@/utils';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertProposalRisk } from './proposal-risk-gate.js';

export type ProposalStatus = 'open' | 'executed' | 'closed' | 'rejected' | 'expired' | 'failed';

/** How an executed trade ended. */
export type ExitReason = 'target' | 'stop' | 'cancelled' | 'manual' | 'unknown';

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
    // --- Outcome fields (populated by the outcome tracker) ---
    /** When the bracket was placed. */
    executedAt: number | null;
    /** Average fill price of the entry order. */
    entryFillPrice: number | null;
    entryFilledAt: number | null;
    /** Average fill price of the exit (target or stop). */
    exitFillPrice: number | null;
    /** How the trade ended: target | stop | cancelled | manual | unknown. */
    exitReason: ExitReason | null;
    /** Gross realized P&L in USD ((exit − entry) × qty, sign-adjusted). */
    realizedPnl: number | null;
    /** Commissions reported by IBKR for the tracked executions. */
    commissions: number | null;
    closedAt: number | null;
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
    migrate(db);
    return db;
}

/** Outcome columns added after the initial release; ALTER is idempotent-by-catch. */
const OUTCOME_COLUMNS: Array<[string, string]> = [
    ['executed_at', 'INTEGER'],
    ['entry_fill_price', 'REAL'],
    ['entry_filled_at', 'INTEGER'],
    ['exit_fill_price', 'REAL'],
    ['exit_reason', 'TEXT'],
    ['realized_pnl', 'REAL'],
    ['commissions', 'REAL'],
    ['closed_at', 'INTEGER'],
];

function migrate(database: SqliteDatabase): void {
    for (const [name, type] of OUTCOME_COLUMNS) {
        try {
            database.exec(`ALTER TABLE proposals ADD COLUMN ${name} ${type}`);
        } catch {
            // column already exists
        }
    }
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
    executed_at: number | null;
    entry_fill_price: number | null;
    entry_filled_at: number | null;
    exit_fill_price: number | null;
    exit_reason: ExitReason | null;
    realized_pnl: number | null;
    commissions: number | null;
    closed_at: number | null;
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
        executedAt: r.executed_at ?? null,
        entryFillPrice: r.entry_fill_price ?? null,
        entryFilledAt: r.entry_filled_at ?? null,
        exitFillPrice: r.exit_fill_price ?? null,
        exitReason: r.exit_reason ?? null,
        realizedPnl: r.realized_pnl ?? null,
        commissions: r.commissions ?? null,
        closedAt: r.closed_at ?? null,
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
    // Deterministic risk gate — a proposal violating risk-rules.yaml is never
    // persisted, regardless of who created it (LLM, cron, TUI, script).
    assertProposalRisk({
        symbol: input.symbol,
        direction: input.direction,
        entryType: input.entryType,
        entry: input.entry ?? null,
        stop: input.stop,
        target: input.target,
        quantity: input.quantity,
    });

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
    extra?: { orderIds?: number[]; note?: string; executedAt?: number },
): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET status = ?, updated_at = ?, order_ids = COALESCE(?, order_ids),
                note = COALESCE(?, note), executed_at = COALESCE(?, executed_at) WHERE id = ?`,
    ).run(
        status,
        Date.now(),
        extra?.orderIds ? JSON.stringify(extra.orderIds) : null,
        extra?.note ?? null,
        extra?.executedAt ?? null,
        id.trim().toUpperCase(),
    );
}

// ---------------------------------------------------------------------------
// Outcome lifecycle (called by the outcome tracker)
// ---------------------------------------------------------------------------

/** Record the entry order's fill. */
export async function markEntryFilled(id: string, price: number, at = Date.now()): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET entry_fill_price = ?, entry_filled_at = ?, updated_at = ? WHERE id = ?`,
    ).run(price, at, Date.now(), id.trim().toUpperCase());
}

export interface CloseProposalInput {
    exitReason: ExitReason;
    exitFillPrice?: number;
    realizedPnl?: number;
    commissions?: number;
    closedAt?: number;
    note?: string;
}

/** Terminal transition: executed → closed, with the outcome record. */
export async function closeProposal(id: string, input: CloseProposalInput): Promise<void> {
    const database = await getDb();
    const now = Date.now();
    database.query<void>(
        `UPDATE proposals SET status = 'closed', closed_at = ?, exit_reason = ?,
                exit_fill_price = COALESCE(?, exit_fill_price),
                realized_pnl = COALESCE(?, realized_pnl),
                commissions = COALESCE(?, commissions),
                note = COALESCE(?, note),
                updated_at = ?
         WHERE id = ? AND status = 'executed'`,
    ).run(
        input.closedAt ?? now,
        input.exitReason,
        input.exitFillPrice ?? null,
        input.realizedPnl ?? null,
        input.commissions ?? null,
        input.note ?? null,
        now,
        id.trim().toUpperCase(),
    );
    logger.info(`[proposals] closed ${id.toUpperCase()} (${input.exitReason}, pnl ${input.realizedPnl ?? '?'})`);
}

/** Executed proposals that have not been closed — what the tracker watches. */
export async function listTrackable(): Promise<TradeProposal[]> {
    const database = await getDb();
    const rows = database.query<Row>(
        `SELECT * FROM proposals WHERE status = 'executed' ORDER BY executed_at ASC`,
    ).all();
    return rows.map(fromRow);
}

/** Executed-and-not-closed count — the system's notion of open exposure. */
export async function countOpenExecuted(): Promise<number> {
    const database = await getDb();
    const rows = database.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM proposals WHERE status = 'executed'`,
    ).all();
    return rows[0]?.n ?? 0;
}

/** Start of the current America/New_York day in epoch ms. */
export function etDayStartMs(now = Date.now()): number {
    const et = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const msSinceMidnight =
        et.getHours() * 3_600_000 + et.getMinutes() * 60_000 + et.getSeconds() * 1_000 + et.getMilliseconds();
    return now - msSinceMidnight;
}

/** Proposals executed since the given epoch ms (includes already-closed ones). */
export async function countExecutedSince(sinceMs: number): Promise<number> {
    const database = await getDb();
    const rows = database.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM proposals
         WHERE status IN ('executed', 'closed') AND executed_at >= ?`,
    ).all(sinceMs);
    return rows[0]?.n ?? 0;
}

/** Distinct symbols with proposals created since the given epoch ms. */
export async function listProposalSymbolsSince(sinceMs: number): Promise<string[]> {
    const database = await getDb();
    const rows = database.query<{ symbol: string }>(
        `SELECT DISTINCT symbol FROM proposals WHERE created_at >= ?`,
    ).all(sinceMs);
    return rows.map((r) => r.symbol);
}

// ---------------------------------------------------------------------------
// Performance reporting
// ---------------------------------------------------------------------------

export interface PerformanceSummary {
    sinceMs: number;
    closed: number;
    wins: number;
    losses: number;
    flat: number;
    /** Trades closed without a measurable P&L (cancelled, manual, unknown). */
    unlabeled: number;
    winRatePct: number | null;
    grossPnl: number;
    commissions: number;
    netPnl: number;
    best: { id: string; symbol: string; pnl: number } | null;
    worst: { id: string; symbol: string; pnl: number } | null;
    byExitReason: Record<string, number>;
    openExecuted: number;
    openProposals: number;
}

/** Aggregate closed-trade outcomes since the given epoch ms. */
export async function getPerformanceSummary(sinceMs: number): Promise<PerformanceSummary> {
    const database = await getDb();
    const rows = database.query<Row>(
        `SELECT * FROM proposals WHERE status = 'closed' AND closed_at >= ? ORDER BY closed_at ASC`,
    ).all(sinceMs).map(fromRow);

    let wins = 0, losses = 0, flat = 0, unlabeled = 0;
    let grossPnl = 0, commissions = 0;
    let best: PerformanceSummary['best'] = null;
    let worst: PerformanceSummary['worst'] = null;
    const byExitReason: Record<string, number> = {};

    for (const p of rows) {
        byExitReason[p.exitReason ?? 'unknown'] = (byExitReason[p.exitReason ?? 'unknown'] ?? 0) + 1;
        if (p.realizedPnl == null) {
            unlabeled++;
            continue;
        }
        grossPnl += p.realizedPnl;
        commissions += p.commissions ?? 0;
        if (p.realizedPnl > 0) wins++;
        else if (p.realizedPnl < 0) losses++;
        else flat++;
        if (!best || p.realizedPnl > best.pnl) best = { id: p.id, symbol: p.symbol, pnl: p.realizedPnl };
        if (!worst || p.realizedPnl < worst.pnl) worst = { id: p.id, symbol: p.symbol, pnl: p.realizedPnl };
    }

    const decided = wins + losses;
    return {
        sinceMs,
        closed: rows.length,
        wins,
        losses,
        flat,
        unlabeled,
        winRatePct: decided > 0 ? Math.round((wins / decided) * 1000) / 10 : null,
        grossPnl: Math.round(grossPnl * 100) / 100,
        commissions: Math.round(commissions * 100) / 100,
        netPnl: Math.round((grossPnl - commissions) * 100) / 100,
        best,
        worst,
        byExitReason,
        openExecuted: await countOpenExecuted(),
        openProposals: (await listProposals('open', 100)).length,
    };
}

/** Human-readable performance report (WhatsApp / brief friendly). */
export function formatPerformanceReport(s: PerformanceSummary, label: string): string {
    if (s.closed === 0 && s.openExecuted === 0) {
        return `📊 Performance (${label}): no closed trades, nothing executing.`;
    }
    const sign = (n: number) => (n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`);
    const lines = [
        `📊 Performance (${label}): ${s.closed} closed, ${s.wins}W/${s.losses}L` +
        (s.winRatePct != null ? ` (${s.winRatePct}% win rate)` : '') +
        (s.unlabeled ? `, ${s.unlabeled} without P&L` : ''),
        `Net P&L ${sign(s.netPnl)} (gross ${sign(s.grossPnl)}, commissions $${s.commissions.toFixed(2)})`,
    ];
    if (s.best) lines.push(`Best: ${s.best.symbol} ${sign(s.best.pnl)} (${s.best.id})`);
    if (s.worst && s.worst.id !== s.best?.id) lines.push(`Worst: ${s.worst.symbol} ${sign(s.worst.pnl)} (${s.worst.id})`);
    const reasons = Object.entries(s.byExitReason).map(([r, n]) => `${r} ${n}`).join(', ');
    if (reasons) lines.push(`Exits: ${reasons}`);
    if (s.openExecuted > 0) lines.push(`Still executing: ${s.openExecuted}`);
    if (s.openProposals > 0) lines.push(`Open proposals: ${s.openProposals}`);
    return lines.join('\n');
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
    const entry = p.entryType === 'MKT' ? `MKT~${p.entry ?? '?'}` : `@${p.entry}`;
    const outcome = p.status === 'closed' && p.realizedPnl != null
        ? ` ${p.exitReason ?? '?'} ${p.realizedPnl >= 0 ? '+' : ''}$${p.realizedPnl.toFixed(2)}`
        : '';
    return `${p.id} ${p.direction.toUpperCase()} ${p.quantity} ${p.symbol} ${entry} stop ${p.stop} target ${p.target}` +
        (p.score != null ? ` (score ${p.score})` : '') + ` [${p.status}${outcome}]`;
}
