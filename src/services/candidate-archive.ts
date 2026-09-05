/**
 * Eligible-candidate archive (REQ-BENCH-001..003, WP7; audit AUD-13).
 *
 * The scanner surfaces candidates all day; the judgment admits a few; the
 * rest leave no trace — so "did the overnight lane pick well among what it
 * could see?" has no data, and a gate-off variant of a refusal is not a
 * universe. This module captures the observable universe point-in-time,
 * BEFORE the close, on EVERY pre-close opportunity snapshot (review
 * 2026-09-06, finding 8 — a single 15:35 capture missed names seen at 15:10
 * and gone by 15:35, and half-days close at 13:00):
 *
 *   overnight lane      each pre-close snapshot's scored candidates; a
 *                       symbol's FIRST sighting of the day stands (price,
 *                       rank and levels as first observed), the snapshot
 *                       timestamp is the row's source
 *   cup-and-handle lane the latest nightly pattern scan (cup matches only,
 *                       detector version and state), once per day
 *
 * Each row carries what was OBSERVED (price, daily ATR, day move, rank), a
 * deterministic eligibility verdict with reasons, the lane's mechanical
 * levels and their version, and later the disposition (what the system did
 * with the symbol that day) and the mechanical twin's outcome (the
 * overnight benchmark fills it). Nothing archived is ever re-priced. Each
 * proposal records the snapshot it was created against (`snapshot_ts`), so
 * the judgment's universe is a captured one.
 *
 * Its own SQLite file (`candidate-archive.db`), no order ids, and no look,
 * ladder or verdict reads it (REQ-BENCH-006). Disable with
 * CANDIDATE_ARCHIVE=false.
 */

import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RiskRules } from '@/tools/ibkr/risk-rules.js';
import { logger } from '@/utils';
import { isMarketHoliday } from '@/utils/market-hours.js';
import { laneExitDeadline } from './lane-contract.js';
import { RANKER_VERSIONS } from './lane-rankers.js';
import type { OpportunitySnapshot } from './opportunity-engine.js';
import type { PatternScanSnapshot } from './pattern-scanner.js';
import { formulaTakePct } from './proposal-risk-gate.js';
import { assertTestDataDirIsTemp } from './trade-proposals.js';

const ET = 'America/New_York';
/** v2 (review 2026-09-06, finding 7): the stop honours the gate's minimum R:R. */
export const CANDIDATE_LEVELS_VERSION = 'v2';
/** Rows still pending after this many days are marked unknown (bars gone). */
export const CANDIDATE_REPLAY_HORIZON_DAYS = 5;

export type CandidateLane = 'overnight' | 'cup-and-handle';
export type CandidateDisposition = 'pending' | 'proposed' | 'refused' | 'not-admitted';
export type CandidateReplayStatus = 'pending' | 'settled' | 'unknown' | 'skipped';

export interface CandidateRow {
    id?: number;
    /** ET ISO date of the capture — the selection day. */
    day: string;
    lane: CandidateLane;
    symbol: string;
    direction: 'long' | 'short';
    /** Epoch ms of the capture. */
    capturedAt: number;
    /** Where the row came from, with the source's own timestamp. */
    source: string;
    /** The lane's rank at capture: the overnight ranker's score (WP8), else
     *  the composite; the pattern score for the cup lane. */
    rank: number | null;
    /** REQ-DISC-003: which ranker produced `rank`. */
    rankerVersion: string | null;
    /** Reference price observed at capture. */
    price: number;
    dailyAtr: number | null;
    /** Signed toward `direction` (positive = with the move). */
    dayMovePct: number | null;
    eligible: boolean;
    /** Rejection reasons; informational entries are prefixed `note:`. */
    reasons: string[];
    levelsVersion: string;
    entryType: 'MKT' | 'STP_LMT';
    entry: number | null;
    entryLimit: number | null;
    stop: number | null;
    target: number | null;
    /** Epoch ms of the lane deadline as if filled at capture. */
    exitDeadline: number | null;
    /** Cup lane: detector version and setup state at the scan. */
    detectorVersion: string | null;
    state: string | null;
    disposition: CandidateDisposition;
    dispositionRef: string | null;
    replayStatus: CandidateReplayStatus;
    barSource: string | null;
    fillAt: number | null;
    fillPrice: number | null;
    exitAt: number | null;
    exitPrice: number | null;
    outcome: string | null;
    /** Next session's first-bar open vs the capture price, % signed toward the direction. */
    gapPct: number | null;
    quantity: number | null;
    commissions: number | null;
    netUsd: number | null;
    netR: number | null;
    /** (exit − fill) / |price − stop| signed toward the direction — the
     *  SIZE-INVARIANT label (review 2026-09-06, finding 9); netR at the rung
     *  is informational (min commissions and whole shares make it size-dependent). */
    grossR: number | null;
    mfePct: number | null;
    maePct: number | null;
    replayedAt: number | null;
    note: string | null;
}

