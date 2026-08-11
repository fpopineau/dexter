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
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertProposalRisk, type RiskGateContext } from './proposal-risk-gate.js';
import type { TradeClass } from '@/tools/ibkr/risk-rules.js';

export type ProposalStatus = 'open' | 'executing' | 'executed' | 'closed' | 'rejected' | 'expired' | 'failed';

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
    entryType: 'LMT' | 'MKT' | 'STP_LMT';
    entry: number | null;
    /** STP_LMT only: the limit cap above/below the trigger (entry). */
    entryLimit: number | null;
    stop: number;
    target: number;
    quantity: number;
    /** Bracket time-in-force: DAY (intraday, expires at the close) or GTC
     *  (overnight/swing — the bracket survives the close). */
    tif: 'DAY' | 'GTC';
    /** Trade class: 'intraday' (default), 'swing' (pattern trade, up to
     *  ~2 weeks), or 'earnings-bet' (deliberate hold through a print).
     *  Selects the risk budget/caps at the gate and tags the outcome
     *  ledger so each class accrues its own track record. */
    tradeClass: TradeClass;
    /** Earnings bets: the adverse post-print gap (%) the sizing assumed
     *  (worst historical move, floored at earnings_bet_gap_floor_pct).
     *  Null for other classes. */
    worstCaseGapPct: number | null;
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
    /** Set when an EOD keep converted this DAY position to a protected
     *  overnight hold (tif flipped to GTC, exits swapped to the protect
     *  pair). The proposal stays 'executed': still counted by the caps,
     *  still triaged daily, and the eventual GTC exit fill attributes its
     *  P&L here instead of vanishing (the orphaned-keep hole). */
    keptOvernightAt: number | null;
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
    // Hard guard: a test run must NEVER bind the production proposals DB.
    // The store caches its handle process-wide, so one test file importing
    // without isolation poisons the entire run — refuse loudly instead.
    if (process.env.NODE_ENV === 'test' && !process.env.DEXTER_DATA_DIR) {
        throw new Error('[proposals] refusing to open the production DB under NODE_ENV=test — set DEXTER_DATA_DIR to a temp dir first');
    }
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
    // Refusal ledger (benchmark phase 2): every gate/sizer refusal at
    // creation time, with the proposed levels — so the nightly benchmark
    // can replay each refusal against the day's bars and score the gates.
    db.exec(`
        CREATE TABLE IF NOT EXISTS refusals (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at  INTEGER NOT NULL,
            symbol      TEXT NOT NULL,
            direction   TEXT NOT NULL,
            entry_type  TEXT NOT NULL,
            entry       REAL,
            entry_limit REAL,
            stop        REAL,
            target      REAL,
            quantity    REAL,
            score       REAL,
            reason      TEXT NOT NULL,
            gate        TEXT NOT NULL,
            outcome     TEXT,
            outcome_note TEXT
        );
    `);
    migrate(db);
    return db;
}

// ---------------------------------------------------------------------------
// Refusal ledger (benchmark phase 2)
// ---------------------------------------------------------------------------

export interface RefusalRecord {
    id: number;
    createdAt: number;
    symbol: string;
    direction: 'long' | 'short';
    entryType: string;
    entry: number | null;
    entryLimit: number | null;
    stop: number | null;
    target: number | null;
    quantity: number | null;
    score: number | null;
    reason: string;
    /** Which gate refused — keyword-classified from the reason. */
    gate: string;
    /** Counterfactual outcome, filled by the nightly benchmark replay:
     *  'target' | 'stop' | 'unfilled' | 'open' | 'unknown'. */
    outcome: string | null;
    outcomeNote: string | null;
}

