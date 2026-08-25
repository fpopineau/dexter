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
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
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
    /** Broker permIds aligned with orderIds; null entries where the ack
     *  never carried one (WP1). */
    orderPermIds: Array<number | null> | null;
    /** Original intended quantity when a partial entry downgraded
     *  `quantity` to the real fill (WP2); null = never downgraded. */
    plannedQuantity: number | null;
    /** Model id that proposed the trade (review 2026-08-21) — the frozen
     *  sample's judgment-purity check reads this. */
    model: string | null;
    /** Market-regime tag at creation (protocol breadth criterion). */
    regime: string | null;
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
    /** Max favorable excursion while held, % of the entry fill (≥ 0).
     *  Written post-close by the outcome tracker from historical bars
     *  (bar-resolution approximation, extended hours included). Null =
     *  not measured (bars unavailable, entry never filled). */
    mfePct: number | null;
    /** Max adverse excursion while held, % of the entry fill (≥ 0). */
    maePct: number | null;
    // --- Entry context at creation (entry-context.ts; null = unmeasured) ---
    /** Market extension at creation, × daily ATR beyond EMA10, signed in
     *  the trade direction (positive = the chase side). */
    extensionAtr: number | null;
    /** Distance from session VWAP at creation, %, trade-direction signed. */
    vwapDistPct: number | null;
    /** Day move vs prior close at creation, %, trade-direction signed. */
    dayMovePct: number | null;
    /** Minutes since 09:30 ET at creation (negative = pre-market). */
    minutesSinceOpen: number | null;
    // --- Take-at-x% exit policy (WP-EXIT) ---
    /** Effective take percent the gate enforced (target sits at x% from the
     *  worst permitted fill). Null on classes/modes the policy exempts. */
    takePct: number | null;
    /** 'model' = the proposal supplied take_pct; 'formula' = ATR default. */
    takePctSource: 'formula' | 'model' | null;
    /** Post-exit same-day favorable excursion, % of the EXIT fill (≥ 0) —
     *  what was left on the table after the take (REQ-EXIT-012). */
    postExitMfePct: number | null;
    /** Post-exit same-day adverse excursion, % of the exit fill (≥ 0). */
    postExitMaePct: number | null;
    /** Legacy-geometry counterfactual (REQ-EXIT-013): from the same entry,
     *  would a 1×ATR stop / 2×ATR target have hit target-first, stop-first,
     *  or neither within the ~3-trading-day horizon. */
    takeCounterfactual: 'target-first' | 'stop-first' | 'neither' | null;
    /** Daily ATR (USD) at creation — the take formula's and the
     *  counterfactual's yardstick. Null on pre-policy rows. */
    dailyAtrAtCreation: number | null;
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

/** REQ-TEST-001: under tests the data dir must live inside the OS temp
 *  directory — "the variable is set" proved nothing when .env supplied the
 *  PRODUCTION path (review 2026-08-23 P0: a verification run wrote 14
 *  synthetic rows into the real proposals.db). Exported for its test. */
export function assertTestDataDirIsTemp(dataDir: string | undefined, nodeEnv: string | undefined, tmpRoot: string): void {
    if (nodeEnv !== 'test') return;
    if (!dataDir) {
        throw new Error('[proposals] refusing to open the production DB under NODE_ENV=test — set DEXTER_DATA_DIR to a temp dir first');
    }
    const norm = (p: string) => resolve(p).toLowerCase().replace(/[\\/]+$/, '');
    const dir = norm(dataDir);
    const tmp = norm(tmpRoot);
    if (dir !== tmp && !dir.startsWith(tmp + sep)) {
        throw new Error(
            `[proposals] refusing to open '${dataDir}' under NODE_ENV=test — it is OUTSIDE the OS temp directory ` +
            `('${tmpRoot}'). A test run bound to the production DB once wrote synthetic trades into it; ` +
            `use the test preload (test/test-env.ts) or mkdtemp, never a real path`,
        );
    }
}

async function getDb(): Promise<SqliteDatabase> {
    if (db) return db;
    // Hard guard: a test run must NEVER bind the production proposals DB.
    // The store caches its handle process-wide, so one test file importing
    // without isolation poisons the entire run — refuse loudly instead.
    assertTestDataDirIsTemp(process.env.DEXTER_DATA_DIR, process.env.NODE_ENV, tmpdir());
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
            outcome_note TEXT,
            mfe_pct     REAL,
            mae_pct     REAL,
            proposal_age_sec REAL,
            live_price  REAL
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
    /** Replay excursions after the counterfactual fill, % of entry. */
    mfePct: number | null;
    maePct: number | null;
    /** Acceptance-time refusals only: age of the proposal's levels when the
     *  gate fired (seconds since creation) and the live price the gate saw.
     *  Together they turn "the quote was 70 seconds stale" from folklore
     *  into a ledger column. Null on creation-time refusals. */
    proposalAgeSec: number | null;
    livePrice: number | null;
}