// ---------------------------------------------------------------------------
// Pure: eligibility and mechanical levels
// ---------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100;

export function etDayIso(ms: number): string {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: ET });
}

export interface OvernightCandidateInput {
    symbol: string;
    direction: 'long' | 'short';
    compositeRank: number;
    price: number | null;
    stale: boolean;
    dayMovePct: number | null;
    dailyAtr: number | null;
    /** Reports within 2 days (calendar); null = unknown. */
    earningsWithin2d: boolean | null;
}

/** REQ-BENCH-002: the deterministic subset of the overnight lane's rules.
 *  LLM reasons are never reconstructed; this is what a machine can say. */
export function overnightEligibility(c: OvernightCandidateInput, rules: Pick<RiskRules, 'min_price'>): { eligible: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (c.stale) reasons.push('stale-data');
    if (c.price === null || !(c.price > 0)) reasons.push('price-missing');
    else if (c.price < rules.min_price) reasons.push('min-price');
    if (c.dailyAtr === null || !(c.dailyAtr > 0)) reasons.push('atr-missing');
    if (c.dayMovePct === null) reasons.push('day-move-unknown');
    else if (c.dayMovePct <= 0) reasons.push('counter-move');
    if (c.earningsWithin2d === true) reasons.push('earnings-within-2d');
    const eligible = reasons.length === 0;
    if (eligible && c.earningsWithin2d === null) reasons.push('note:earnings-unknown');
    return { eligible, reasons };
}

export interface MechanicalLevels {
    entryType: 'MKT' | 'STP_LMT';
    entry: number | null;
    entryLimit: number | null;
    stop: number;
    target: number;
}

/** REQ-BENCH-004 (levels v2 — review 2026-09-06, finding 7): MKT at the next
 *  bar ("buy before the close"), target at take-x, and the stop at the
 *  distance the GATE would accept: min(`stop_atr_multiplier` × ATR, take
 *  distance / `min_risk_reward`), so the twin's R:R meets the gate's
 *  minimum instead of the 1:1 of v1 (stop 1.5 ATR, target 1.5 ATR). Null
 *  when the geometry is impossible or the stop would sit inside the noise
 *  filter (`min_stop_atr_fraction`) — the gate would refuse that trade, so
 *  the benchmark must not build it. */
export function overnightLevels(
    input: { price: number; dailyAtr: number; direction: 'long' | 'short' },
    rules: Pick<RiskRules, 'stop_atr_multiplier' | 'take_atr_mult' | 'take_floor_pct' | 'take_cap_pct' | 'min_risk_reward' | 'min_stop_atr_fraction'>,
): MechanicalLevels | null {
    const sign = input.direction === 'long' ? 1 : -1;
    const takePct = formulaTakePct((input.dailyAtr / input.price) * 100, rules as RiskRules);
    const takeDist = (input.price * takePct) / 100;
    const stopDist = Math.min(rules.stop_atr_multiplier * input.dailyAtr, takeDist / Math.max(1e-9, rules.min_risk_reward));
    if (stopDist < rules.min_stop_atr_fraction * input.dailyAtr) return null; // noise stop — the gate refuses it
    const stop = r2(input.price - sign * stopDist);
    const target = r2(input.price * (1 + (sign * takePct) / 100));
    if (!(stop > 0) || !(target > 0)) return null;
    if (input.direction === 'long' ? !(stop < input.price && target > input.price) : !(stop > input.price && target < input.price)) return null;
    return { entryType: 'MKT', entry: null, entryLimit: null, stop, target };
}

/** Cup lane v1: STP_LMT at the detector's suggested trigger with a 0.5 %
 *  limit band, stop at the structure low, 2R mechanical target. */