/** Keyword classification of a refusal reason into the gate that fired. */
export function classifyRefusalGate(reason: string): string {
    const r = reason.toLowerCase();
    if (r.includes('duplicate setup')) return 'duplicate';
    if (r.includes('intraday noise')) return 'noise-stop';
    if (r.includes('chasing an extended move')) return 'extension';
    if (r.includes('risk/reward')) return 'risk-reward';
    if (r.includes('risk budget') && r.includes('stop-out')) return 'risk-budget';
    if (r.includes('cannot afford') || r.includes('position cap')) return 'unaffordable';
    if (r.includes('budget') && r.includes('floor')) return 'sizer-floor';
    if (r.includes('minimum price')) return 'min-price';
    if (r.includes('positions already open')) return 'max-positions';
    if (r.includes('executed today')) return 'max-daily-trades';
    if (r.includes('sizer refused') || r.includes('stop distance')) return 'sizer';
    return 'other';
}

export async function recordRefusal(input: {
    symbol: string;
    direction: 'long' | 'short';
    entryType: string;
    entry?: number | null;
    entryLimit?: number | null;
    stop?: number | null;
    target?: number | null;
    quantity?: number | null;
    score?: number | null;
    reason: string;
}): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `INSERT INTO refusals (created_at, symbol, direction, entry_type, entry, entry_limit, stop, target, quantity, score, reason, gate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        Date.now(), input.symbol.trim().toUpperCase(), input.direction, input.entryType,
        input.entry ?? null, input.entryLimit ?? null, input.stop ?? null, input.target ?? null,
        input.quantity ?? null, input.score ?? null, input.reason.slice(0, 600), classifyRefusalGate(input.reason),
    );
}

interface RefusalRow {
    id: number; created_at: number; symbol: string; direction: string; entry_type: string;
    entry: number | null; entry_limit: number | null; stop: number | null; target: number | null;
    quantity: number | null; score: number | null; reason: string; gate: string;
    outcome: string | null; outcome_note: string | null;
}

export async function listRefusalsSince(sinceMs: number): Promise<RefusalRecord[]> {
    const database = await getDb();
    return database.query<RefusalRow>(
        `SELECT * FROM refusals WHERE created_at >= ? ORDER BY created_at ASC`,
    ).all(sinceMs).map((r) => ({
        id: r.id, createdAt: r.created_at, symbol: r.symbol,
        direction: r.direction as 'long' | 'short', entryType: r.entry_type,
        entry: r.entry, entryLimit: r.entry_limit, stop: r.stop, target: r.target,
        quantity: r.quantity, score: r.score, reason: r.reason, gate: r.gate,
        outcome: r.outcome, outcomeNote: r.outcome_note,
    }));
}

export async function setRefusalOutcome(id: number, outcome: string, note?: string): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE refusals SET outcome = ?, outcome_note = ? WHERE id = ?`,
    ).run(outcome, note ?? null, id);
}