/** Keyword classification of a refusal reason into the gate that fired. */
export function classifyRefusalGate(reason: string): string {
    const r = reason.toLowerCase();
    // FIRST: judgment declines carry the model's free-text reason, which can
    // legitimately mention any other gate's keywords ("stop would sit inside
    // intraday noise") — the prefix, not the content, decides the bucket.
    if (r.startsWith('evaluation declined')) return 'judgment';
    if (r.includes('duplicate setup')) return 'duplicate';
    if (r.includes('intraday noise')) return 'noise-stop';
    if (r.includes('chasing an extended move')) return 'extension';
    // Acceptance-time chase gate (checkPriceRun): "price has run: last …"
    // vs "setup invalidated: last … is at/through the stop".
    if (r.includes('price has run')) return 'chase';
    if (r.includes('setup invalidated')) return 'invalidated';
    // Match the cap's own violation text, NOT 'reachability' — the VIABLE
    // GEOMETRY prescription mentions the reachability cap on every banded
    // refusal, which would swallow noise-stop/R:R refusals into this bucket.
    if (r.includes('does not travel that far')) return 'target-cap';
    // Creation-time buy-now filter (LMT/MKT at the quote, STP_LMT inside noise).
    if (r.includes('buy-now') || r.includes('first-uptick')) return 'entry-pricing';
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
    /** Acceptance-time refusals: seconds between proposal creation and the
     *  gate check, and the live price the gate compared against. */
    proposalAgeSec?: number | null;
    livePrice?: number | null;
}): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `INSERT INTO refusals (created_at, symbol, direction, entry_type, entry, entry_limit, stop, target, quantity, score, reason, gate, proposal_age_sec, live_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        Date.now(), input.symbol.trim().toUpperCase(), input.direction, input.entryType,
        input.entry ?? null, input.entryLimit ?? null, input.stop ?? null, input.target ?? null,
        input.quantity ?? null, input.score ?? null, input.reason.slice(0, 600), classifyRefusalGate(input.reason),
        input.proposalAgeSec ?? null, input.livePrice ?? null,
    );
}

interface RefusalRow {
    id: number; created_at: number; symbol: string; direction: string; entry_type: string;
    entry: number | null; entry_limit: number | null; stop: number | null; target: number | null;
    quantity: number | null; score: number | null; reason: string; gate: string;
    outcome: string | null; outcome_note: string | null;
    mfe_pct: number | null; mae_pct: number | null;
    proposal_age_sec: number | null; live_price: number | null;
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
        mfePct: r.mfe_pct ?? null, maePct: r.mae_pct ?? null,
        proposalAgeSec: r.proposal_age_sec ?? null, livePrice: r.live_price ?? null,
    }));
}

export async function setRefusalOutcome(
    id: number,
    outcome: string,
    note?: string,
    mfePct?: number | null,
    maePct?: number | null,
): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE refusals SET outcome = ?, outcome_note = ?, mfe_pct = ?, mae_pct = ? WHERE id = ?`,
    ).run(outcome, note ?? null, mfePct ?? null, maePct ?? null, id);
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
    // Held-trade excursions (2026-08-18): how far price actually went
    // for/against the position while held — the tuning data for
    // max_target_atr (refusals already carry replay MFE/MAE; executed
    // trades did not, so the reachability cap had no empirical basis).
    ['mfe_pct', 'REAL'],
    ['mae_pct', 'REAL'],
    // Entry context at creation (2026-08-18 entry audit): the market state
    // when the proposal was priced — extension, VWAP distance, day move,
    // minutes since open, all signed in the trade direction. The evidence
    // base for tuning the entry gates (extension guard, buy-now filter).
    ['extension_atr', 'REAL'],
    ['vwap_dist_pct', 'REAL'],
    ['day_move_pct', 'REAL'],
    ['minutes_since_open', 'REAL'],
    // Broker permIds aligned with order_ids (WP1, remediation 2026-08-20):
    // client order ids reset per connection — permId is IBKR's stable
    // handle, the reconciliation key that survives a reconnect.
    ['order_perm_ids', 'TEXT'],
    // WP2: when an entry terminates partially filled, `quantity` downgrades
    // to the REAL position and the original intent is preserved here —
    // analytics can still ask "how often do we get our full size?".
    ['planned_quantity', 'INTEGER'],
    // Review 2026-08-21: which model proposed the trade. The frozen
    // validation sample must be judgment-pure — a runtime model switch
    // mid-sample is detectable instead of invisible.
    ['model', 'TEXT'],
    // Review 2026-08-21 (round 3): the protocol's breadth criterion needs
    // >=2 regime labels ACROSS THE SAMPLE — recorded at creation, from the
    // market-regime service's tag, or the criterion is unevaluable.
    ['regime', 'TEXT'],
    // WP-EXIT (2026-08-22): the take-at-x% policy. take_pct is the
    // effective x the gate enforced (model override or ATR formula —
    // take_pct_source says which); the accept-time re-check reuses it so
    // the required target survives daily ATR drift.
    ['take_pct', 'REAL'],
    ['take_pct_source', 'TEXT'],
    // REQ-EXIT-012/013: the "benefits tracked" half of the policy —
    // post-exit same-day excursions (what was left on the table after the
    // take) and the bounded legacy-geometry counterfactual verdict
    // ('target-first' | 'stop-first' | 'neither').
    ['post_exit_mfe_pct', 'REAL'],
    ['post_exit_mae_pct', 'REAL'],
    ['take_counterfactual', 'TEXT'],
    // Creation-time daily ATR (USD) — the counterfactual's yardstick
    // (legacy stop 1×ATR / target 2×ATR must use the ATR the trade was
    // priced against, not a later one).
    ['daily_atr', 'REAL'],
    // Review-17 freeze integrity: 12-hex digest of the effective risk
    // rules + judgment documents at creation (strategy-fingerprint.ts).
    // The scorecard refuses a mixed-fingerprint sample.
    ['strategy_fingerprint', 'TEXT'],
];