export function cupLevels(m: { suggestedEntry: number; suggestedStop: number }): MechanicalLevels | null {
    const risk = m.suggestedEntry - m.suggestedStop;
    if (!(m.suggestedEntry > 0) || !(risk > 0)) return null;
    return {
        entryType: 'STP_LMT',
        entry: r2(m.suggestedEntry),
        entryLimit: r2(m.suggestedEntry * 1.005),
        stop: r2(m.suggestedStop),
        target: r2(m.suggestedEntry + 2 * risk),
    };
}

export function cupEligibility(input: { scanRanAt: number; capturedAt: number; hasCup: boolean }): { eligible: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (!input.hasCup) reasons.push('not-cup');
    // The scan is nightly: one older than 36 h missed a session.
    if (input.capturedAt - input.scanRanAt > 36 * 3_600_000) reasons.push('stale-scan');
    return { eligible: reasons.length === 0, reasons };
}

export interface CaptureContext {
    capturedAt: number;
    rules: RiskRules;
    /** Symbol → daily ATR (null = unavailable). */
    dailyAtr: Map<string, number | null>;
    /** Symbol → earnings within 2 days (null = calendar unknown). */
    earnings: Map<string, boolean | null>;
}

function blankRow(base: Pick<CandidateRow, 'day' | 'lane' | 'symbol' | 'direction' | 'capturedAt' | 'source' | 'rank' | 'rankerVersion' | 'price' | 'dailyAtr' | 'dayMovePct' | 'eligible' | 'reasons'>): CandidateRow {
    return {
        ...base,
        levelsVersion: CANDIDATE_LEVELS_VERSION,
        entryType: 'MKT', entry: null, entryLimit: null, stop: null, target: null, exitDeadline: null,
        detectorVersion: null, state: null,
        disposition: 'pending', dispositionRef: null,
        replayStatus: base.eligible ? 'pending' : 'skipped',
        barSource: null, fillAt: null, fillPrice: null, exitAt: null, exitPrice: null, outcome: null, gapPct: null,
        quantity: null, commissions: null, netUsd: null, netR: null, grossR: null, mfePct: null, maePct: null, replayedAt: null, note: null,
    };
}

/** REQ-BENCH-001: the overnight universe from a pre-close snapshot. One row
 *  per symbol (the higher rank wins a duplicate). */
export function candidatesFromSnapshot(snapshot: OpportunitySnapshot, ctx: CaptureContext): CandidateRow[] {
    const day = etDayIso(ctx.capturedAt);
    const bySymbol = new Map<string, OpportunitySnapshot['opportunities'][number]>();
    for (const o of snapshot.opportunities) {
        const sym = o.symbol.toUpperCase();
        const cur = bySymbol.get(sym);
        if (!cur || o.compositeRank > cur.compositeRank) bySymbol.set(sym, o);
    }
    const rows: CandidateRow[] = [];
    const lane = snapshot.lanes?.overnight ?? null;
    for (const [sym, o] of bySymbol) {
        const dailyAtr = ctx.dailyAtr.get(sym) ?? null;
        const verdict = overnightEligibility({
            symbol: sym, direction: o.direction, compositeRank: o.compositeRank, price: o.price, stale: o.stale,
            dayMovePct: o.dayMovePct, dailyAtr, earningsWithin2d: ctx.earnings.has(sym) ? (ctx.earnings.get(sym) ?? null) : null,
        }, ctx.rules);
        // REQ-DISC-003: the lane's own score when the snapshot carries the
        // lane ranking (WP8); an excluded or pre-WP8 row keeps the composite
        // with its provenance — never a mixed cohort without a label.
        const laneScore = lane?.ranked.find((r) => r.symbol.toUpperCase() === sym)?.score ?? null;
        const row = blankRow({
            day, lane: 'overnight', symbol: sym, direction: o.direction, capturedAt: ctx.capturedAt,
            source: `opportunity-snapshot:${snapshot.phase}@${snapshot.timestamp}`,
            rank: laneScore ?? o.compositeRank,
            rankerVersion: laneScore !== null && lane ? lane.rankerVersion : RANKER_VERSIONS.intraday,
            price: o.price ?? 0, dailyAtr, dayMovePct: o.dayMovePct, eligible: verdict.eligible, reasons: verdict.reasons,
        });
        if (verdict.eligible && o.price !== null && dailyAtr !== null) {
            const levels = overnightLevels({ price: o.price, dailyAtr, direction: o.direction }, ctx.rules);
            if (!levels) {
                row.eligible = false; row.reasons = [...row.reasons.filter((r) => !r.startsWith('note:')), 'levels-invalid']; row.replayStatus = 'skipped';
            } else {
                Object.assign(row, levels);
                row.exitDeadline = laneExitDeadline('overnight', ctx.capturedAt, ctx.rules);
            }
        }
        rows.push(row);
    }
    return rows;
}

