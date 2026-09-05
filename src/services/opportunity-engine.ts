/**
 * Opportunity Engine — continuous, deterministic market scanning and ranking.
 *
 * Runs a session-aware loop (no LLM involved):
 *   scan (IBKR scanners, multi-code) → dedupe/filter → score (signal_scorer
 *   pipeline) → composite ranking → persisted snapshot (SQLite) → top-N
 *   subscribed to ibkr-stream for realtime freshness.
 *
 * Consumers:
 *   - the `opportunities` agent tool (latest / refresh)
 *   - the 09:35 and 15:30 trading cron jobs (ranked briefs)
 *   - (Lot 2) event triggers when a candidate crosses a score threshold
 *
 * Advisory by construction: this service never places orders.
 *
 * Environment:
 *   OPPORTUNITY_ENGINE   'false' disables the gateway auto-start (default on)
 *   OPP_TOP_N            ranked candidates kept/streamed (default 8)
 *   OPP_MAX_CANDIDATES   max symbols scored per cycle, IBKR pacing (default 20)
 */

import { createSignalScorer, type SignalResult } from '@/tools/ibkr/signal-scorer.js';
import { logger } from '@/utils';
import { getMarketSession, isTradeableSession, MarketSession } from '@/utils/market-hours.js';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { addSymbol, removeSymbol } from './ibkr-stream.js';
import { breadthFireAllowed, breadthThresholdRelief, breadthWatchlist, cryptoBreadthEvent, detectBreadth, regimeBreadthEvent, type BreadthEvent } from './breadth-detector.js';
import { getMarketRegime, regimeThresholdAdjust } from './market-regime.js';
import { moverAlertEligible, SENTINEL_SOURCE, sentinelDirection, significanceSuppressed, significanceTerm } from './event-mover.js';
import { minutesSinceOpenEt } from './entry-context.js';
import { complexAdmission, complexesOf, isVehicle, loadVehicleComplexes } from './vehicle-complexes.js';
import { fetchDailyRiskContext } from '@/tools/ibkr/daily-atr.js';
import { getRiskRules } from '@/tools/ibkr/risk-rules.js';
import { fetchLastPrice } from './proposal-executor.js';
import { runScan, type ScanCode, type ScanResult } from './scanner-loop.js';
import { etDatePlus, getEarningsForDate, previousTradingDate } from './earnings-calendar.js';

// ---------------------------------------------------------------------------
// Earnings reactors — names that printed last night (AMC) or this morning
// (BMO). Capture reports 2026-08-06/07: 7 of 15 top movers were reactors the
// scanners NEVER SAW, and TEAM sat at rank 84 in 4th place where only the
// top-3 are trigger-eligible. Reactors get candidate priority, trigger
// eligibility to REACTOR_TRIGGER_DEPTH, and threshold relief.
// ---------------------------------------------------------------------------

const REACTOR_TRIGGER_DEPTH = 10;

function reactorRelief(): number {
    const n = Number(process.env.OPP_REACTOR_RELIEF);
    return Number.isFinite(n) && n >= 0 ? n : 10;
}

/** Extra composite-rank points a NON-reactor must clear to trigger from
 *  rank positions 3..9 (the deep window). 0 = deep window at the base
 *  threshold; NEGATIVE = disable the deep window (old top-3-only rule). */
function deepTriggerMargin(): number {
    const n = Number(process.env.OPP_DEEP_TRIGGER_MARGIN);
    return Number.isFinite(n) ? n : 5;
}

/**
 * Pure: is the candidate at rank position `idx` trigger-eligible, and at
 * what effective threshold? Three windows:
 *   - top-3: base threshold, breadth-watchlist relief applies (historical
 *     behavior — the window that discards nothing it already ranked high);
 *   - positions 3..depth-1: reactors keep their relief (a fresh print is
 *     its own catalyst — the TEAM lesson, 2026-08-07); non-reactors are
 *     now eligible too but must clear threshold + deepMargin — depth
 *     costs conviction, it is not free (ABCL 83 and LINC 84 beat the 75
 *     bar from rank 4+ and never fired; capture ledger 2026-08-10). No
 *     breadth relief in the deep window: relieving AND deepening at once
 *     would reopen the noise the top-3 window existed to keep out;
 *   - at/beyond depth: nobody.
 */
export function triggerEligibility(input: {
    idx: number;
    isReactor: boolean;
    onBreadthWatchlist: boolean;
    threshold: number;
    breadthRelief: number;
    reactorReliefPts: number;
    deepMargin: number;
    depth: number;
    /** WP10: scorer freshness verdict — stale data fires nothing. */
    stale?: boolean;
}): { eligible: boolean; effectiveThreshold: number } {
    if (input.stale) return { eligible: false, effectiveThreshold: Infinity };
    if (input.idx >= input.depth) return { eligible: false, effectiveThreshold: Infinity };
    const base = input.onBreadthWatchlist ? input.threshold - input.breadthRelief : input.threshold;
    if (input.isReactor) {
        return { eligible: true, effectiveThreshold: Math.min(base, input.threshold - input.reactorReliefPts) };
    }
    if (input.idx < 3) return { eligible: true, effectiveThreshold: base };
    if (input.deepMargin < 0) return { eligible: false, effectiveThreshold: Infinity }; // deep window disabled
    return { eligible: true, effectiveThreshold: input.threshold + input.deepMargin };
}

let reactorCacheDate = '';
let reactorCache = new Set<string>();

/** Today's reactor set (cached per ET day; calendar service caches fetches). */
export async function reactorWatchlist(): Promise<Set<string>> {
    const today = etDatePlus(0);
    if (reactorCacheDate === today) return reactorCache;
    const out = new Set<string>();
    try {
        const prev = await getEarningsForDate(previousTradingDate());
        for (const e of prev ?? []) {
            if (e.time === 'after-hours' || e.time === 'unknown') out.add(e.symbol.toUpperCase());
        }
        const cur = await getEarningsForDate(today);
        for (const e of cur ?? []) {
            if (e.time === 'pre-market' || e.time === 'unknown') out.add(e.symbol.toUpperCase());
        }
        reactorCacheDate = today;
        reactorCache = out;
        logger.info(`[opportunity-engine] reactor watchlist for ${today}: ${out.size} fresh reporters`);
    } catch (err) {
        logger.warn(`[opportunity-engine] reactor watchlist unavailable (${err}) — continuing without`);
    }
    return out;
}
import { ScanHealthMonitor, type HealthTransition } from './scan-health.js';
import { buildSnapshotLanes, type SnapshotLanes } from './lane-rankers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnginePhase = 'pre-open' | 'open-drive' | 'midday' | 'pre-close' | 'idle';

export interface Opportunity {
    symbol: string;
    longName: string;
    direction: 'long' | 'short';
    /** Raw multi-factor signal score (0–100). */
    signalScore: number;
    rating: string;
    /** Composite ranking score: signal + RVOL bonus + multi-scan presence. */
    compositeRank: number;
    price: number | null;
    rvol: number | null;
    atr: number | null;
    rsi: number | null;
    vwap: number | null;
    /** Which scanners surfaced this symbol. */
    scanSources: string[];
    /** Day move vs the prior completed close, %, SIGNED TOWARD `direction`
     *  (a short candidate down 40% carries +40). Computed only for
     *  directionally-scanned candidates; null = not measured. Feeds the
     *  event-mover boost and the pre-market mover alert (MRNA 2026-08-19:
     *  +110% invisible to a composite with no day-move term). */
    dayMovePct: number | null;
    /** WP10: scorer freshness verdict — a stale bar farm (2026-08-05
     *  incident) must not fire triggers. Was computed and discarded. */
    stale: boolean;
    /** REQ-SCAN-004: price × session cumulative volume (USD) — the
     *  significance tie-breaker inside a rank band. Null when unmeasured. */
    dollarVolume: number | null;
    /** WP8: daily ATR as % of the price (the significance denominator),
     *  carried so the lane rankers read the same measure the engine used. */
    dailyAtrPct: number | null;
}