/** Cumulative per-gate counterfactual scoreboard (evaluated refusals only). */
export async function getGateScoreboard(): Promise<Array<{ gate: string; total: number; wouldStop: number; wouldTarget: number; unfilled: number }>> {
    const database = await getDb();
    const rows = database.query<{ gate: string; outcome: string | null; n: number }>(
        `SELECT gate, outcome, COUNT(*) as n FROM refusals GROUP BY gate, outcome`,
    ).all();
    const byGate = new Map<string, { gate: string; total: number; wouldStop: number; wouldTarget: number; unfilled: number }>();
    for (const r of rows) {
        const g = byGate.get(r.gate) ?? { gate: r.gate, total: 0, wouldStop: 0, wouldTarget: 0, unfilled: 0 };
        g.total += r.n;
        if (r.outcome === 'stop') g.wouldStop += r.n;
        else if (r.outcome === 'target') g.wouldTarget += r.n;
        else if (r.outcome === 'unfilled') g.unfilled += r.n;
        byGate.set(r.gate, g);
    }
    return [...byGate.values()].sort((a, b) => b.total - a.total);
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
    ['tif', 'TEXT'],
    ['entry_limit', 'REAL'],
    ['claim_token', 'TEXT'],
    ['trade_class', 'TEXT'],
    ['worst_case_gap_pct', 'REAL'],
    ['kept_overnight_at', 'INTEGER'],
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
    entry_type: 'LMT' | 'MKT' | 'STP_LMT';
    entry: number | null;
    entry_limit: number | null;
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
    tif: string | null;
    trade_class: string | null;
    worst_case_gap_pct: number | null;
    realized_pnl: number | null;
    commissions: number | null;
    closed_at: number | null;
    kept_overnight_at: number | null;
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
        entryLimit: r.entry_limit ?? null,
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
        tif: r.tif === 'GTC' ? 'GTC' : 'DAY',
        tradeClass: (r.trade_class === 'swing' || r.trade_class === 'earnings-bet') ? r.trade_class : 'intraday',
        worstCaseGapPct: r.worst_case_gap_pct ?? null,
        realizedPnl: r.realized_pnl ?? null,
        commissions: r.commissions ?? null,
        closedAt: r.closed_at ?? null,
        keptOvernightAt: r.kept_overnight_at ?? null,
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateProposalInput {
    symbol: string;
    direction: 'long' | 'short';
    entryType: 'LMT' | 'MKT' | 'STP_LMT';
    entry?: number;
    /** Required for STP_LMT: the limit cap for the triggered entry. */
    entryLimit?: number;
    stop: number;
    target: number;
    quantity: number;
    /** DAY (default) or GTC for overnight/swing brackets. */
    tif?: 'DAY' | 'GTC';
    /** Trade class; defaults to 'intraday'. */
    tradeClass?: TradeClass;
    /** Earnings bets: worst historical adverse post-print move (%). */
    worstCaseGapPct?: number;
    score?: number;
    rationale: string;
    source: string;
    expiresMinutes?: number;
}

/** Entries within this fraction of an existing working bracket's entry on
 *  the same symbol are duplicates (the daily brief re-proposing yesterday's
 *  swing setup), not new trades. */
export const DUPLICATE_ENTRY_TOLERANCE = 0.02;

/**
 * Count real commitments of a trade class: proposals executing or executed
 * (not yet closed). Un-accepted 'open' proposals do not count — proposing
 * alternatives is free; the cap binds at acceptance.
 */
export async function countOpenByClass(tradeClass: TradeClass, excludeId?: string): Promise<number> {
    const database = await getDb();
    const rows = database.query<Row>(
        `SELECT * FROM proposals WHERE status IN ('executing', 'executed')`,
    ).all();
    return rows.map(fromRow).filter((t) => t.tradeClass === tradeClass && t.id !== excludeId).length;
}

export async function createProposal(
    input: CreateProposalInput,
    gateContext: RiskGateContext = {},
): Promise<TradeProposal> {
    // Duplicate-setup guard: an executed proposal on the same symbol with a
    // near-identical entry means this exact setup already has a working
    // bracket — creating another stacks orders, it does not add a trade.
    if (input.entry != null && input.entry > 0) {
        const dupe = (await listTrackable()).find((t) =>
            t.symbol === input.symbol.trim().toUpperCase() &&
            t.entry != null &&
            Math.abs(t.entry - input.entry!) / input.entry! < DUPLICATE_ENTRY_TOLERANCE);
        if (dupe) {
            throw new Error(
                `[risk-gate] REFUSED ${input.symbol.toUpperCase()}: duplicate setup — ${dupe.id} already has a ` +
                `working bracket at ${dupe.entry} (within ${DUPLICATE_ENTRY_TOLERANCE * 100}% of ${input.entry}). ` +
                `Cancel ${dupe.id} first, or skip`,
            );
        }
    }

    // Deterministic risk gate — a proposal violating risk-rules.yaml is never
    // persisted, regardless of who created it (LLM, cron, TUI, script).
    // Class caps count real commitments (executing/executed) server-side;
    // callers cannot understate them.
    const tradeClass: TradeClass = input.tradeClass ?? 'intraday';
    assertProposalRisk({
        symbol: input.symbol,
        direction: input.direction,
        entryType: input.entryType,
        entry: input.entry ?? null,
        entryLimit: input.entryLimit ?? null,
        stop: input.stop,
        target: input.target,
        quantity: input.quantity,
        tradeClass,
    }, {
        ...gateContext,
        ...(tradeClass === 'swing' ? { openSwingPositions: await countOpenByClass('swing') } : {}),
        ...(tradeClass === 'earnings-bet' ? { openEarningsBets: await countOpenByClass('earnings-bet') } : {}),
        ...(input.worstCaseGapPct != null ? { worstCaseGapPct: input.worstCaseGapPct } : {}),
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
          entry, entry_limit, stop, target, quantity, tif, trade_class, worst_case_gap_pct,
          score, rationale, source, order_ids, note)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
        id, now, expiry, now,
        input.symbol.trim().toUpperCase(), input.direction, input.entryType,
        input.entry ?? null, input.entryLimit ?? null, input.stop, input.target, input.quantity,
        input.tif === 'GTC' ? 'GTC' : 'DAY',
        tradeClass, input.worstCaseGapPct ?? null,
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

/**
 * EOD-keep transition: a DAY bracket's exits expired at the bell with the
 * position still open, and auto-protect re-armed GTC exits. Instead of
 * closing the proposal (which orphaned the hold: out of the caps, out of
 * triage, P&L forever unlabeled — the orphaned-keep hole), the SAME row
 * carries the position through the night: tif flips to GTC, order_ids
 * point at the protect pair (entry id kept for the fill record), and
 * kept_overnight_at marks the conversion for reporting and re-triage.
 * Guarded on status='executed' so a concurrent close wins over a convert.
 */
export async function convertToOvernightHold(
    id: string,
    input: { orderIds: number[]; note?: string; at?: number },
): Promise<boolean> {
    const database = await getDb();
    const now = Date.now();
    database.query<void>(
        `UPDATE proposals SET tif = 'GTC', order_ids = ?, kept_overnight_at = ?,
                note = CASE WHEN note IS NULL THEN ? ELSE note || ' — ' || ? END,
                updated_at = ?
         WHERE id = ? AND status = 'executed' AND entry_fill_price IS NOT NULL`,
    ).run(
        JSON.stringify(input.orderIds),
        input.at ?? now,
        input.note ?? 'kept overnight under GTC protection',
        input.note ?? 'kept overnight under GTC protection',
        now,
        id.trim().toUpperCase(),
    );
    const after = await getProposal(id);
    const converted = after?.status === 'executed' && after.keptOvernightAt != null;
    if (converted) logger.info(`[proposals] ${id.toUpperCase()} kept overnight — tif GTC, exits ${input.orderIds.join('/')}`);
    return converted;
}

/**
 * Late P&L attribution: a deliberate close order (closePosition /
 * profit-trail / EOD triage) filled AFTER its proposal was already closed
 * as 'manual / P&L unknown' — e.g. the close was placed outside RTH and
 * filled at the next open. Fills the blanks on the closed row; never
 * overwrites a P&L that is already recorded.
 */
export async function recordLateExitFill(
    id: string,
    input: { exitFillPrice: number; realizedPnl: number; note?: string },
): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET
                exit_fill_price = COALESCE(exit_fill_price, ?),
                realized_pnl = ?,
                note = CASE WHEN note IS NULL THEN ? ELSE note || ' — ' || ? END,
                updated_at = ?
         WHERE id = ? AND status = 'closed' AND exit_reason = 'manual' AND realized_pnl IS NULL`,
    ).run(
        input.exitFillPrice,
        input.realizedPnl,
        input.note ?? 'late exit fill',
        input.note ?? 'late exit fill',
        Date.now(),
        id.trim().toUpperCase(),
    );
    logger.info(`[proposals] late exit fill recorded for ${id.toUpperCase()} (pnl ${input.realizedPnl})`);
}

/** Executed proposals that have not been closed — what the tracker watches. */
export async function listTrackable(): Promise<TradeProposal[]> {
    const database = await getDb();
    const rows = database.query<Row>(
        `SELECT * FROM proposals WHERE status = 'executed' ORDER BY executed_at ASC`,
    ).all();
    return rows.map(fromRow);
}

/** Executed proposals whose ENTRY never filled, older than maxAgeMs —
 *  zombie brackets occupying position slots (swept by the stale-entry
 *  sweeper, which cancels their orders). */
export async function listStaleUnfilled(maxAgeMs: number): Promise<TradeProposal[]> {
    const database = await getDb();
    const rows = database.query<Row>(
        `SELECT * FROM proposals
         WHERE status = 'executed' AND entry_fill_price IS NULL AND executed_at < ?
         ORDER BY executed_at ASC`,
    ).all(Date.now() - maxAgeMs);
    return rows.map(fromRow);
}

/** Open exposure count: executed positions PLUS acceptances mid-flight
 *  ('executing') — two concurrent accepts must see each other, or both
 *  slip under max_open_positions (audit 2026-08-06, finding 5). */
export async function countOpenExecuted(): Promise<number> {
    const database = await getDb();
    const rows = database.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM proposals WHERE status IN ('executing', 'executed')`,
    ).all();
    return rows[0]?.n ?? 0;
}

/** Proposals holding or about to hold exposure — feeds the per-symbol
 *  aggregate cap (same 'executing' rationale as countOpenExecuted). */
export async function listExposure(): Promise<TradeProposal[]> {
    const database = await getDb();
    const rows = database.query<Row>(
        `SELECT * FROM proposals WHERE status IN ('executing', 'executed')`,
    ).all();
    return rows.map(fromRow);
}

/** Net realized P&L (USD) of trades closed since `sinceMs`. Rows with an
 *  unknown outcome (realized_pnl NULL) contribute nothing — the headroom
 *  gate stays conservative elsewhere, it must not invent losses here. */
export async function sumRealizedPnlSince(sinceMs: number): Promise<number> {
    const database = await getDb();
    const rows = database.query<{ n: number | null }>(
        `SELECT SUM(realized_pnl) AS n FROM proposals
         WHERE status = 'closed' AND closed_at >= ? AND realized_pnl IS NOT NULL`,
    ).all(sinceMs);
    return Math.round((rows[0]?.n ?? 0) * 100) / 100;
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
         WHERE status IN ('executing', 'executed', 'closed') AND executed_at >= ?`,
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
// Performance baseline (non-destructive "reset")
// ---------------------------------------------------------------------------
// 'performance reset' stamps a baseline: reports measure from it by default
// so a re-tuned gate stack gets judged on its own record, while the full
// labeled history stays in the DB — it is the calibration/training data.
// 'performance all' bypasses the baseline.

export interface PerformanceBaseline {
    epochMs: number;
    note?: string;
}

function baselinePath(): string {
    const dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
    return join(dataDir, 'performance-epoch.json');
}

/** The active baseline, or null when none was ever set. */
export function getPerformanceBaseline(): PerformanceBaseline | null {
    try {
        const parsed = JSON.parse(readFileSync(baselinePath(), 'utf-8')) as PerformanceBaseline;
        return Number.isFinite(parsed.epochMs) && parsed.epochMs > 0 ? parsed : null;
    } catch {
        return null;
    }
}

/** Stamp a new baseline at now. Overwrites any previous one. */
export function setPerformanceBaseline(note?: string): PerformanceBaseline {
    const baseline: PerformanceBaseline = { epochMs: Date.now(), ...(note ? { note } : {}) };
    writeFileSync(baselinePath(), JSON.stringify(baseline, null, 2));
    logger.info(`[proposals] performance baseline reset to ${new Date(baseline.epochMs).toISOString()}${note ? ` (${note})` : ''}`);
    return baseline;
}

// ---------------------------------------------------------------------------
// Performance reporting
// ---------------------------------------------------------------------------

export interface PerformanceSummary {
    sinceMs: number;
    /** Baseline that floored the window (null = none set or ignored). */
    baseline: PerformanceBaseline | null;
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
    /** Per-class ledger (intraday / swing / earnings-bet). Each class earns
     *  its own track record — the earnings-bet live switch is gated on this. */
    byClass: Record<string, { closed: number; wins: number; losses: number; netPnl: number }>;
    openExecuted: number;
    openProposals: number;
}

/** Aggregate closed-trade outcomes since the given epoch ms. The window is
 *  floored to the performance baseline unless `includeAllHistory` is set. */
export async function getPerformanceSummary(
    sinceMs: number,
    opts: { includeAllHistory?: boolean } = {},
): Promise<PerformanceSummary> {
    const baseline = opts.includeAllHistory ? null : getPerformanceBaseline();
    const effectiveSince = baseline ? Math.max(sinceMs, baseline.epochMs) : sinceMs;
    const database = await getDb();
    const rows = database.query<Row>(
        `SELECT * FROM proposals WHERE status = 'closed' AND closed_at >= ? ORDER BY closed_at ASC`,
    ).all(effectiveSince).map(fromRow);

    let wins = 0, losses = 0, flat = 0, unlabeled = 0;
    let grossPnl = 0, commissions = 0;
    let best: PerformanceSummary['best'] = null;
    let worst: PerformanceSummary['worst'] = null;
    const byExitReason: Record<string, number> = {};
    const byClass: PerformanceSummary['byClass'] = {};

    for (const p of rows) {
        byExitReason[p.exitReason ?? 'unknown'] = (byExitReason[p.exitReason ?? 'unknown'] ?? 0) + 1;
        const cls = (byClass[p.tradeClass] ??= { closed: 0, wins: 0, losses: 0, netPnl: 0 });
        cls.closed++;
        if (p.realizedPnl == null) {
            unlabeled++;
            continue;
        }
        cls.netPnl = Math.round((cls.netPnl + p.realizedPnl - (p.commissions ?? 0)) * 100) / 100;
        // Win/loss on NET P&L (gross minus commissions): a trade whose
        // gross edge is smaller than its round-trip fees is a loss, and
        // that marginal population is exactly what calibration reads
        // (audit 2026-08-06, finding A).
        const net = Math.round((p.realizedPnl - (p.commissions ?? 0)) * 100) / 100;
        if (net > 0) cls.wins++;
        else if (net < 0) cls.losses++;
        grossPnl += p.realizedPnl;
        commissions += p.commissions ?? 0;
        if (net > 0) wins++;
        else if (net < 0) losses++;
        else flat++;
        if (!best || net > best.pnl) best = { id: p.id, symbol: p.symbol, pnl: net };
        if (!worst || net < worst.pnl) worst = { id: p.id, symbol: p.symbol, pnl: net };
    }

    const decided = wins + losses;
    return {
        sinceMs: effectiveSince,
        baseline: baseline && baseline.epochMs > sinceMs ? baseline : null,
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
        byClass,
        openExecuted: await countOpenExecuted(),
        openProposals: (await listProposals('open', 100)).length,
    };
}

/** Human-readable performance report (WhatsApp / brief friendly). */
export function formatPerformanceReport(s: PerformanceSummary, label: string): string {
    if (s.closed === 0 && s.openExecuted === 0) {
        const since = s.baseline ? ` since the ${new Date(s.baseline.epochMs).toISOString().slice(0, 10)} baseline` : '';
        return `Performance (${label}): no closed trades${since}, nothing executing.`;
    }
    const sign = (n: number) => (n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`);
    const lines = [
        `Performance (${label}): ${s.closed} closed, ${s.wins}W/${s.losses}L` +
        (s.winRatePct != null ? ` (${s.winRatePct}% win rate)` : '') +
        (s.unlabeled ? `, ${s.unlabeled} without P&L` : ''),
        `Net P&L ${sign(s.netPnl)} (gross ${sign(s.grossPnl)}, commissions $${s.commissions.toFixed(2)})`,
    ];
    if (s.best) lines.push(`Best: ${s.best.symbol} ${sign(s.best.pnl)} (${s.best.id})`);
    if (s.worst && s.worst.id !== s.best?.id) lines.push(`Worst: ${s.worst.symbol} ${sign(s.worst.pnl)} (${s.worst.id})`);
    const reasons = Object.entries(s.byExitReason).map(([r, n]) => `${r} ${n}`).join(', ');
    if (reasons) lines.push(`Exits: ${reasons}`);
    // Per-class lines only when a non-intraday class traded — the class
    // ledgers are what the swing review and the earnings-bet live switch
    // are judged on.
    if (Object.keys(s.byClass).some((c) => c !== 'intraday')) {
        for (const [c, v] of Object.entries(s.byClass)) {
            if (v.closed === 0) continue;
            lines.push(`  ${c}: ${v.closed} closed, ${v.wins}W/${v.losses}L, net ${sign(v.netPnl)}`);
        }
    }
    if (s.openExecuted > 0) lines.push(`Still executing: ${s.openExecuted}`);
    if (s.openProposals > 0) lines.push(`Open proposals: ${s.openProposals}`);
    if (s.baseline) {
        const d = new Date(s.baseline.epochMs).toISOString().slice(0, 10);
        lines.push(`Baseline: ${d}${s.baseline.note ? ` (${s.baseline.note})` : ''} — earlier history kept, see 'performance all'`);
    }
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

    // Claims that never resolved (crash/restart mid-placement) must not
    // stay 'executing' forever — fail them honestly for manual review.
    const stuck = database.query<Row>(
        `SELECT id FROM proposals WHERE status = 'executing' AND updated_at < ?`,
    ).all(now - 10 * 60_000);
    for (const r of stuck) {
        database.query<void>(
            `UPDATE proposals SET status = 'failed', updated_at = ?, note = ? WHERE id = ? AND status = 'executing'`,
        ).run(now, 'execution interrupted (crash/restart mid-placement) — verify orders at IBKR manually', r.id);
        logger.error(`[proposals] ${r.id}: stuck in 'executing' >10min — marked failed for manual review`);
    }
    return stale.length;
}