/** REQ-BENCH-001: the cup-and-handle universe from the nightly pattern scan
 *  (cup matches only; archived, not replayed in WP7). */
export function candidatesFromPatternScan(scan: PatternScanSnapshot, ctx: CaptureContext): CandidateRow[] {
    const day = etDayIso(ctx.capturedAt);
    const rows: CandidateRow[] = [];
    for (const c of scan.candidates) {
        const cup = c.matches.find((m) => m.pattern === 'cup-and-handle');
        if (!cup) continue; // other patterns are not this lane's universe
        const verdict = cupEligibility({ scanRanAt: scan.ranAt, capturedAt: ctx.capturedAt, hasCup: true });
        const row = blankRow({
            day, lane: 'cup-and-handle', symbol: c.symbol.toUpperCase(), direction: 'long', capturedAt: ctx.capturedAt,
            source: `pattern-scan@${scan.ranAt}`, rank: cup.score, rankerVersion: RANKER_VERSIONS['cup-and-handle'],
            price: c.close, dailyAtr: c.dailyAtr, dayMovePct: null, eligible: verdict.eligible, reasons: verdict.reasons,
        });
        row.detectorVersion = cup.detectorVersion;
        row.state = cup.state;
        const levels = cupLevels(cup);
        if (levels) {
            Object.assign(row, levels);
            row.exitDeadline = laneExitDeadline('cup-and-handle', ctx.capturedAt, ctx.rules);
        } else if (row.eligible) {
            row.eligible = false; row.reasons = [...row.reasons, 'levels-invalid'];
        }
        // WP7 replays the overnight lane only; cup rows are archived.
        row.replayStatus = 'skipped';
        rows.push(row);
    }
    return rows;
}

export interface DispositionLedger {
    proposals: Array<{ id: string; symbol: string; direction: 'long' | 'short'; strategyId: string | null; createdAt: number; snapshotTs?: number | null }>;
    refusals: Array<{ symbol: string; direction: 'long' | 'short'; createdAt: number; gate: string }>;
}

/** The snapshot timestamp a row was first captured from (`…@<ts>` in `source`). */
export function sourceSnapshotTs(row: Pick<CandidateRow, 'source' | 'capturedAt'>): number {
    const m = /@(\d+)$/.exec(row.source);
    return m ? Number(m[1]) : row.capturedAt;
}

/** REQ-BENCH-003 (amended 2026-09-06, second pass, finding 4): what the
 *  system did with THIS candidate — same symbol, same lane, same DIRECTION,
 *  and a decision taken against a universe that already contained the row
 *  (the proposal's `snapshotTs`, else its creation, is not earlier than the
 *  snapshot the row was first captured from). Overnight: such a proposal →
 *  proposed; a same-day refusal in the pre-close window (≥ 15:00 ET) after
 *  the capture → refused:<gate>; else not-admitted. Cup: a cup-lane
 *  proposal on the day or the next (the Pre-Market Brief proposes the
 *  morning after the scan). A late short is never attributed to the
 *  morning's long candidate, and a proposal made before the row existed is
 *  not a pick from this universe. */
export function disposeCandidates(rows: CandidateRow[], ledger: DispositionLedger): CandidateRow[] {
    return rows.map((row) => {
        const sym = row.symbol.toUpperCase();
        const dayOf = (ms: number) => etDayIso(ms);
        const rowTs = sourceSnapshotTs(row);
        const nextDayOk = (ms: number) => row.lane === 'cup-and-handle' && ms > row.capturedAt && ms - row.capturedAt < 2 * 86_400_000;
        const proposal = ledger.proposals.find((p) =>
            p.symbol.toUpperCase() === sym && p.strategyId === row.lane && p.direction === row.direction
            && (dayOf(p.createdAt) === row.day || nextDayOk(p.createdAt))
            && (p.snapshotTs ?? p.createdAt) >= rowTs);
        if (proposal) return { ...row, disposition: 'proposed', dispositionRef: proposal.id };
        const refusal = ledger.refusals.find((r) => {
            if (r.symbol.toUpperCase() !== sym || r.direction !== row.direction || dayOf(r.createdAt) !== row.day || r.createdAt < rowTs) return false;
            if (row.lane !== 'overnight') return true;
            const et = new Date(new Date(r.createdAt).toLocaleString('en-US', { timeZone: ET }));
            return et.getHours() >= 15;
        });
        if (refusal) return { ...row, disposition: 'refused', dispositionRef: refusal.gate };
        return { ...row, disposition: 'not-admitted', dispositionRef: null };
    });
}