export interface OpportunitySnapshot {
    timestamp: number;
    phase: EnginePhase;
    sessionLabel: string;
    marketOpen: boolean;
    /** Unique symbols surfaced by the scanners this cycle. */
    scanned: number;
    /** Symbols actually scored (capped by OPP_MAX_CANDIDATES). */
    scored: number;
    /** All scored candidates, sorted by compositeRank desc. */
    opportunities: Opportunity[];
    /** How many of the top entries are streamed in realtime. */
    topN: number;
    /** REQ-DISC-002 (WP8): per-lane rankings over the same candidates —
     *  a score is comparable only inside its lane. Absent on snapshots
     *  persisted before WP8. */
    lanes?: SnapshotLanes;
}

interface PhasePlan {
    phase: EnginePhase;
    cadenceMs: number;
    /** WP10: 'none' for activity scans (MOST_ACTIVE, HOT_BY_VOLUME,
     *  TOP_TRADE_RATE) — a pre-market most-active list is dominated by
     *  down-gappers, and the old hard-coded 'long' scored every one of
     *  them as a long candidate. */
    scans: Array<{ code: ScanCode; direction: 'long' | 'short' | 'none' }>;
}

/** Scan families for the multi-scan bonus (WP10): overlapping views of
 *  the same volume event corroborate NOTHING — only distinct families do. */
const SCAN_FAMILY: Record<string, string> = {
    TOP_PERC_GAIN: 'gainer', TOP_OPEN_PERC_GAIN: 'gainer', HIGH_OPEN_GAP: 'gainer',
    TOP_PERC_LOSE: 'loser', TOP_OPEN_PERC_LOSE: 'loser',
    MOST_ACTIVE: 'volume', HOT_BY_VOLUME: 'volume', TOP_TRADE_RATE: 'volume',
};

/** Source tag prefix of the large-cap lane (REQ-SCAN-006). */
export const LARGECAP_PREFIX = 'LARGECAP:';
/** Source tag prefix of complex-constituent admissions (REQ-SCAN-007). */
export const COMPLEX_PREFIX = 'COMPLEX:';

/** Pure: the corroboration family of a source tag. A large-cap sighting
 *  of the same code is the SAME family as the base scan — it corroborates
 *  nothing by itself (REQ-SCAN-006); sentinel/complex tags are their own. */
export function scanFamilyOf(source: string): string {
    const code = source.startsWith(LARGECAP_PREFIX) ? source.slice(LARGECAP_PREFIX.length) : source;
    return SCAN_FAMILY[code] ?? source;
}

// --- Large-cap lane (REQ-SCAN-006, live-loop WP1) -------------------------
// Percent-ranked scan lists are cap-inverse: on a +4% chip day the 3x ETFs
// fill them and the underlyings never appear (2026-09-04 addendum). A
// second pass of the directional scans with a $10B market-cap floor gives
// the deep-book names their own 50 rows. Admissions get reserved candidate
// slots (best scan rank first, bounded by OPP_LARGECAP_RESERVE) so the
// busy-day candidate cut cannot crowd out the lane it exists to create.

export function largeCapLaneEnabled(): boolean {
    return (process.env.OPP_LARGECAP_LANE ?? '').trim().toLowerCase() !== 'false';
}

export function largeCapMinUsd(): number {
    const n = Number(process.env.OPP_LARGECAP_MIN_USD);
    return Number.isFinite(n) && n > 0 ? n : 10e9;
}

export function largeCapReserve(): number {
    const n = Number(process.env.OPP_LARGECAP_RESERVE);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5;
}

/** Pure: the directional (gainer/loser) scans of a plan — the only ones
 *  worth re-running with a cap floor (activity scans carry no direction). */
export function largeCapScansFor(scans: PhasePlan['scans']): PhasePlan['scans'] {
    return scans.filter((s) => s.direction !== 'none');
}

/** Pure: unadmitted rows carrying `tagPrefix`, best scan rank first, at
 *  most `max` — the reserved-slot selection shared by the large-cap and
 *  complex lanes. */
export function selectReservedAdmissions<T extends { symbol: string; sources: string[]; rank: number }>(
    rows: T[],
    admitted: Set<string>,
    tagPrefix: string,
    max: number,
): T[] {
    return rows
        .filter((r) => !admitted.has(r.symbol) && r.sources.some((s) => s.startsWith(tagPrefix)))
        .sort((a, b) => a.rank - b.rank)
        .slice(0, Math.max(0, max));
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function topN(): number {
    const n = Number(process.env.OPP_TOP_N);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 25) : 8;
}

function maxCandidates(): number {
    const n = Number(process.env.OPP_MAX_CANDIDATES);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 20;
}

/** Gateway auto-start gate: on unless OPPORTUNITY_ENGINE=false. */
export function isOpportunityEngineEnabled(): boolean {
    return (process.env.OPPORTUNITY_ENGINE ?? '').trim().toLowerCase() !== 'false';
}

const IDLE_POLL_MS = 5 * 60_000;
const SCORE_PACING_MS = 300;
const SNAPSHOT_RETENTION_MS = 7 * 24 * 3600_000;

/** Composite-rank bar a candidate must clear to trigger an evaluation.
 *  REQ-TRIG-001 (live-loop WP1, 2026-09-05): 75 → 60. Four coverage
 *  addenda (08-27, 09-01, 09-03, 09-04) showed the 4-18% single-name mover
 *  class scoring 55-66 in BOTH directions and never reaching the LLM at
 *  all — the bar, not the scanner, excluded it. Every deterministic gate
 *  still applies downstream; the band stamp (REQ-TRIG-003) keeps the
 *  newly admitted 60-74 class measurable apart. Exported for the test pin. */
export function triggerScore(): number {
    const n = Number(process.env.OPP_TRIGGER_SCORE);
    return Number.isFinite(n) && n > 0 ? n : 60;
}

function triggerCooldownMs(): number {
    const n = Number(process.env.OPP_TRIGGER_COOLDOWN_MIN);
    return (Number.isFinite(n) && n > 0 ? n : 30) * 60_000;
}

/** Single-name triggers per ET day. REQ-TRIG-001: 10 → 30 — the lower bar
 *  admits ~3x the candidates; each trigger is one bounded LLM evaluation,
 *  and the daily spend cap (REQ-LLM-002) is the cost guard, not this cap. */
export function triggerMaxPerDay(): number {
    const n = Number(process.env.OPP_TRIGGER_MAX_PER_DAY);
    return Number.isFinite(n) && n > 0 ? n : 30;
}

/** Optional market-cap band for engine scans (USD). Unset = unchanged
 *  default behavior (scanner-loop's $500M floor, no ceiling). */
/** Scan-coverage slice A (2026-08-25): the cumulative-volume scan floor
 *  is SESSION-AWARE. The flat 500K floor was session-blind — at 07:00 ET
 *  almost nothing has traded 500K yet, and the pre-open gap/gainer scans
 *  starved down to mega-liquid names and ETFs (operator-verified against
 *  an independent screener: 1 of 21 pre-market movers visible; AMD at
 *  177K pre-market volume died on OUR filter, not IBKR's). Pre-market
 *  uses a floor sized to pre-market volumes; regular hours keep the
 *  original bar. Both knobs are in the strategy fingerprint's behaviorEnv
 *  list — editing them mid-sample ends the window. */
export function scanVolumeFloor(phase: EnginePhase): number {
    const isPreOpen = phase === 'pre-open';
    const env = Number(process.env[isPreOpen ? 'OPP_SCAN_VOLUME_FLOOR_PREMARKET' : 'OPP_SCAN_VOLUME_FLOOR']);
    if (Number.isFinite(env) && env >= 0) return env;
    return isPreOpen ? 100_000 : 500_000;
}