/**
 * Atomically claim an open proposal for execution (open → executing).
 * SQLite serializes the conditional UPDATE, so exactly ONE concurrent
 * caller sees its own token after the write — everyone else gets false.
 * Release with releaseProposalClaim (gate refusals) or finalize with
 * setProposalStatus('executed'|'failed').
 */
export async function claimProposalForExecution(id: string): Promise<boolean> {
    const database = await getDb();
    const key = id.trim().toUpperCase();
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    database.query<void>(
        `UPDATE proposals SET status = 'executing', claim_token = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
    ).run(token, Date.now(), key);
    const row = database.query<{ claim_token: string | null }>(
        `SELECT claim_token FROM proposals WHERE id = ?`,
    ).all(key)[0];
    return row?.claim_token === token;
}

/** Return a claimed proposal to 'open' (gate refusal — retry allowed). */
export async function releaseProposalClaim(id: string): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET status = 'open', claim_token = NULL, updated_at = ? WHERE id = ? AND status = 'executing'`,
    ).run(Date.now(), id.trim().toUpperCase());
}

/** One-line human summary (used in WhatsApp messages). */
export function formatProposalLine(p: TradeProposal): string {
    const entry = p.entryType === 'MKT' ? `MKT~${p.entry ?? '?'}`
        : p.entryType === 'STP_LMT' ? `STP@${p.entry}/lim${p.entryLimit ?? '?'}`
        : `@${p.entry}`;
    const outcome = p.status === 'closed' && p.realizedPnl != null
        ? ` ${p.exitReason ?? '?'} ${p.realizedPnl >= 0 ? '+' : ''}$${p.realizedPnl.toFixed(2)}`
        : '';
    // Freshness stamp: levels are anchored around creation time — on fast
    // movers this is the difference between a fill and a chase.
    const asOf = p.status === 'open'
        ? ` · levels as of ${new Date(p.createdAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })} ET`
        : '';
    const classTag = p.tradeClass !== 'intraday' ? ` {${p.tradeClass}}` : '';
    return `${p.id} ${p.direction.toUpperCase()} ${p.quantity} ${p.symbol} ${entry} stop ${p.stop} target ${p.target}` +
        (p.score != null ? ` (score ${p.score})` : '') + `${classTag} [${p.status}${outcome}]${asOf}`;
}