/** Replay/instrumentation columns added after the refusals-table release. */
const REFUSAL_COLUMNS: Array<[string, string]> = [
    ['mfe_pct', 'REAL'],
    ['mae_pct', 'REAL'],
    ['proposal_age_sec', 'REAL'],
    ['live_price', 'REAL'],
];

function migrate(database: SqliteDatabase): void {
    for (const [name, type] of OUTCOME_COLUMNS) {
        try {
            database.exec(`ALTER TABLE proposals ADD COLUMN ${name} ${type}`);
        } catch {
            // column already exists
        }
    }
    for (const [name, type] of REFUSAL_COLUMNS) {
        try {
            database.exec(`ALTER TABLE refusals ADD COLUMN ${name} ${type}`);
        } catch {
            // column already exists
        }
    }
    // Review-17: DB-enforced one-thesis-per-symbol. The application-level
    // claim + rival-exclusion can race (two simultaneous accepts can BOTH
    // see the other and release); this partial unique index leaves exactly
    // one survivor — the loser's claim UPDATE throws and reads false. The
    // creation-time guard stays as the friendly first line; this is the
    // law. Creation failure (a legacy DB already holding duplicate working
    // rows on one symbol) is loud, never silent: the code-level guards
    // still stand, but the operator must resolve the duplicates.
    try {
        database.exec(
            `CREATE UNIQUE INDEX IF NOT EXISTS ux_one_working_thesis
             ON proposals(symbol) WHERE status IN ('executing', 'executed')`,
        );
    } catch (err) {
        logger.error(
            `[proposals] one-thesis unique index NOT created — duplicate executing/executed rows per symbol ` +
            `already exist; the DB-level guarantee is ABSENT until they are resolved: ${err instanceof Error ? err.message : err}`,
        );
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
    order_perm_ids: string | null;
    planned_quantity: number | null;
    model: string | null;
    regime: string | null;
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
    mfe_pct: number | null;
    mae_pct: number | null;
    extension_atr: number | null;
    vwap_dist_pct: number | null;
    day_move_pct: number | null;
    minutes_since_open: number | null;
    take_pct: number | null;
    take_pct_source: string | null;
    post_exit_mfe_pct: number | null;
    post_exit_mae_pct: number | null;
    take_counterfactual: string | null;
    daily_atr: number | null;
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
        orderPermIds: r.order_perm_ids ? (JSON.parse(r.order_perm_ids) as Array<number | null>) : null,
        plannedQuantity: r.planned_quantity ?? null,
        model: r.model ?? null,
        regime: r.regime ?? null,
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
        mfePct: r.mfe_pct ?? null,
        maePct: r.mae_pct ?? null,
        extensionAtr: r.extension_atr ?? null,
        vwapDistPct: r.vwap_dist_pct ?? null,
        dayMovePct: r.day_move_pct ?? null,
        minutesSinceOpen: r.minutes_since_open ?? null,
        takePct: r.take_pct ?? null,
        takePctSource: r.take_pct_source === 'model' ? 'model' : r.take_pct_source === 'formula' ? 'formula' : null,
        postExitMfePct: r.post_exit_mfe_pct ?? null,
        postExitMaePct: r.post_exit_mae_pct ?? null,
        takeCounterfactual: (r.take_counterfactual === 'target-first' || r.take_counterfactual === 'stop-first' || r.take_counterfactual === 'neither')
            ? r.take_counterfactual : null,
        dailyAtrAtCreation: r.daily_atr ?? null,
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateProposalInput {
    symbol: string;
    direction: 'long' | 'short';
    entryType: 'LMT' | 'MKT' | 'STP_LMT';
    /** Model id that proposed the trade (judgment-purity stamp). */
    model?: string;
    /** Market-regime tag at creation (protocol breadth criterion). */
    regime?: string;
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
    /** Take-at-x% override (WP-EXIT): the model's x within the take band;
     *  omitted = the ATR formula. Gate-validated, then stamped. */
    takePct?: number;
    /** Earnings bets: worst historical adverse post-print move (%). */
    worstCaseGapPct?: number;
    score?: number;
    rationale: string;
    source: string;
    expiresMinutes?: number;
    /** Market state at creation (entry-context.ts), computed server-side
     *  by the caller when the data is in hand. Instrumentation only —
     *  never gates; missing fields stay null. */
    entryContext?: {
        extensionAtr?: number | null;
        vwapDistPct?: number | null;
        dayMovePct?: number | null;
        minutesSinceOpen?: number | null;
    };
}


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
    // ONE ACTIVE THESIS PER SYMBOL (review 2026-08-23, replaces the old
    // 2%-tolerance duplicate guard): any executed/working row on the symbol
    // refuses a new proposal outright. Stacking created aggregate-position
    // ambiguity, multiple OCA groups (which the close and the runner both
    // rightly refuse), trail exemption leaks and attribution noise — an
    // amendment REPLACES the working bracket ('cancel P-XXXX' first), it
    // does not sit beside it. Adopted rows count too: Dexter does not
    // trade around a position it merely records.
    {
        // Includes 'executing' rows (omission 3): a proposal mid-accept owns
        // the symbol just as firmly as an executed one.
        const existing = (await listWorkingForSymbol(input.symbol))[0];
        if (existing) {
            throw new Error(
                `[risk-gate] REFUSED ${input.symbol.toUpperCase()}: one active thesis per symbol — ${existing.id} ` +
                `(${existing.tradeClass}${existing.entryFillPrice !== null ? ', filled' : ', working'}) already owns it. ` +
                `Cancel or close ${existing.id} first, or skip`,
            );
        }
    }

    // Deterministic risk gate — a proposal violating risk-rules.yaml is never
    // persisted, regardless of who created it (LLM, cron, TUI, script).
    // Class caps count real commitments (executing/executed) server-side;
    // callers cannot understate them.
    const tradeClass: TradeClass = input.tradeClass ?? 'intraday';
    const gateResult = assertProposalRisk({
        symbol: input.symbol,
        direction: input.direction,
        entryType: input.entryType,
        entry: input.entry ?? null,
        entryLimit: input.entryLimit ?? null,
        stop: input.stop,
        target: input.target,
        quantity: input.quantity,
        tradeClass,
        takePct: input.takePct ?? null,
        tif: input.tif === 'GTC' ? 'GTC' : 'DAY',
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
          score, rationale, source, order_ids, note,
          extension_atr, vwap_dist_pct, day_move_pct, minutes_since_open)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    ).run(
        id, now, expiry, now,
        input.symbol.trim().toUpperCase(), input.direction, input.entryType,
        input.entry ?? null, input.entryLimit ?? null, input.stop, input.target, input.quantity,
        input.tif === 'GTC' ? 'GTC' : 'DAY',
        tradeClass, input.worstCaseGapPct ?? null,
        input.score ?? null, input.rationale, input.source,
        input.entryContext?.extensionAtr ?? null, input.entryContext?.vwapDistPct ?? null,
        input.entryContext?.dayMovePct ?? null, input.entryContext?.minutesSinceOpen ?? null,
    );

    // Judgment-purity stamp (review 2026-08-21): record which model
    // proposed the trade — the frozen sample verifies it never mixed.
    if (input.model) {
        database.query<void>(`UPDATE proposals SET model = ? WHERE id = ?`).run(input.model, id);
    }
    // Review-17/19 freeze integrity: stamp the strategy fingerprint — the
    // scorecard refuses a sample that mixes fingerprints, so a mid-sample
    // edit on any behavioral surface ends the window detectably. A NULL
    // fingerprint (a REQUIRED identity surface — rules, code, provider —
    // could not be resolved) stamps NOTHING: the row reads ABSENT and the
    // scorecard refuses the window, fail closed. A stamp failure must not
    // lose a proposal — same outcome.
    try {
        const { strategyFingerprint } = await import('./strategy-fingerprint.js');
        const fp = await strategyFingerprint();
        if (fp !== null) {
            database.query<void>(`UPDATE proposals SET strategy_fingerprint = ? WHERE id = ?`).run(fp, id);
        } else {
            logger.warn(`[proposals] ${id}: strategy identity UNRESOLVED (rules/code/provider) — row left unstamped; the scorecard will refuse the window`);
        }
    } catch (err) {
        logger.warn(`[proposals] ${id}: strategy fingerprint stamp failed — ${err instanceof Error ? err.message : err}`);
    }
    if (input.regime) {
        database.query<void>(`UPDATE proposals SET regime = ? WHERE id = ?`).run(input.regime, id);
    }
    // WP-EXIT: persist the enforced take level — the accept-time re-check
    // reuses the STORED x (as an override) so the required target survives
    // daily ATR drift between creation and acceptance.
    if (gateResult.takePct !== null) {
        database.query<void>(`UPDATE proposals SET take_pct = ?, take_pct_source = ? WHERE id = ?`)
            .run(gateResult.takePct, gateResult.takePctSource, id);
    }
    // Creation-time ATR: the counterfactual's yardstick (REQ-EXIT-013).
    if (gateContext.dailyAtr !== undefined && gateContext.dailyAtr > 0) {
        database.query<void>(`UPDATE proposals SET daily_atr = ? WHERE id = ?`).run(gateContext.dailyAtr, id);
    }

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

/**
 * WP3: record a broker position Dexter did not open, so every exposure cap
 * sees it. Bypasses the creation risk gate ON PURPOSE — the position
 * already exists; refusing to record it is how it stayed invisible. The
 * stop/target are SYNTHETIC (±5%/±10% of basis, labeled in the note): they
 * price a conservative planned risk for the headroom gate and are never
 * used to place orders — Dexter does not manage adopted positions.
 */
export async function createAdoptedPosition(input: {
    symbol: string;
    direction: 'long' | 'short';
    quantity: number;
    avgCost: number;
    account: string;
}): Promise<TradeProposal> {
    const database = await getDb();
    const now = Date.now();
    let id = '';
    for (let attempt = 0; attempt < 5; attempt++) {
        id = `P-${randomBytes(2).toString('hex').toUpperCase()}`;
        const clash = database.query<Row>(`SELECT id FROM proposals WHERE id = ?`).all(id);
        if (clash.length === 0) break;
        id = '';
    }
    if (!id) throw new Error('[proposals] could not allocate a unique id');

    const long = input.direction === 'long';
    const stop = Math.round(input.avgCost * (long ? 0.95 : 1.05) * 100) / 100;
    const target = Math.round(input.avgCost * (long ? 1.10 : 0.90) * 100) / 100;
    const qty = Math.max(1, Math.round(input.quantity));
    database.query<void>(
        `INSERT INTO proposals
         (id, created_at, expires_at, updated_at, status, symbol, direction, entry_type,
          entry, stop, target, quantity, tif, trade_class,
          rationale, source, order_ids, note,
          executed_at, entry_fill_price, entry_filled_at)
         VALUES (?, ?, ?, ?, 'executed', ?, ?, 'MKT', ?, ?, ?, ?, 'GTC', 'intraday', ?, 'adopted', NULL, ?, ?, ?, ?)`,
    ).run(
        id, now, now, now,
        input.symbol.trim().toUpperCase(), input.direction,
        input.avgCost, stop, target, qty,
        `adopted from broker reconciliation: position existed in ${input.account} with no proposal row`,
        `adopted 'as found' — stop/target are synthetic bookkeeping levels (±5%/±10% of basis), no Dexter orders exist for this row`,
        now, input.avgCost, now,
    );
    logger.warn(`[proposals] ${id}: ADOPTED broker position ${input.direction} ${qty} ${input.symbol} @ ${input.avgCost} (${input.account})`);
    const created = await getProposal(id);
    if (!created) throw new Error(`[proposals] just-created ${id} not found`);
    return created;
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
    extra?: { orderIds?: number[]; orderPermIds?: Array<number | null>; note?: string; executedAt?: number },
): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET status = ?, updated_at = ?, order_ids = COALESCE(?, order_ids),
                order_perm_ids = COALESCE(?, order_perm_ids),
                note = COALESCE(?, note), executed_at = COALESCE(?, executed_at) WHERE id = ?`,
    ).run(
        status,
        Date.now(),
        extra?.orderIds ? JSON.stringify(extra.orderIds) : null,
        extra?.orderPermIds ? JSON.stringify(extra.orderPermIds) : null,
        extra?.note ?? null,
        extra?.executedAt ?? null,
        id.trim().toUpperCase(),
    );
}

// ---------------------------------------------------------------------------
// Outcome lifecycle (called by the outcome tracker)
// ---------------------------------------------------------------------------

/** WP2: an entry terminated partially filled — `quantity` becomes the real
 *  position (P&L, caps and exits must see what EXISTS), the original
 *  intent moves to planned_quantity (first downgrade wins), and the note
 *  says why. */
export async function recordPartialEntryDowngrade(id: string, filledQty: number, note: string): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET planned_quantity = COALESCE(planned_quantity, quantity),
                quantity = ?, note = COALESCE(note || ' — ', '') || ?, updated_at = ?
         WHERE id = ?`,
    ).run(filledQty, note, Date.now(), id.trim().toUpperCase());
}