function marketCapBand(): { marketCapAbove?: number; marketCapBelow?: number } {
    const min = Number(process.env.OPP_MARKET_CAP_MIN);
    const max = Number(process.env.OPP_MARKET_CAP_MAX);
    return {
        ...(Number.isFinite(min) && min > 0 ? { marketCapAbove: min } : {}),
        ...(Number.isFinite(max) && max > 0 ? { marketCapBelow: max } : {}),
    };
}

// ---------------------------------------------------------------------------
// Phase planning (US Eastern session awareness)
// ---------------------------------------------------------------------------

/** Parse "HH:MM ET" into minutes since midnight. */
function etMinutes(currentTimeET: string): number {
    const m = /^(\d{2}):(\d{2})/.exec(currentTimeET);
    if (!m) return 0;
    return Number(m[1]) * 60 + Number(m[2]);
}

/** Dawn-watch start (minutes since ET midnight). The MRNA lesson
 *  (2026-08-19): +110% at 06:45-07:50 while the engine idled until its
 *  08:00 pre-open start — a self-imposed blind window; IBKR scanners work
 *  from 04:00. Format 'HH:MM' ET; set 08:00 to restore the old behavior. */
function dawnStartMinutes(): number {
    const m = /^(\d{1,2}):(\d{2})$/.exec((process.env.OPP_DAWN_START_ET ?? '').trim());
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    return 4 * 60;
}

function dawnCadenceMs(): number {
    const n = Number(process.env.OPP_DAWN_CADENCE_MIN);
    return (Number.isFinite(n) && n > 0 ? n : 15) * 60_000;
}

export function planForNow(date?: Date): PhasePlan {
    const info = getMarketSession(date);
    const mins = etMinutes(info.currentTimeET);

    if (info.session === MarketSession.PRE_MARKET && mins >= dawnStartMinutes()) {
        // One phase, two cadences: the dawn watch (04:00+) runs the same
        // gap/mover scans slowly — its job is noticing an MRNA at 06:50,
        // not trading cadence; from 08:00 the historical 5-min rhythm.
        return {
            phase: 'pre-open',
            cadenceMs: mins >= 8 * 60 ? 5 * 60_000 : dawnCadenceMs(),
            scans: [
                { code: 'HIGH_OPEN_GAP', direction: 'long' },
                { code: 'TOP_OPEN_PERC_GAIN', direction: 'long' },
                { code: 'TOP_OPEN_PERC_LOSE', direction: 'short' },
                { code: 'MOST_ACTIVE', direction: 'none' },
            ],
        };
    }

    if (info.session === MarketSession.REGULAR) {
        if (mins < 10 * 60 + 30) {
            return {
                phase: 'open-drive',
                cadenceMs: 2 * 60_000,
                scans: [
                    { code: 'TOP_PERC_GAIN', direction: 'long' },
                    { code: 'HOT_BY_VOLUME', direction: 'none' },
                    { code: 'TOP_PERC_LOSE', direction: 'short' },
                    { code: 'TOP_TRADE_RATE', direction: 'none' },
                ],
            };
        }
        if (mins < 15 * 60) {
            return {
                phase: 'midday',
                cadenceMs: 10 * 60_000,
                scans: [
                    { code: 'TOP_PERC_GAIN', direction: 'long' },
                    { code: 'MOST_ACTIVE', direction: 'none' },
                    { code: 'TOP_PERC_LOSE', direction: 'short' },
                ],
            };
        }
        return {
            phase: 'pre-close',
            cadenceMs: 5 * 60_000,
            scans: [
                { code: 'TOP_PERC_GAIN', direction: 'long' },
                { code: 'MOST_ACTIVE', direction: 'none' },
                { code: 'HOT_BY_VOLUME', direction: 'none' },
            ],
        };
    }

    return { phase: 'idle', cadenceMs: IDLE_POLL_MS, scans: [] };
}

/** Scan set for a phase, independent of the clock (used for forced cycles). */
function scansForPhase(phase: EnginePhase): PhasePlan['scans'] {
    switch (phase) {
        case 'pre-open':
            return [
                { code: 'HIGH_OPEN_GAP', direction: 'long' },
                { code: 'TOP_OPEN_PERC_GAIN', direction: 'long' },
                { code: 'TOP_OPEN_PERC_LOSE', direction: 'short' },
                { code: 'MOST_ACTIVE', direction: 'none' },
            ];
        case 'pre-close':
            return [
                { code: 'TOP_PERC_GAIN', direction: 'long' },
                { code: 'MOST_ACTIVE', direction: 'none' },
                { code: 'HOT_BY_VOLUME', direction: 'none' },
            ];
        case 'midday':
            return [
                { code: 'TOP_PERC_GAIN', direction: 'long' },
                { code: 'MOST_ACTIVE', direction: 'none' },
                { code: 'TOP_PERC_LOSE', direction: 'short' },
            ];
        case 'open-drive':
        case 'idle':
        default:
            return [
                { code: 'TOP_PERC_GAIN', direction: 'long' },
                { code: 'HOT_BY_VOLUME', direction: 'none' },
                { code: 'TOP_PERC_LOSE', direction: 'short' },
                { code: 'TOP_TRADE_RATE', direction: 'none' },
            ];
    }
}