// ---------------------------------------------------------------------------
// Store (its own SQLite file)
// ---------------------------------------------------------------------------

interface SqliteQuery<T> { all(...params: unknown[]): T[]; run(...params: unknown[]): void }
interface SqliteDatabase { exec(sql: string): void; query<T>(sql: string): SqliteQuery<T>; close(): void }

let db: SqliteDatabase | null = null;

export function candidateArchiveDbPath(dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data')): string {
    return join(dataDir, 'candidate-archive.db');
}

async function getDb(): Promise<SqliteDatabase> {
    if (db) return db;
    assertTestDataDirIsTemp(process.env.DEXTER_DATA_DIR, process.env.NODE_ENV, tmpdir());
    const dbPath = candidateArchiveDbPath();
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
                return { all: (...params: unknown[]) => stmt.all(...params) as T[], run: (...params: unknown[]) => { stmt.run(...params); } };
            },
            close: () => raw.close(),
        };
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS candidates (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            day              TEXT NOT NULL,
            lane             TEXT NOT NULL,
            symbol           TEXT NOT NULL,
            direction        TEXT NOT NULL,
            captured_at      INTEGER NOT NULL,
            source           TEXT NOT NULL,
            rank             REAL,
            ranker_version   TEXT,
            price            REAL NOT NULL,
            daily_atr        REAL,
            day_move_pct     REAL,
            eligible         INTEGER NOT NULL,
            reasons          TEXT NOT NULL,
            levels_version   TEXT NOT NULL,
            entry_type       TEXT NOT NULL,
            entry            REAL,
            entry_limit      REAL,
            stop             REAL,
            target           REAL,
            exit_deadline    INTEGER,
            detector_version TEXT,
            state            TEXT,
            disposition      TEXT NOT NULL,
            disposition_ref  TEXT,
            replay_status    TEXT NOT NULL,
            bar_source       TEXT,
            fill_at          INTEGER,
            fill_price       REAL,
            exit_at          INTEGER,
            exit_price       REAL,
            outcome          TEXT,
            gap_pct          REAL,
            quantity         INTEGER,
            commissions      REAL,
            net_usd          REAL,
            net_r            REAL,
            gross_r          REAL,
            mfe_pct          REAL,
            mae_pct          REAL,
            replayed_at      INTEGER,
            note             TEXT,
            UNIQUE (day, lane, symbol)
        );
        CREATE INDEX IF NOT EXISTS ix_candidates_lane_status ON candidates (lane, replay_status);
        CREATE INDEX IF NOT EXISTS ix_candidates_day ON candidates (day);
    `);
    // WP8 column on a WP7 table: additive, idempotent (an archive created
    // before the column existed gets it; SQLite refuses a duplicate add).
    try { db.exec('ALTER TABLE candidates ADD COLUMN ranker_version TEXT'); } catch { /* already present */ }
    try { db.exec('ALTER TABLE candidates ADD COLUMN gross_r REAL'); } catch { /* already present */ }
    return db;
}

interface Row {
    id: number; day: string; lane: string; symbol: string; direction: string; captured_at: number; source: string; rank: number | null;
    ranker_version: string | null; price: number; daily_atr: number | null; day_move_pct: number | null; eligible: number; reasons: string; levels_version: string;
    entry_type: string; entry: number | null; entry_limit: number | null; stop: number | null; target: number | null; exit_deadline: number | null;
    detector_version: string | null; state: string | null; disposition: string; disposition_ref: string | null; replay_status: string;
    bar_source: string | null; fill_at: number | null; fill_price: number | null; exit_at: number | null; exit_price: number | null;
    outcome: string | null; gap_pct: number | null; quantity: number | null; commissions: number | null; net_usd: number | null;
    net_r: number | null; gross_r: number | null; mfe_pct: number | null; mae_pct: number | null; replayed_at: number | null; note: string | null;
}

function fromRow(r: Row): CandidateRow {
    let reasons: string[] = [];
    try { reasons = JSON.parse(r.reasons) as string[]; } catch { reasons = []; }
    return {
        id: r.id, day: r.day, lane: r.lane === 'cup-and-handle' ? 'cup-and-handle' : 'overnight', symbol: r.symbol,
        direction: r.direction === 'short' ? 'short' : 'long', capturedAt: r.captured_at, source: r.source, rank: r.rank, rankerVersion: r.ranker_version ?? null, price: r.price,
        dailyAtr: r.daily_atr, dayMovePct: r.day_move_pct, eligible: r.eligible === 1, reasons, levelsVersion: r.levels_version,
        entryType: r.entry_type === 'STP_LMT' ? 'STP_LMT' : 'MKT', entry: r.entry, entryLimit: r.entry_limit, stop: r.stop, target: r.target,
        exitDeadline: r.exit_deadline, detectorVersion: r.detector_version, state: r.state,
        disposition: (r.disposition as CandidateDisposition) ?? 'pending', dispositionRef: r.disposition_ref,
        replayStatus: (r.replay_status as CandidateReplayStatus) ?? 'pending', barSource: r.bar_source, fillAt: r.fill_at, fillPrice: r.fill_price,
        exitAt: r.exit_at, exitPrice: r.exit_price, outcome: r.outcome, gapPct: r.gap_pct, quantity: r.quantity, commissions: r.commissions,
        netUsd: r.net_usd, netR: r.net_r, grossR: r.gross_r ?? null, mfePct: r.mfe_pct, maePct: r.mae_pct, replayedAt: r.replayed_at, note: r.note,
    };
}

/** REQ-BENCH-001: INSERT OR IGNORE — the first capture of (day, lane, symbol) stands. Returns the inserted count. */
export async function insertCandidates(rows: CandidateRow[]): Promise<number> {
    const database = await getDb();
    let inserted = 0;
    for (const c of rows) {
        const before = database.query<{ n: number }>(`SELECT COUNT(*) AS n FROM candidates WHERE day = ? AND lane = ? AND symbol = ?`).all(c.day, c.lane, c.symbol)[0]?.n ?? 0;
        if (before > 0) continue;
        database.query<void>(
            `INSERT OR IGNORE INTO candidates (day, lane, symbol, direction, captured_at, source, rank, ranker_version, price, daily_atr, day_move_pct, eligible, reasons,
                levels_version, entry_type, entry, entry_limit, stop, target, exit_deadline, detector_version, state, disposition, disposition_ref,
                replay_status, bar_source, fill_at, fill_price, exit_at, exit_price, outcome, gap_pct, quantity, commissions, net_usd, net_r, gross_r, mfe_pct, mae_pct, replayed_at, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            c.day, c.lane, c.symbol, c.direction, c.capturedAt, c.source, c.rank, c.rankerVersion, c.price, c.dailyAtr, c.dayMovePct, c.eligible ? 1 : 0, JSON.stringify(c.reasons),
            c.levelsVersion, c.entryType, c.entry, c.entryLimit, c.stop, c.target, c.exitDeadline, c.detectorVersion, c.state, c.disposition, c.dispositionRef,
            c.replayStatus, c.barSource, c.fillAt, c.fillPrice, c.exitAt, c.exitPrice, c.outcome, c.gapPct, c.quantity, c.commissions, c.netUsd, c.netR, c.grossR, c.mfePct, c.maePct, c.replayedAt, c.note,
        );
        inserted++;
    }
    return inserted;
}