/** Record the entry order's fill. */
export async function markEntryFilled(id: string, price: number, at = Date.now()): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET entry_fill_price = ?, entry_filled_at = ?, updated_at = ? WHERE id = ?`,
    ).run(price, at, Date.now(), id.trim().toUpperCase());
}

/** Round-7 review: adopted rows had no resolution lifecycle — the broker
 *  position disappearing (closed in TWS, stopped out on its own orders)
 *  left the 'executed' row as phantom exposure and a permanent
 *  unresolved-adoption anomaly. The reconciliation sweep calls this with
 *  the symbols the broker actually HOLDS; any open adopted row outside
 *  that set closes as 'unknown' P&L (the broker owned the exit — we never
 *  saw its fill). Returns the resolved ids. */
export async function resolveAdoptedFlat(heldSymbols: string[]): Promise<string[]> {
    const database = await getDb();
    const held = new Set(heldSymbols.map((s) => s.trim().toUpperCase()));
    const open = database.query<{ id: string; symbol: string }>(
        `SELECT id, symbol FROM proposals WHERE source = 'adopted' AND status = 'executed'`,
    ).all();
    const resolved: string[] = [];
    for (const row of open) {
        if (held.has(row.symbol.trim().toUpperCase())) continue;
        await closeProposal(row.id, {
            exitReason: 'unknown',
            note: 'adopted position no longer at the broker — resolved by the reconciliation sweep (exit handled outside Dexter; P&L unknown)',
        });
        resolved.push(row.id);
        logger.info(`[proposals] adopted row ${row.id} (${row.symbol}) resolved — broker position gone`);
    }
    return resolved;
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

/**
 * Held-trade excursion (MFE/MAE, % of entry fill) — written by the outcome
 * tracker after the close, from historical bars over the hold window. Kept
 * separate from closeProposal: the bars fetch takes seconds and must never
 * delay or block the close path (nulls stay honest when it fails).
 */
export async function recordTradeExcursion(id: string, mfePct: number, maePct: number): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET mfe_pct = ?, mae_pct = ?, updated_at = ? WHERE id = ?`,
    ).run(mfePct, maePct, Date.now(), id.trim().toUpperCase());
}