// ---------------------------------------------------------------------------
// SQLite persistence (same dual-driver pattern as ibkr-stream)
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
    const dbPath = join(dbDir, 'opportunities.db');
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
            CREATE TABLE IF NOT EXISTS opportunity_snapshots (
                ts    INTEGER PRIMARY KEY,
                phase TEXT NOT NULL,
                json  TEXT NOT NULL
            );
        `);
        return db;
    } catch (err) {
        logger.warn(`[opportunity-engine] SQLite init failed, snapshots kept in memory only: ${err}`);
        return null;
    }
}

async function persistSnapshot(snapshot: OpportunitySnapshot): Promise<void> {
    try {
        const database = await getDb();
        if (!database) return;
        database.query<void>(
            `INSERT OR REPLACE INTO opportunity_snapshots (ts, phase, json) VALUES (?, ?, ?)`,
        ).run(snapshot.timestamp, snapshot.phase, JSON.stringify(snapshot));
        database.query<void>(
            `DELETE FROM opportunity_snapshots WHERE ts < ?`,
        ).run(Date.now() - SNAPSHOT_RETENTION_MS);
    } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Scoring (delegates to the signal_scorer tool pipeline)
// ---------------------------------------------------------------------------

// Created lazily: this module sits in an import cycle with signal-scorer
// (via the tool registry), so a module-scope createSignalScorer() call can
// hit signal-scorer before its schema is initialized (TDZ crash under bun).
let scorerTool: ReturnType<typeof createSignalScorer> | null = null;

async function scoreSymbol(
    symbol: string,
    direction: 'long' | 'short',
): Promise<SignalResult | null> {
    try {
        scorerTool ??= createSignalScorer();
        const raw = await scorerTool.invoke({
            ticker: symbol,
            direction,
            barSize: '5 mins',
            useRTH: false,
        });
        const parsed = JSON.parse(raw as string) as { data?: SignalResult & { error?: string } };
        if (!parsed.data || parsed.data.error) return null;
        return parsed.data;
    } catch (err) {
        logger.warn(`[opportunity-engine] scoring failed for ${symbol}: ${err}`);
        return null;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

let latestSnapshot: OpportunitySnapshot | null = null;
let streamedSymbols = new Set<string>();
let cycleInFlight = false;
/** Symbols surfaced by the most recent cycle's scanners, with which scan
 *  codes surfaced them — the breadth detector's input. */
let lastSurfaced: Array<{ symbol: string; sources: string[] }> = [];

/**
 * Run one full scan→score→rank cycle and persist the snapshot.
 * Pass forcePhase to run outside the engine loop (tool refresh, demo script):
 * when the market session is idle, 'open-drive' scans are used with
 * marketOpen=false so the consumer can caveat staleness.
 */
export async function runCycleOnce(forcePhase?: EnginePhase): Promise<OpportunitySnapshot> {
    // WP10: a real mutex — the old `if (inFlight && latestSnapshot)` let a
    // second caller run CONCURRENTLY before the first snapshot existed,
    // and its finally cleared the flag for both. Now every concurrent
    // caller awaits the in-flight cycle's own promise.
    if (cyclePromise) return cyclePromise;
    cyclePromise = runCycleInner(forcePhase);
    try {
        return await cyclePromise;
    } finally {
        cyclePromise = null;
    }
}

let cyclePromise: Promise<OpportunitySnapshot> | null = null;

async function runCycleInner(forcePhase?: EnginePhase): Promise<OpportunitySnapshot> {
    cycleInFlight = true;
    try {
        const info = getMarketSession();
        let plan = planForNow();
        if (plan.phase === 'idle' || (forcePhase && forcePhase !== plan.phase)) {
            const phase: EnginePhase = forcePhase && forcePhase !== 'idle'
                ? forcePhase
                : (plan.phase === 'idle' ? 'open-drive' : plan.phase);
            plan = { phase, cadenceMs: plan.cadenceMs, scans: scansForPhase(phase) };
        }

        // 1. Scans (parallel, scanner-loop caches per code for 5 min).
        // WP10: direction is resolved by VOTES after every scan lands —
        // the old first-insert-wins let cache-warmth pick the side, and a
        // symbol in both a gainer and a loser scan kept whichever direction
        // resolved first plus a +3 "corroboration" bonus for the conflict.
        const found = new Map<string, { result: ScanResult; direction: 'long' | 'short' | null; sources: string[]; longVotes: number; shortVotes: number }>();
        const capBand = marketCapBand();
        await Promise.all(plan.scans.map(async ({ code, direction }) => {
            try {
                const results = await runScan(code, { aboveVolume: scanVolumeFloor(plan.phase), ...capBand });
                for (const r of results) {
                    if (!r.symbol || r.secType !== 'STK') continue;
                    const existing = found.get(r.symbol);
                    const entry = existing ?? { result: r, direction: null, sources: [], longVotes: 0, shortVotes: 0 };
                    entry.sources.push(code);
                    if (direction === 'long') entry.longVotes++;
                    else if (direction === 'short') entry.shortVotes++;
                    if (!existing) found.set(r.symbol, entry);
                }
            } catch (err) {
                logger.warn(`[opportunity-engine] scan ${code} failed: ${err}`);
            }
        }));

        // REQ-SCAN-006: the large-cap lane — the same directional scans
        // once more with the $10B floor. Same code = same family, so a
        // name on both lists corroborates nothing extra; the lane's value
        // is ADMISSION, not confirmation.
        if (largeCapLaneEnabled()) {
            const capFloor = largeCapMinUsd();
            await Promise.all(largeCapScansFor(plan.scans).map(async ({ code, direction }) => {
                try {
                    const results = await runScan(code, { aboveVolume: scanVolumeFloor(plan.phase), marketCapAbove: capFloor });
                    for (const r of results) {
                        if (!r.symbol || r.secType !== 'STK') continue;
                        const existing = found.get(r.symbol);
                        const entry = existing ?? { result: r, direction: null, sources: [], longVotes: 0, shortVotes: 0 };
                        entry.sources.push(`${LARGECAP_PREFIX}${code}`);
                        if (direction === 'long') entry.longVotes++;
                        else if (direction === 'short') entry.shortVotes++;
                        if (!existing) found.set(r.symbol, entry);
                    }
                } catch (err) {
                    logger.warn(`[opportunity-engine] large-cap scan ${code} failed: ${err}`);
                }
            }));
        }

        // Resolve directions: unanimous votes win; CONFLICTS are dropped
        // (a symbol both ripping and dumping per the scans is not a
        // directional candidate); vote-less activity-scan symbols stay
        // null and resolve at scoring time from the day move.
        for (const [symbol, meta] of [...found.entries()]) {
            if (meta.longVotes > 0 && meta.shortVotes > 0) {
                logger.info(`[opportunity-engine] ${symbol}: conflicting scan directions (${meta.sources.join(', ')}) — dropped`);
                found.delete(symbol);
            } else if (meta.longVotes > 0) {
                meta.direction = 'long';
            } else if (meta.shortVotes > 0) {
                meta.direction = 'short';
            }
        }

        // 1b. Watchlist sentinel — admission for declared names the scans
        // ignored (2026-08-19: COIN +10% / MSTR +12% on a BTC rally never
        // cracked a 25-row scan window on a biotech-explosion day, and
        // watchlist membership granted zero admission). Slow-cadence
        // price-vs-prevClose sweep; aligned movers join `found` as full
        // candidates and flow through scoring/boost/triggers/alerts.
        await sweepSentinels(found);
        // REQ-SCAN-007: a vehicle on the lists means its complex is moving —
        // sweep the constituents the percent ranking hid.
        await sweepComplexConstituents(found);

        lastSurfaced = [...found.entries()].map(([symbol, meta]) => ({ symbol, sources: [...meta.sources] }));

        // 2. Pick candidates: reactors first (fresh prints must never lose
        // the scoring slot to a stale mover), then multi-scan, then rank.
        const reactors = await reactorWatchlist();
        const candidates = [...found.entries()]
            .sort((a, b) =>
                (Number(reactors.has(b[0].toUpperCase())) - Number(reactors.has(a[0].toUpperCase())))
                || (b[1].sources.length - a[1].sources.length)
                || (a[1].result.rank - b[1].result.rank))
            .slice(0, maxCandidates());

        // Sentinel admissions are guaranteed a scoring slot: getting crowded
        // out by the busy-day candidate cut is the exact failure the lane
        // exists to fix. Bounded: sentinels are rare (≥5% movers not already
        // in scans, from a ~60-name watchlist).
        const admitted = new Set(candidates.map(([s]) => s));
        for (const entry of found.entries()) {
            if (entry[1].sources.includes(SENTINEL_SOURCE) && !admitted.has(entry[0])) {
                candidates.push(entry);
                admitted.add(entry[0]);
            }
        }
        // REQ-SCAN-006/007: reserved slots for the large-cap and complex
        // lanes — bounded (OPP_LARGECAP_RESERVE each), best scan rank first.
        {
            const rows = [...found.entries()].map(([symbol, meta]) => ({ symbol, sources: meta.sources, rank: meta.result.rank, meta }));
            for (const prefix of [LARGECAP_PREFIX, COMPLEX_PREFIX]) {
                for (const r of selectReservedAdmissions(rows, admitted, prefix, largeCapReserve())) {
                    candidates.push([r.symbol, r.meta]);
                    admitted.add(r.symbol);
                }
            }
        }

        // 3. Score sequentially (IBKR historical-data pacing)
        const opportunities: Opportunity[] = [];
        for (const [symbol, meta] of candidates) {
            // WP10: vote-less candidates (activity scans only) resolve
            // their direction here — by the day-move sign when the prior
            // close is known, else by scoring both sides and proposing
            // the better one. Never a hard-coded 'long'.
            let direction = meta.direction;
            let signal = await scoreSymbol(symbol, direction ?? 'long');
            if (signal && direction === null) {
                const ctx0 = await fetchDailyRiskContext(symbol).catch(() => null);
                const price0 = signal.snapshot.price;
                if (ctx0?.prevClose != null && ctx0.prevClose > 0 && price0 != null && price0 > 0) {
                    direction = price0 >= ctx0.prevClose ? 'long' : 'short';
                    if (direction === 'short') signal = await scoreSymbol(symbol, 'short');
                } else {
                    const shortSignal = await scoreSymbol(symbol, 'short');
                    if (shortSignal && shortSignal.compositeScore > signal.compositeScore) {
                        signal = shortSignal;
                        direction = 'short';
                    } else {
                        direction = 'long';
                    }
                }
            }
            if (signal && direction) {
                const rvol = signal.snapshot.rvol;
                // Day move (direction-signed): the TA factors punish
                // verticals (mean-reversion reads "overbought"), so the
                // composite needs the move itself as a term — MRNA
                // 2026-08-19 ranked below index ETFs at +110%. prevClose
                // comes from the cached daily-risk context (completed bars
                // only). REQ-SCAN-004: measured for EVERY candidate now —
                // the significance term must not depend on which scan
                // surfaced the name.
                let dayMovePct: number | null = null;
                let dailyAtrPct: number | null = null;
                {
                    const ctx = await fetchDailyRiskContext(symbol).catch(() => null);
                    const price = signal.snapshot.price;
                    if (ctx?.prevClose != null && ctx.prevClose > 0 && price != null && price > 0) {
                        const raw = ((price - ctx.prevClose) / ctx.prevClose) * 100;
                        dayMovePct = Math.round((direction === 'long' ? raw : -raw) * 10) / 10;
                        if (ctx.dailyAtr != null && ctx.dailyAtr > 0) dailyAtrPct = (ctx.dailyAtr / price) * 100;
                    }
                }
                // REQ-SCAN-004: the ATR-normalised significance term (the
                // raw-percent event-mover boost is retired). REQ-SCAN-005:
                // suppressed when the implied extension already exceeds the
                // gate's max_extension_atr — promoting a guaranteed refusal
                // only burns an LLM evaluation — EXCEPT for a fresh reporter
                // in hour one (a post-print reaction is its own catalyst).
                let boost = significanceTerm(dayMovePct, dailyAtrPct);
                if (boost > 0 && dayMovePct !== null && dailyAtrPct !== null) {
                    const impliedExtension = Math.abs(dayMovePct) / dailyAtrPct;
                    if (significanceSuppressed({
                        impliedExtension,
                        maxExtensionAtr: getRiskRules().max_extension_atr,
                        isReactor: reactors.has(symbol.toUpperCase()),
                        minutesSinceOpen: minutesSinceOpenEt(),
                    })) {
                        logger.info(`[opportunity-engine] ${symbol}: significance suppressed — implied extension ${impliedExtension.toFixed(1)}x ATR exceeds the gate's ${getRiskRules().max_extension_atr}x`);
                        boost = 0;
                    }
                }
                // WP10: multi-scan bonus counts distinct FAMILIES —
                // three volume scans surfacing one volume event is one
                // observation, not three (a large-cap sighting of the same
                // code is the same family — REQ-SCAN-006).
                const families = new Set(meta.sources.map(scanFamilyOf));
                const compositeRank = Math.round(
                    signal.compositeScore
                    + Math.min(10, (rvol ?? 0) * 2)
                    + 3 * (families.size - 1)
                    + boost,
                );
                const boostKey = `${etDateString()}:${symbol}`;
                if (boost > 0 && !boostLoggedToday.has(boostKey)) {
                    boostLoggedToday.add(boostKey);
                    logger.info(`[opportunity-engine] significance ${symbol} +${boost} (day ${dayMovePct}% toward ${direction} = ${dailyAtrPct ? (Math.abs(dayMovePct ?? 0) / dailyAtrPct).toFixed(1) : '?'}x ATR)`);
                }
                const priceVal = signal.snapshot.price;
                const dollarVolume = priceVal != null && priceVal > 0 && signal.snapshot.sessionVolume != null
                    ? Math.round(priceVal * signal.snapshot.sessionVolume)
                    : null;
                opportunities.push({
                    symbol,
                    longName: meta.result.longName,
                    direction,
                    signalScore: signal.compositeScore,
                    rating: signal.rating,
                    compositeRank,
                    price: signal.snapshot.price,
                    rvol,
                    atr: signal.snapshot.atr,
                    rsi: signal.snapshot.rsi,
                    vwap: signal.snapshot.vwap,
                    scanSources: meta.sources,
                    dayMovePct,
                    // WP10: the freshness verdict finally lands on the
                    // Opportunity instead of being computed and discarded.
                    stale: signal.freshness?.stale ?? false,
                    dollarVolume,
                    dailyAtrPct: dailyAtrPct === null ? null : Math.round(dailyAtrPct * 100) / 100,
                });
            }
            await sleep(SCORE_PACING_MS);
        }
        // REQ-SCAN-004: rank by significance-aware composite; inside a tie
        // the deeper book (dollar volume) ranks first.
        opportunities.sort((a, b) => (b.compositeRank - a.compositeRank) || ((b.dollarVolume ?? 0) - (a.dollarVolume ?? 0)));

        const snapshot: OpportunitySnapshot = {
            timestamp: Date.now(),
            phase: plan.phase,
            sessionLabel: `${info.session} ${info.currentTimeET}`,
            marketOpen: info.session === MarketSession.REGULAR || info.session === MarketSession.PRE_MARKET,
            scanned: found.size,
            scored: opportunities.length,
            opportunities,
            topN: Math.min(topN(), opportunities.length),
            // WP8 (REQ-DISC-002): the overnight lane's own ranking, pure and
            // versioned — the Pre-Close Review reads it instead of the
            // intraday composite.
            lanes: buildSnapshotLanes(opportunities),
        };

        latestSnapshot = snapshot;
        await persistSnapshot(snapshot);
        await syncStreamSubscriptions(snapshot);

        logger.info(
            `[opportunity-engine] cycle done (${snapshot.phase}): ${snapshot.scanned} scanned, ` +
            `${snapshot.scored} scored, top: ${opportunities.slice(0, 3).map((o) => `${o.symbol}:${o.compositeRank}`).join(' ') || 'none'}`,
        );

        // Scanner-health watchdog: persistent zero-scan cycles during market
        // hours mean the Gateway API is degraded — surface it, don't log it
        // into the void.
        const health = healthMonitor.observe(snapshot.scanned, snapshot.marketOpen);
        if (health) {
            logger[health.kind === 'degraded' ? 'error' : 'info'](
                `[opportunity-engine] scanner ${health.kind}: ${health.emptyCycles} empty cycle(s) since ${new Date(health.sinceMs).toISOString()}`,
            );
            for (const cb of [...healthCallbacks]) {
                try { await cb(health); } catch (err) {
                    logger.error(`[opportunity-engine] health callback failed: ${err}`);
                }
            }
        }
        return snapshot;
    } finally {
        cycleInFlight = false;
    }
}