export async function listCandidates(filter: { day?: string; lane?: CandidateLane; replayStatus?: CandidateReplayStatus; sinceDay?: string }): Promise<CandidateRow[]> {
    const database = await getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.day) { where.push('day = ?'); params.push(filter.day); }
    if (filter.sinceDay) { where.push('day >= ?'); params.push(filter.sinceDay); }
    if (filter.lane) { where.push('lane = ?'); params.push(filter.lane); }
    if (filter.replayStatus) { where.push('replay_status = ?'); params.push(filter.replayStatus); }
    const sql = `SELECT * FROM candidates${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY day, lane, rank DESC, symbol`;
    return database.query<Row>(sql).all(...params).map(fromRow);
}

/** Distinct capture days of a lane, newest first. */
export async function listCandidateDays(lane: CandidateLane): Promise<string[]> {
    const database = await getDb();
    return database.query<{ day: string }>(`SELECT DISTINCT day FROM candidates WHERE lane = ? ORDER BY day DESC`).all(lane).map((r) => r.day);
}

/** Eligible symbols of a day's lane universe (the archive scheduler keeps their next-session bars). */
export async function listEligibleCandidateSymbols(day: string, lane: CandidateLane): Promise<string[]> {
    const database = await getDb();
    return database.query<{ symbol: string }>(`SELECT symbol FROM candidates WHERE day = ? AND lane = ? AND eligible = 1 ORDER BY rank DESC`).all(day, lane).map((r) => r.symbol);
}