/** Working rows on a symbol — executing (mid-accept) AND executed. The
 *  one-thesis guard and the accept path both need this view: 'executed'
 *  alone missed a proposal mid-claim, so two same-symbol proposals could
 *  both be accepted concurrently (review 2026-08-23, omission 3). */
export async function listWorkingForSymbol(symbolRaw: string, excludeId?: string): Promise<TradeProposal[]> {
    const database = await getDb();
    const rows = database.query<Row>(
        `SELECT * FROM proposals WHERE status IN ('executing', 'executed') AND symbol = ?`,
    ).all(symbolRaw.trim().toUpperCase());
    return rows.map(fromRow).filter((t) => t.id !== excludeId);
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

/** Executed INTRADAY proposals whose entry never filled and whose validity
 *  window has passed (REQ-ENTRY-001) — the thesis expired, so the resting
 *  broker entry must not outlive it. `nowMs` is injected for determinism;
 *  `graceMs` protects a deliberate late accept: an operator who accepts two
 *  minutes before expiry still gets that much resting time. Swing and
 *  earnings-bet entries are patient by design (3-day sweep only); adopted
 *  rows were never proposed and are excluded defensively. */
export async function listExpiredUnfilledEntries(nowMs: number, graceMs: number): Promise<TradeProposal[]> {
    const database = await getDb();
    const rows = database.query<Row>(
        `SELECT * FROM proposals
         WHERE status = 'executed' AND entry_fill_price IS NULL
           AND (trade_class IS NULL OR trade_class NOT IN ('swing', 'earnings-bet'))
           AND source != 'adopted'
           AND expires_at < ?
           AND executed_at < ?
         ORDER BY executed_at ASC`,
    ).all(nowMs, nowMs - graceMs);
    return rows.map(fromRow);
}

/** LEGACY intraday GTC entries, unfilled — policy-invalid since
 *  flat-by-close (2026-08-23): the gate refuses creating them, the boot
 *  sweep cancels the survivors regardless of expiry. */
export async function listUnfilledIntradayGtc(): Promise<TradeProposal[]> {
    const database = await getDb();
    const rows = database.query<Row>(
        `SELECT * FROM proposals
         WHERE status = 'executed' AND entry_fill_price IS NULL
           AND tif = 'GTC'
           AND (trade_class IS NULL OR trade_class NOT IN ('swing', 'earnings-bet'))
           AND source != 'adopted'
         ORDER BY executed_at ASC`,
    ).all();
    return rows.map(fromRow);
}

/** Open exposure count: executed positions PLUS acceptances mid-flight
 *  ('executing') — two concurrent accepts must see each other, or both
 *  slip under max_open_positions (audit 2026-08-06, finding 5).
 *  `excludeId` lets the accept path exclude the proposal it just claimed —
 *  without it the claimed row counts against its own cap and the practical
 *  limit is one below max_open_positions (audit 2026-08-20). */
export async function countOpenExecuted(excludeId?: string): Promise<number> {
    const database = await getDb();
    const rows = excludeId
        ? database.query<{ n: number }>(
            `SELECT COUNT(*) AS n FROM proposals WHERE status IN ('executing', 'executed') AND id != ?`,
        ).all(excludeId.trim().toUpperCase())
        : database.query<{ n: number }>(
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
 *  gate stays conservative elsewhere, it must not invent losses here.
 *  realized_pnl is GROSS (tracker convention) — commissions are subtracted
 *  here so the daily-loss headroom sees the same net number the performance
 *  report shows (audit 2026-08-20: gross was overstating headroom by the
 *  day's round-trip commissions). */
export async function sumRealizedPnlSince(sinceMs: number): Promise<number> {
    const database = await getDb();
    const rows = database.query<{ n: number | null }>(
        `SELECT SUM(realized_pnl - COALESCE(commissions, 0)) AS n FROM proposals
         WHERE status = 'closed' AND closed_at >= ? AND realized_pnl IS NOT NULL`,
    ).all(sinceMs);
    return Math.round((rows[0]?.n ?? 0) * 100) / 100;
}

/** Closed, entry-filled rows still missing MFE/MAE — the excursion
 *  sweeper's work list (WP0.9). Zero-fill cancels are excluded: no held
 *  window exists to measure. Oldest first so history backfills before the
 *  IBKR bar horizon moves past it. */
export async function listClosedMissingExcursion(limit: number): Promise<TradeProposal[]> {
    const database = await getDb();
    const rows = database.query<Row>(
        `SELECT * FROM proposals
         WHERE status = 'closed' AND mfe_pct IS NULL
           AND entry_fill_price IS NOT NULL AND entry_filled_at IS NOT NULL
           AND closed_at IS NOT NULL
           AND (exit_reason IS NULL OR exit_reason != 'cancelled')
           AND (note IS NULL OR note NOT LIKE '%excursion-horizon-expired%')
         ORDER BY closed_at ASC LIMIT ?`,
    ).all(limit);
    return rows.map(fromRow);
}

/** Permanently mark a row as beyond the bar horizon — honest nulls, and
 *  the nightly sweep stops re-selecting it into every batch. */
export async function markExcursionHorizonExpired(id: string): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET note = COALESCE(note || ' — ', '') || 'excursion-horizon-expired (fill older than the IBKR intraday bar horizon)', updated_at = ? WHERE id = ?`,
    ).run(Date.now(), id.trim().toUpperCase());
}

/** Closed INTRADAY rows still owed the take-tracking data (REQ-EXIT-012/
 *  013): post-exit same-day excursions, or a counterfactual verdict where
 *  the creation ATR makes one computable. Cancelled rows never held. */
export async function listClosedMissingPostExit(limit: number): Promise<TradeProposal[]> {
    const database = await getDb();
    const rows = database.query<Row>(
        `SELECT * FROM proposals
         WHERE status = 'closed'
           AND (trade_class IS NULL OR trade_class NOT IN ('swing', 'earnings-bet'))
           AND exit_fill_price IS NOT NULL AND entry_filled_at IS NOT NULL
           AND closed_at IS NOT NULL
           AND (exit_reason IS NULL OR exit_reason != 'cancelled')
           AND (note IS NULL OR note NOT LIKE '%post-exit-horizon-expired%')
           AND (post_exit_mfe_pct IS NULL
                OR (take_counterfactual IS NULL AND daily_atr IS NOT NULL))
         ORDER BY closed_at ASC LIMIT ?`,
    ).all(limit);
    return rows.map(fromRow);
}

export async function recordPostExitExcursion(id: string, mfePct: number, maePct: number): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET post_exit_mfe_pct = ?, post_exit_mae_pct = ?, updated_at = ? WHERE id = ?`,
    ).run(mfePct, maePct, Date.now(), id.trim().toUpperCase());
}

export async function recordTakeCounterfactual(
    id: string,
    verdict: 'target-first' | 'stop-first' | 'neither',
): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET take_counterfactual = ?, updated_at = ? WHERE id = ?`,
    ).run(verdict, Date.now(), id.trim().toUpperCase());
}

/** Permanently retire a row from the post-exit sweep (bars out of reach). */
export async function markPostExitHorizonExpired(id: string): Promise<void> {
    const database = await getDb();
    database.query<void>(
        `UPDATE proposals SET note = COALESCE(note || ' — ', '') || 'post-exit-horizon-expired (exit older than the IBKR intraday bar horizon)', updated_at = ? WHERE id = ?`,
    ).run(Date.now(), id.trim().toUpperCase());
}

/** Start of the current America/New_York day in epoch ms. */
export function etDayStartMs(now = Date.now()): number {
    const et = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const msSinceMidnight =
        et.getHours() * 3_600_000 + et.getMinutes() * 60_000 + et.getSeconds() * 1_000 + et.getMilliseconds();
    return now - msSinceMidnight;
}

/** Proposals executed since the given epoch ms (includes already-closed ones).
 *  'executing' rows have executed_at = NULL (it is stamped only after bracket
 *  placement), so they must be counted by status alone — `executed_at >= ?`
 *  is NULL-comparison false for them, which made the original 'executing'
 *  IN-list term dead code and let two concurrent accepts share the last
 *  daily-trade slot (audit 2026-08-20, reopening audit 2026-08-06 finding 5).
 *  A claim is transient (seconds) and always happens "today", so counting
 *  every 'executing' row regardless of sinceMs is correct and conservative.
 *  `excludeId` lets the accept path exclude the row it just claimed, so the
 *  proposal under acceptance does not consume its own daily slot. */
export async function countExecutedSince(sinceMs: number, excludeId?: string): Promise<number> {
    const database = await getDb();
    const sql = `SELECT COUNT(*) AS n FROM proposals
         WHERE ((status IN ('executed', 'closed') AND executed_at >= ?)
            OR status = 'executing')${excludeId ? ' AND id != ?' : ''}`;
    const rows = excludeId
        ? database.query<{ n: number }>(sql).all(sinceMs, excludeId.trim().toUpperCase())
        : database.query<{ n: number }>(sql).all(sinceMs);
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
    /** Round-5 review: the paper NetLiq CAPTURED AT EPOCH TIME — the
     *  validation drawdown denominator. Reading the daily-refreshed
     *  netliq-baseline.json weeks later would divide by the final day's
     *  equity, not the freeze-time equity. */
    netLiq?: number;
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

/** Stamp a new baseline at now. Overwrites any previous one.
 *
 *  Currency incident 2026-08-25: this used to copy netliq-baseline.json,
 *  which the daily-loss guard DELIBERATELY keeps in the account's BASE
 *  currency (EUR here) — the epoch then froze €12,257 where every
 *  consumer (live-scale band, drawdown seed vs the USD equity series)
 *  assumes USD, and the band check passed on a unit coincidence while
 *  the account was really $14.3K. The caller now supplies the
 *  USD-CONVERTED NetLiq (getNetLiquidation()); no value → the epoch is
 *  written without a denominator and the scorecard reports that gap
 *  loudly rather than trusting a mislabeled one. */
export function setPerformanceBaseline(note?: string, netLiqUsd?: number | null): PerformanceBaseline {
    const netLiq = typeof netLiqUsd === 'number' && netLiqUsd > 0 ? netLiqUsd : undefined;
    const baseline: PerformanceBaseline = { epochMs: Date.now(), ...(note ? { note } : {}), ...(netLiq !== undefined ? { netLiq } : {}) };
    writeFileSync(baselinePath(), JSON.stringify(baseline, null, 2));
    logger.info(`[proposals] performance baseline reset to ${new Date(baseline.epochMs).toISOString()}${note ? ` (${note})` : ''}${netLiq !== undefined ? `, NetLiq ${netLiq} USD frozen as denominator` : ' — WARNING: no USD NetLiq supplied, no denominator frozen'}`);
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
    /** Per-lane ledger (trigger / breadth / cron:<name> / whatsapp / agent)
     *  — WP0.8: which pipeline the trade came from, so a losing lane is
     *  attributable instead of averaged into 'agent'. */
    bySource: Record<string, { closed: number; wins: number; losses: number; netPnl: number }>;
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
    const bySource: PerformanceSummary['bySource'] = {};

    for (const p of rows) {
        byExitReason[p.exitReason ?? 'unknown'] = (byExitReason[p.exitReason ?? 'unknown'] ?? 0) + 1;
        const cls = (byClass[p.tradeClass] ??= { closed: 0, wins: 0, losses: 0, netPnl: 0 });
        const lane = (bySource[p.source || 'agent'] ??= { closed: 0, wins: 0, losses: 0, netPnl: 0 });
        cls.closed++;
        lane.closed++;
        if (p.realizedPnl == null) {
            unlabeled++;
            continue;
        }
        cls.netPnl = Math.round((cls.netPnl + p.realizedPnl - (p.commissions ?? 0)) * 100) / 100;
        lane.netPnl = Math.round((lane.netPnl + p.realizedPnl - (p.commissions ?? 0)) * 100) / 100;
        // Win/loss on NET P&L (gross minus commissions): a trade whose
        // gross edge is smaller than its round-trip fees is a loss, and
        // that marginal population is exactly what calibration reads
        // (audit 2026-08-06, finding A).
        const net = Math.round((p.realizedPnl - (p.commissions ?? 0)) * 100) / 100;
        if (net > 0) cls.wins++;
        else if (net < 0) cls.losses++;
        if (net > 0) lane.wins++;
        else if (net < 0) lane.losses++;
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
        bySource,
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
    try {
        database.query<void>(
            `UPDATE proposals SET status = 'executing', claim_token = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
        ).run(token, Date.now(), key);
    } catch (err) {
        // ux_one_working_thesis: another proposal on this symbol reached
        // executing/executed first — this claim LOSES (review-17: the
        // index is what makes simultaneous same-symbol accepts leave
        // exactly one survivor).
        logger.warn(`[proposals] ${key}: claim refused by the one-thesis index — ${err instanceof Error ? err.message : err}`);
        return false;
    }
    const row = database.query<{ claim_token: string | null }>(
        `SELECT claim_token FROM proposals WHERE id = ?`,
    ).all(key)[0];
    return row?.claim_token === token;
}

/** Test hook (review-17): drop the one-thesis unique index to simulate a
 *  LEGACY DB where it could not be created (pre-existing duplicate working
 *  rows). The defensive stacked-row handling — manual-exit attribution,
 *  ambiguity refusals, the triage double-close guard — must stay tested
 *  even though new DBs make the state unrepresentable. Test-only by
 *  contract. */
export async function __dropOneThesisIndexForTests(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') throw new Error('[proposals] __dropOneThesisIndexForTests is test-only');
    (await getDb()).exec('DROP INDEX IF EXISTS ux_one_working_thesis');
}

/** Test hook counterpart: restore the index (suites share one store, so a
 *  legacy-DB simulation must not leak into the suites that test the LAW).
 *  Throws if working duplicates exist — the caller's fixtures are dirty. */
export async function __recreateOneThesisIndexForTests(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') throw new Error('[proposals] __recreateOneThesisIndexForTests is test-only');
    (await getDb()).exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_one_working_thesis
         ON proposals(symbol) WHERE status IN ('executing', 'executed')`,
    );
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