/** Keep realtime stream subscriptions aligned with the current top-N. */
async function syncStreamSubscriptions(snapshot: OpportunitySnapshot): Promise<void> {
    if (!snapshot.marketOpen) return;
    const wanted = new Set(snapshot.opportunities.slice(0, snapshot.topN).map((o) => o.symbol));
    for (const sym of streamedSymbols) {
        if (!wanted.has(sym)) {
            try { await removeSymbol(sym); } catch { /* best-effort */ }
        }
    }
    for (const sym of wanted) {
        if (!streamedSymbols.has(sym)) {
            try { await addSymbol(sym); } catch (err) { logger.warn(`[opportunity-engine] stream subscribe ${sym} failed: ${err}`); }
        }
    }
    streamedSymbols = wanted;
}

// ---------------------------------------------------------------------------
// Event triggers — fired from loop cycles only (not tool refreshes), when a
// candidate enters the top 3 with compositeRank >= OPP_TRIGGER_SCORE.
// Debounced per symbol (OPP_TRIGGER_COOLDOWN_MIN) and capped per trading day
// (OPP_TRIGGER_MAX_PER_DAY).
// ---------------------------------------------------------------------------

export type TriggerCallback = (opp: Opportunity, snapshot: OpportunitySnapshot) => void | Promise<void>;