export type CandidatePatch = Partial<Pick<CandidateRow,
    'disposition' | 'dispositionRef' | 'replayStatus' | 'barSource' | 'fillAt' | 'fillPrice' | 'exitAt' | 'exitPrice' | 'outcome' | 'gapPct'
    | 'quantity' | 'commissions' | 'netUsd' | 'netR' | 'grossR' | 'mfePct' | 'maePct' | 'replayedAt' | 'note'>>;

const PATCH_COLUMNS: Record<keyof CandidatePatch, string> = {
    disposition: 'disposition', dispositionRef: 'disposition_ref', replayStatus: 'replay_status', barSource: 'bar_source', fillAt: 'fill_at',
    fillPrice: 'fill_price', exitAt: 'exit_at', exitPrice: 'exit_price', outcome: 'outcome', gapPct: 'gap_pct', quantity: 'quantity',
    commissions: 'commissions', netUsd: 'net_usd', netR: 'net_r', grossR: 'gross_r', mfePct: 'mfe_pct', maePct: 'mae_pct', replayedAt: 'replayed_at', note: 'note',
};

/** Replay outcomes and dispositions land here; captured fields are never touched. */
export async function updateCandidate(id: number, patch: CandidatePatch): Promise<void> {
    const keys = (Object.keys(patch) as Array<keyof CandidatePatch>).filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return;
    const database = await getDb();
    database.query<void>(`UPDATE candidates SET ${keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => patch[k] as unknown), id);
}

// ---------------------------------------------------------------------------
// Capture (dependency-injected; the cron supplies the live pieces)
// ---------------------------------------------------------------------------

export interface CaptureDeps {
    now: number;
    rules: RiskRules;
    latestSnapshot(): OpportunitySnapshot | null;
    latestPatternScan(): PatternScanSnapshot | null;
    dailyAtrFor(symbol: string): Promise<number | null>;
    /** Symbols → reports within 2 days (null per symbol when the calendar is unknown). */
    earningsWithin2d(symbols: string[]): Promise<Map<string, boolean | null>>;
    insert(rows: CandidateRow[]): Promise<number>;
}

export interface CaptureCounts {
    day: string;
    overnight: { seen: number; eligible: number; inserted: number; skipped: string | null };
    cup: { seen: number; eligible: number; inserted: number; skipped: string | null };
}

/** REQ-BENCH-001: one capture; a snapshot that is not today's pre-close one
 *  yields no overnight universe (reported, never backfilled). */
export async function captureCandidatesOnce(deps: CaptureDeps): Promise<CaptureCounts> {
    const day = etDayIso(deps.now);
    const counts: CaptureCounts = {
        day,
        overnight: { seen: 0, eligible: 0, inserted: 0, skipped: null },
        cup: { seen: 0, eligible: 0, inserted: 0, skipped: null },
    };
    const snap = deps.latestSnapshot();
    if (!snap) counts.overnight.skipped = 'no opportunity snapshot in memory';
    else if (snap.phase !== 'pre-close') counts.overnight.skipped = `latest snapshot is '${snap.phase}', not pre-close`;
    else if (etDayIso(snap.timestamp) !== day) counts.overnight.skipped = `latest pre-close snapshot is from ${etDayIso(snap.timestamp)}`;
    else {
        const symbols = [...new Set(snap.opportunities.map((o) => o.symbol.toUpperCase()))];
        const dailyAtr = new Map<string, number | null>();
        for (const s of symbols) dailyAtr.set(s, await deps.dailyAtrFor(s).catch(() => null));
        const earnings = await deps.earningsWithin2d(symbols).catch(() => new Map<string, boolean | null>());
        const rows = candidatesFromSnapshot(snap, { capturedAt: deps.now, rules: deps.rules, dailyAtr, earnings });
        counts.overnight.seen = rows.length;
        counts.overnight.eligible = rows.filter((r) => r.eligible).length;
        counts.overnight.inserted = await deps.insert(rows);
    }
    const scan = deps.latestPatternScan();
    if (!scan) counts.cup.skipped = 'no pattern scan snapshot';
    else {
        const rows = candidatesFromPatternScan(scan, { capturedAt: deps.now, rules: deps.rules, dailyAtr: new Map(), earnings: new Map() });
        counts.cup.seen = rows.length;
        counts.cup.eligible = rows.filter((r) => r.eligible).length;
        counts.cup.inserted = await deps.insert(rows);
    }
    return counts;
}

export function isCandidateArchiveEnabled(): boolean {
    return (process.env.CANDIDATE_ARCHIVE ?? '').trim().toLowerCase() !== 'false';
}

async function liveDeps(): Promise<CaptureDeps> {
    const { getRiskRules } = await import('@/tools/ibkr/risk-rules.js');
    const { getLatestSnapshot } = await import('./opportunity-engine.js');
    const { getLatestPatternScan } = await import('./pattern-scanner.js');
    const { fetchDailyRiskContext } = await import('@/tools/ibkr/daily-atr.js');
    const { findUpcomingEarnings } = await import('./earnings-calendar.js');
    return {
        now: Date.now(),
        rules: getRiskRules(),
        latestSnapshot: getLatestSnapshot,
        latestPatternScan: getLatestPatternScan,
        dailyAtrFor: async (symbol) => (await fetchDailyRiskContext(symbol)).dailyAtr,
        earningsWithin2d: async (symbols) => {
            const out = new Map<string, boolean | null>();
            try {
                const r = await findUpcomingEarnings(symbols, 2);
                const hits = new Set(r.hits.map((h) => h.symbol.toUpperCase()));
                const unknown = r.unknownDays.length > 0;
                for (const s of symbols) out.set(s, hits.has(s) ? true : unknown ? null : false);
            } catch {
                for (const s of symbols) out.set(s, null);
            }
            return out;
        },
        insert: insertCandidates,
    };
}

/** One live capture (exported for scripts and the engine hook). With a
 *  snapshot supplied, THAT snapshot is the source (the engine passes each
 *  pre-close snapshot as it lands); without one, the engine's latest. */
export async function runCandidateCaptureOnce(snapshot?: OpportunitySnapshot): Promise<CaptureCounts | null> {
    const today = etDayIso(Date.now());
    if (isMarketHoliday(today)) return null;
    const deps = await liveDeps();
    const counts = await captureCandidatesOnce(snapshot ? { ...deps, latestSnapshot: () => snapshot } : deps);
    if (counts.overnight.inserted > 0 || counts.cup.inserted > 0 || counts.overnight.skipped) {
        logger.info(
            `[candidate-archive] ${counts.day}: overnight +${counts.overnight.inserted}/${counts.overnight.seen} archived (${counts.overnight.eligible} eligible)` +
            `${counts.overnight.skipped ? ` — ${counts.overnight.skipped}` : ''}; cup +${counts.cup.inserted}/${counts.cup.seen}` +
            `${counts.cup.skipped ? ` — ${counts.cup.skipped}` : ''}`,
        );
    }
    return counts;
}

let unsubscribe: (() => void) | null = null;

/** REQ-BENCH-001 (amended 2026-09-06): capture on EVERY pre-close snapshot
 *  the engine produces — first sighting per symbol per day stands. */
export function startCandidateArchive(): void {
    if (unsubscribe || !isCandidateArchiveEnabled()) return;
    void import('./opportunity-engine.js').then(({ onSnapshot }) => {
        if (unsubscribe) return;
        unsubscribe = onSnapshot((snap) => {
            if (snap.phase !== 'pre-close') return;
            runCandidateCaptureOnce(snap).catch((err) => logger.error(`[candidate-archive] capture failed: ${err}`));
        });
        logger.info('[candidate-archive] armed: point-in-time universe capture on every pre-close snapshot (overnight + cup-and-handle lanes)');
    });
}

export function stopCandidateArchive(): void {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
}