// --- Scanner-health events (see scan-health.ts) ---
export type HealthCallback = (t: HealthTransition) => void | Promise<void>;
const healthCallbacks = new Set<HealthCallback>();
const healthMonitor = new ScanHealthMonitor(
    Number.isFinite(Number(process.env.OPP_HEALTH_EMPTY_CYCLES)) && Number(process.env.OPP_HEALTH_EMPTY_CYCLES) > 0
        ? Number(process.env.OPP_HEALTH_EMPTY_CYCLES) : 3,
);

/** Register a callback for scanner degraded/recovered transitions. */
export function onEngineHealth(cb: HealthCallback): () => void {
    healthCallbacks.add(cb);
    return () => healthCallbacks.delete(cb);
}

const triggerCallbacks = new Set<TriggerCallback>();
const lastTriggerAt = new Map<string, number>();
let triggersToday = 0;
let triggersDate = '';

// --- Pre-market mover alerts (deterministic, no LLM) -----------------------
// The MRNA channel: a directionally-scanned candidate with an outsized
// aligned day move fires ONE WhatsApp line per symbol per day, straight
// from scan+quote facts. Notification is decoupled from evaluation — the
// alert goes out even when every gate would refuse the trade.
export type MoverCallback = (opp: Opportunity) => void | Promise<void>;
const moverCallbacks = new Set<MoverCallback>();
const moverAlertedToday = new Set<string>();
let moverDate = '';
/** Event-boost log dedup, date-keyed so no reset is needed. */
const boostLoggedToday = new Set<string>();

/** Register a callback for deterministic pre-market mover alerts. */
export function onPreMarketMover(cb: MoverCallback): () => void {
    moverCallbacks.add(cb);
    return () => moverCallbacks.delete(cb);
}

async function emitMoverAlerts(snapshot: OpportunitySnapshot): Promise<void> {
    if (moverCallbacks.size === 0) return;
    const today = etDateString();
    if (today !== moverDate) {
        moverDate = today;
        moverAlertedToday.clear();
    }
    for (const opp of snapshot.opportunities) {
        if (!moverAlertEligible({
            dayMovePct: opp.dayMovePct,
            rvol: opp.rvol,
            phase: snapshot.phase,
            alreadyAlerted: moverAlertedToday.has(opp.symbol),
        })) continue;
        moverAlertedToday.add(opp.symbol);
        logger.info(`[opportunity-engine] PRE-MARKET MOVER ${opp.symbol} ${opp.dayMovePct}% toward ${opp.direction} (rank ${opp.compositeRank})`);
        for (const cb of [...moverCallbacks]) {
            try {
                await cb(opp);
            } catch (err) {
                logger.error(`[opportunity-engine] mover callback failed: ${err}`);
            }
        }
    }
}

// --- Breadth events (sector-wide melt-ups; see breadth-detector.ts) ---
// Separate pipeline from single-name triggers: its own small daily cap and
// per-vehicle cooldown, and it never consumes the single-name slots. A
// detected breadth day also RELIEVES the single-name cap — on Jul 30 the
// 10/day cap exhausted by midday and AMD/INTC/DELL/TSM/ARM were never
// evaluated at all.

export type BreadthCallback = (event: BreadthEvent, snapshot: OpportunitySnapshot) => void | Promise<void>;
const breadthCallbacks = new Set<BreadthCallback>();
const lastBreadthVehicleAt = new Map<string, number>();
/** Regime pre-arm firings tracked separately: a tape-only look must never
 *  consume the scan-driven budget or delay scan-confirmed evidence. */
const lastPreArmVehicleAt = new Map<string, number>();
let breadthVehicleTriggersToday = 0;
let preArmsToday = 0;
let breadthDate = '';
/** ET date on which breadth was last detected — grants the single-name
 *  trigger-cap bonus for the rest of that day. */
let breadthActiveDate = '';

function breadthMaxPerDay(): number {
    const n = Number(process.env.OPP_BREADTH_MAX_PER_DAY);
    return Number.isFinite(n) && n > 0 ? n : 2;
}

function breadthCooldownMs(): number {
    const n = Number(process.env.OPP_BREADTH_COOLDOWN_MIN);
    return (Number.isFinite(n) && n > 0 ? n : 120) * 60_000;
}

function breadthCapBonus(): number {
    const n = Number(process.env.OPP_BREADTH_CAP_BONUS);
    return Number.isFinite(n) && n >= 0 ? n : 5;
}

// --- Watchlist sentinel (the COIN/MSTR admission lane, 2026-08-19) --------

function sentinelEnabled(): boolean {
    return (process.env.OPP_SENTINEL ?? '').trim().toLowerCase() !== 'false';
}

function sentinelCadenceMs(): number {
    const n = Number(process.env.OPP_SENTINEL_CADENCE_MIN);
    return (Number.isFinite(n) && n > 0 ? n : 10) * 60_000;
}

let lastSentinelSweepAt = 0;

/**
 * Check watchlist names ABSENT from this cycle's scans against their prior
 * close; an aligned move past the sentinel bar injects them into `found`
 * as full candidates (source WATCHLIST_SENTINEL, rank 0 so they sort ahead
 * of same-source-count scan names). Chunked and cadence-limited: ~60 names
 * every 10 minutes, 5-wide — prevClose rides the daily-context cache.
 * Best-effort per name; a data failure admits nothing, never guesses.
 */
async function sweepSentinels(
    found: Map<string, { result: ScanResult; direction: 'long' | 'short' | null; sources: string[]; longVotes: number; shortVotes: number }>,
): Promise<void> {
    if (!sentinelEnabled() || process.env.NODE_ENV === 'test') return;
    const now = Date.now();
    if (now - lastSentinelSweepAt < sentinelCadenceMs()) return;
    lastSentinelSweepAt = now;

    const names = [...breadthWatchlist()].filter((s) => !found.has(s));
    const hits: string[] = [];
    for (let i = 0; i < names.length; i += 5) {
        await Promise.all(names.slice(i, i + 5).map(async (sym) => {
            try {
                const [ctx, last] = await Promise.all([
                    fetchDailyRiskContext(sym),
                    fetchLastPrice(sym),
                ]);
                if (ctx?.prevClose == null || !(ctx.prevClose > 0) || last == null) return;
                const movePct = Math.round(((last - ctx.prevClose) / ctx.prevClose) * 1000) / 10;
                const direction = sentinelDirection(movePct);
                if (!direction) return;
                found.set(sym, {
                    result: {
                        rank: 0, symbol: sym, secType: 'STK', exchange: 'SMART', currency: 'USD',
                        longName: sym, distance: '', benchmark: '', projection: '',
                    },
                    direction,
                    sources: [SENTINEL_SOURCE],
                    // A sentinel admission IS a directional observation
                    // (aligned watchlist move) — it votes like a scan.
                    longVotes: direction === 'long' ? 1 : 0,
                    shortVotes: direction === 'short' ? 1 : 0,
                });
                hits.push(`${sym} ${movePct > 0 ? '+' : ''}${movePct}%`);
            } catch { /* best-effort per name */ }
        }));
    }
    if (hits.length) {
        logger.info(`[opportunity-engine] SENTINEL admitted ${hits.join(', ')} (watchlist move, absent from scans)`);
    }
}

/**
 * REQ-SCAN-007: for every VEHICLE the scans (or the sentinel) surfaced with
 * a direction, price-sweep its complex's constituents that are absent from
 * `found` and admit the ones moving at least one daily ATR (1% floor),
 * source `COMPLEX:<vehicle>`. Shares the sentinel's cadence limiter
 * semantics (the daily-context cache makes prevClose/ATR cheap) and its
 * best-effort-per-name discipline: a data failure admits nothing.
 */
async function sweepComplexConstituents(
    found: Map<string, { result: ScanResult; direction: 'long' | 'short' | null; sources: string[]; longVotes: number; shortVotes: number }>,
): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    let complexes;
    try {
        complexes = loadVehicleComplexes();
    } catch (err) {
        logger.error(`[opportunity-engine] vehicle complexes unavailable — constituent admission skipped: ${err}`);
        return;
    }
    const wanted = new Map<string, string>(); // constituent → vehicle that admitted it
    for (const [symbol, meta] of found.entries()) {
        if (!isVehicle(symbol, complexes) || meta.direction === null) continue;
        for (const c of complexesOf(symbol, complexes)) {
            for (const k of c.constituents) {
                if (!found.has(k) && !wanted.has(k)) wanted.set(k, symbol);
            }
        }
    }
    if (wanted.size === 0) return;
    const hits: string[] = [];
    const names = [...wanted.keys()];
    for (let i = 0; i < names.length; i += 5) {
        await Promise.all(names.slice(i, i + 5).map(async (sym) => {
            try {
                const [ctx, last] = await Promise.all([fetchDailyRiskContext(sym), fetchLastPrice(sym)]);
                if (ctx?.prevClose == null || !(ctx.prevClose > 0) || last == null || !(last > 0)) return;
                const movePct = Math.round(((last - ctx.prevClose) / ctx.prevClose) * 1000) / 10;
                const atrPct = ctx.dailyAtr != null && ctx.dailyAtr > 0 ? (ctx.dailyAtr / last) * 100 : null;
                const direction = complexAdmission(movePct, atrPct);
                if (!direction) return;
                found.set(sym, {
                    result: {
                        rank: 0, symbol: sym, secType: 'STK', exchange: 'SMART', currency: 'USD',
                        longName: sym, distance: '', benchmark: '', projection: '',
                    },
                    direction,
                    sources: [`${COMPLEX_PREFIX}${wanted.get(sym)}`],
                    longVotes: direction === 'long' ? 1 : 0,
                    shortVotes: direction === 'short' ? 1 : 0,
                });
                hits.push(`${sym} ${movePct > 0 ? '+' : ''}${movePct}% (via ${wanted.get(sym)})`);
            } catch { /* best-effort per name */ }
        }));
    }
    if (hits.length) {
        logger.info(`[opportunity-engine] COMPLEX admitted ${hits.join(', ')} (constituents of a surfaced vehicle)`);
    }
}

/** Pre-arm cooldown — shorter than the scan cooldown so a pre-market tape
 *  look does not push the post-open confirmation window past its payoff
 *  (2026-08-18: 08:12 pre-arm + 120-min cooldown = 10:15 re-look, after
 *  the 09:45-09:55 breakdown had already run). */
function preArmCooldownMs(): number {
    const n = Number(process.env.REGIME_PREARM_COOLDOWN_MIN);
    return (Number.isFinite(n) && n > 0 ? n : 60) * 60_000;
}

function preArmMaxPerDay(): number {
    const n = Number(process.env.REGIME_PREARM_MAX_PER_DAY);
    return Number.isFinite(n) && n >= 0 ? n : 2;
}

/** Register a callback fired on a breadth event (sector-vehicle evaluation). */
export function onBreadthTrigger(cb: BreadthCallback): () => void {
    breadthCallbacks.add(cb);
    return () => breadthCallbacks.delete(cb);
}

async function evaluateBreadth(snapshot: OpportunitySnapshot): Promise<void> {
    if (!snapshot.marketOpen) return;

    const today = etDateString();
    if (today !== breadthDate) {
        breadthDate = today;
        breadthVehicleTriggersToday = 0;
        preArmsToday = 0;
        lastBreadthVehicleAt.clear();
        lastPreArmVehicleAt.clear();
    }

    const scanEvent = detectBreadth(lastSurfaced);

    // The FULL breadth-day state (cap bonus + threshold relief) stays
    // scan-earned: only real movers in the ranks justify loosening the
    // single-name pipeline. The regime pre-arm below borrows just the
    // vehicle-evaluation machinery.
    if (scanEvent && breadthActiveDate !== today) {
        breadthActiveDate = today;
        logger.info(
            `[opportunity-engine] BREADTH day (${scanEvent.direction}): ${scanEvent.movers.length} watchlist movers in ` +
            `${scanEvent.direction === 'long' ? 'gainer' : 'loser'} scans (${scanEvent.movers.join(' ')}) — ` +
            `single-name trigger cap +${breadthCapBonus()}, vehicle ${scanEvent.vehicle}`,
        );
    }

    // No scan evidence yet → pre-arm from the ETF proxies: a semis-led
    // risk-off tape arms the semis SHORT (2026-08-18: the chip selloff was
    // knowable at 08:00), a crypto-led tape arms the crypto vehicle in the
    // IBIT direction (2026-08-19: COIN/MSTR ran +10-12% on a BTC rally the
    // scans never assembled — two names cannot reach the 4-mover bar).
    let event = scanEvent;
    if (!event) {
        const regime = await getMarketRegime();
        event = regimeBreadthEvent(regime) ?? cryptoBreadthEvent(regime);
    }
    if (!event) return;

    if (breadthCallbacks.size === 0) return;
    // Cooldown/cap per firing KIND (key stays vehicle+direction: a violent
    // reversal day may fairly evaluate the same vehicle short after the
    // morning's long). Scan-confirmed fires ignore pre-arm stamps entirely.
    const kind: 'scan' | 'pre-arm' = event.movers.length ? 'scan' : 'pre-arm';
    const cooldownKey = `${event.vehicle}:${event.direction}`;
    const now = Date.now();
    const allowed = breadthFireAllowed({
        kind,
        now,
        lastScanAt: lastBreadthVehicleAt.get(cooldownKey) ?? 0,
        lastPreArmAt: lastPreArmVehicleAt.get(cooldownKey) ?? 0,
        scanFiresToday: breadthVehicleTriggersToday,
        preArmsToday,
        scanCooldownMs: breadthCooldownMs(),
        preArmCooldownMs: preArmCooldownMs(),
        scanMaxPerDay: breadthMaxPerDay(),
        preArmMaxPerDay: preArmMaxPerDay(),
    });
    if (!allowed) return;

    if (kind === 'scan') {
        lastBreadthVehicleAt.set(cooldownKey, now);
        breadthVehicleTriggersToday++;
    } else {
        lastPreArmVehicleAt.set(cooldownKey, now);
        preArmsToday++;
    }
    logger.info(
        `[opportunity-engine] BREADTH TRIGGER ${event.vehicle} ${event.direction.toUpperCase()} ` +
        `(${event.movers.length ? `movers: ${event.movers.join(' ')}` : 'pre-armed by tape regime'})`,
    );
    for (const cb of [...breadthCallbacks]) {
        try {
            await cb(event, snapshot);
        } catch (err) {
            logger.error(`[opportunity-engine] breadth callback failed: ${err}`);
        }
    }
}

/** Register a callback fired when a candidate crosses the trigger threshold. */
export function onOpportunityTrigger(cb: TriggerCallback): () => void {
    triggerCallbacks.add(cb);
    return () => triggerCallbacks.delete(cb);
}

function etDateString(): string {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

async function evaluateTriggers(snapshot: OpportunitySnapshot): Promise<void> {
    if (triggerCallbacks.size === 0 || !snapshot.marketOpen) return;

    const today = etDateString();
    if (today !== triggersDate) {
        triggersDate = today;
        triggersToday = 0;
        lastTriggerAt.clear();
    }

    const threshold = triggerScore();
    const cooldown = triggerCooldownMs();
    const now = Date.now();

    // Breadth days get extra single-name slots: a correlated 9-name move
    // exhausts the ordinary cap while half the movers are still unseen.
    const breadthDay = breadthActiveDate === today;
    const capBonus = breadthDay ? breadthCapBonus() : 0;
    const maxTriggers = triggerMaxPerDay() + capBonus;
    // …and threshold relief for watchlist names: correlated movers score
    // lower individually (SNAP at 68 vs the 75 bar on a +14% day).
    const watch = breadthDay ? breadthWatchlist() : null;
    const relief = breadthDay ? breadthThresholdRelief() : 0;

    // Regime tilt (2026-08-18): on a risk-off tape the bar RISES for longs
    // and DROPS for shorts — the chased-long loss pattern clusters exactly
    // on mornings whose direction the ETF proxies printed before the open.
    // 'unknown'/'neutral'/'risk-on' → zero tilt (defense only; no evidence
    // yet for penalizing shorts on up tapes).
    const regime = await getMarketRegime();

    const reactors = await reactorWatchlist();
    for (const [idx, opp] of snapshot.opportunities.slice(0, REACTOR_TRIGGER_DEPTH).entries()) {
        const isReactor = reactors.has(opp.symbol.toUpperCase());
        const regimeAdj = regimeThresholdAdjust(regime.tag, opp.direction);
        const gate = triggerEligibility({
            idx,
            isReactor,
            onBreadthWatchlist: watch?.has(opp.symbol.toUpperCase()) ?? false,
            threshold: threshold + regimeAdj,
            breadthRelief: relief,
            reactorReliefPts: reactorRelief(),
            deepMargin: deepTriggerMargin(),
            depth: REACTOR_TRIGGER_DEPTH,
            stale: opp.stale,
        });
        if (!gate.eligible || opp.compositeRank < gate.effectiveThreshold) continue;
        // Live session re-check: trigger callbacks are AWAITED, so the loop
        // can outlive the session that produced the snapshot — on 2026-08-11
        // the final pre-bell cycle dispatched four triggers into the closed
        // market, each burning an agent evaluation to place a bracket IBKR
        // rejects with error 201. The snapshot's marketOpen is cycle-start
        // truth; this is dispatch-time truth.
        if (!isTradeableSession(getMarketSession().session)) {
            logger.info('[opportunity-engine] session closed mid-loop — remaining triggers dropped (post-close DAY brackets are guaranteed rejections)');
            return;
        }
        if (triggersToday >= maxTriggers) {
            logger.info(`[opportunity-engine] trigger cap reached for today (${maxTriggers}${capBonus ? ` incl. breadth bonus +${capBonus}` : ''})`);
            return;
        }
        const last = lastTriggerAt.get(opp.symbol) ?? 0;
        if (now - last < cooldown) continue;

        lastTriggerAt.set(opp.symbol, now);
        triggersToday++;
        logger.info(
            `[opportunity-engine] TRIGGER ${opp.symbol} (${opp.direction}, rank ${opp.compositeRank}` +
            `${opp.compositeRank < threshold ? `, breadth relief −${relief}` : ''}` +
            `${regimeAdj !== 0 ? `, regime tilt ${regimeAdj > 0 ? '+' : ''}${regimeAdj}` : ''}` +
            `${!isReactor && idx >= 3 ? `, deep window pos ${idx + 1} at bar ${gate.effectiveThreshold}` : ''})`,
        );
        for (const cb of [...triggerCallbacks]) {
            try {
                await cb(opp, snapshot);
            } catch (err) {
                logger.error(`[opportunity-engine] trigger callback failed: ${err}`);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Engine loop
// ---------------------------------------------------------------------------

let running = false;
let loopTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNext(): void {
    if (!running) return;
    const plan = planForNow();
    const jitter = Math.floor(Math.random() * 0.1 * plan.cadenceMs);
    loopTimer = setTimeout(async () => {
        loopTimer = null;
        if (!running) return;
        const current = planForNow();
        if (current.phase !== 'idle') {
            try {
                const snapshot = await runCycleOnce();
                // Movers first (fastest channel, no LLM), then breadth (a
                // detected regime day relieves the single-name cap for the
                // trigger pass of the SAME cycle), then triggers.
                await emitMoverAlerts(snapshot);
                await evaluateBreadth(snapshot);
                await evaluateTriggers(snapshot);
            } catch (err) {
                logger.error(`[opportunity-engine] cycle failed: ${err}`);
            }
        }
        scheduleNext();
    }, plan.cadenceMs + jitter);
}

/** Start the continuous engine loop (idempotent). */
export function startOpportunityEngine(): void {
    if (running) return;
    running = true;
    const plan = planForNow();
    logger.info(`[opportunity-engine] started (phase: ${plan.phase}, next cycle in ~${Math.round(plan.cadenceMs / 60000)} min)`);
    if (plan.phase !== 'idle') {
        void runCycleOnce()
            .then(async (snapshot) => {
                await emitMoverAlerts(snapshot);
                await evaluateBreadth(snapshot);
                await evaluateTriggers(snapshot);
            })
            .catch((err) => logger.error(`[opportunity-engine] initial cycle failed: ${err}`));
    }
    scheduleNext();
}

/** Stop the engine loop. */
export function stopOpportunityEngine(): void {
    running = false;
    if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
    }
    if (db) {
        try { db.close(); } catch { /* ignore */ }
        db = null;
    }
    logger.info('[opportunity-engine] stopped');
}

/** Latest in-memory snapshot (null until the first cycle completes). */
export function getLatestSnapshot(): OpportunitySnapshot | null {
    return latestSnapshot;
}

/**
 * Distinct symbols that appeared in persisted snapshots since the given
 * epoch ms — the day's "watched universe", consumed by the data-archive
 * scheduler to decide which bars are worth keeping.
 */
export async function getSnapshotSymbolsSince(sinceMs: number): Promise<string[]> {
    const database = await getDb();
    if (!database) {
        return latestSnapshot && latestSnapshot.timestamp >= sinceMs
            ? [...new Set(latestSnapshot.opportunities.map((o) => o.symbol))]
            : [];
    }
    const rows = database.query<{ json: string }>(
        `SELECT json FROM opportunity_snapshots WHERE ts >= ?`,
    ).all(sinceMs);
    const symbols = new Set<string>();
    for (const row of rows) {
        try {
            const snap = JSON.parse(row.json) as OpportunitySnapshot;
            for (const o of snap.opportunities) symbols.add(o.symbol);
        } catch { /* skip malformed row */ }
    }
    return [...symbols];
}

/**
 * Per-symbol ranking stats from persisted snapshots since `sinceMs` — the
 * benchmark's "did the engine SEE it, and how highly?" join. Returns max
 * compositeRank and first-seen timestamp per symbol.
 */
export async function getSymbolRankStatsSince(
    sinceMs: number,
): Promise<Map<string, { maxRank: number; firstSeenMs: number }>> {
    const stats = new Map<string, { maxRank: number; firstSeenMs: number }>();
    const database = await getDb();
    if (!database) return stats;
    const rows = database.query<{ json: string }>(
        `SELECT json FROM opportunity_snapshots WHERE ts >= ?`,
    ).all(sinceMs);
    for (const row of rows) {
        try {
            const snap = JSON.parse(row.json) as OpportunitySnapshot;
            for (const o of snap.opportunities) {
                const cur = stats.get(o.symbol);
                if (!cur) stats.set(o.symbol, { maxRank: o.compositeRank, firstSeenMs: snap.timestamp });
                else {
                    cur.maxRank = Math.max(cur.maxRank, o.compositeRank);
                    cur.firstSeenMs = Math.min(cur.firstSeenMs, snap.timestamp);
                }
            }
        } catch { /* skip malformed row */ }
    }
    return stats;
}

/** Engine status for diagnostics. */
export function engineStatus(): { running: boolean; phase: EnginePhase; lastCycleAt: number | null } {
    return {
        running,
        phase: planForNow().phase,
        lastCycleAt: latestSnapshot?.timestamp ?? null,
    };
}
