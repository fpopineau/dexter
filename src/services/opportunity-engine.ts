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
import { breadthThresholdRelief, breadthWatchlist, detectBreadth, regimeBreadthEvent, type BreadthEvent } from './breadth-detector.js';
import { getMarketRegime, regimeThresholdAdjust } from './market-regime.js';
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
}): { eligible: boolean; effectiveThreshold: number } {
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
}

interface PhasePlan {
    phase: EnginePhase;
    cadenceMs: number;
    scans: Array<{ code: ScanCode; direction: 'long' | 'short' }>;
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

function triggerScore(): number {
    const n = Number(process.env.OPP_TRIGGER_SCORE);
    return Number.isFinite(n) && n > 0 ? n : 75;
}

function triggerCooldownMs(): number {
    const n = Number(process.env.OPP_TRIGGER_COOLDOWN_MIN);
    return (Number.isFinite(n) && n > 0 ? n : 30) * 60_000;
}

function triggerMaxPerDay(): number {
    const n = Number(process.env.OPP_TRIGGER_MAX_PER_DAY);
    return Number.isFinite(n) && n > 0 ? n : 10;
}

/** Optional market-cap band for engine scans (USD). Unset = unchanged
 *  default behavior (scanner-loop's $500M floor, no ceiling). */
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

export function planForNow(date?: Date): PhasePlan {
    const info = getMarketSession(date);
    const mins = etMinutes(info.currentTimeET);

    if (info.session === MarketSession.PRE_MARKET && mins >= 8 * 60) {
        return {
            phase: 'pre-open',
            cadenceMs: 5 * 60_000,
            scans: [
                { code: 'HIGH_OPEN_GAP', direction: 'long' },
                { code: 'TOP_OPEN_PERC_GAIN', direction: 'long' },
                { code: 'TOP_OPEN_PERC_LOSE', direction: 'short' },
                { code: 'MOST_ACTIVE', direction: 'long' },
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
                    { code: 'HOT_BY_VOLUME', direction: 'long' },
                    { code: 'TOP_PERC_LOSE', direction: 'short' },
                    { code: 'TOP_TRADE_RATE', direction: 'long' },
                ],
            };
        }
        if (mins < 15 * 60) {
            return {
                phase: 'midday',
                cadenceMs: 10 * 60_000,
                scans: [
                    { code: 'TOP_PERC_GAIN', direction: 'long' },
                    { code: 'MOST_ACTIVE', direction: 'long' },
                    { code: 'TOP_PERC_LOSE', direction: 'short' },
                ],
            };
        }
        return {
            phase: 'pre-close',
            cadenceMs: 5 * 60_000,
            scans: [
                { code: 'TOP_PERC_GAIN', direction: 'long' },
                { code: 'MOST_ACTIVE', direction: 'long' },
                { code: 'HOT_BY_VOLUME', direction: 'long' },
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
                { code: 'MOST_ACTIVE', direction: 'long' },
            ];
        case 'pre-close':
            return [
                { code: 'TOP_PERC_GAIN', direction: 'long' },
                { code: 'MOST_ACTIVE', direction: 'long' },
                { code: 'HOT_BY_VOLUME', direction: 'long' },
            ];
        case 'midday':
            return [
                { code: 'TOP_PERC_GAIN', direction: 'long' },
                { code: 'MOST_ACTIVE', direction: 'long' },
                { code: 'TOP_PERC_LOSE', direction: 'short' },
            ];
        case 'open-drive':
        case 'idle':
        default:
            return [
                { code: 'TOP_PERC_GAIN', direction: 'long' },
                { code: 'HOT_BY_VOLUME', direction: 'long' },
                { code: 'TOP_PERC_LOSE', direction: 'short' },
                { code: 'TOP_TRADE_RATE', direction: 'long' },
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
    if (cycleInFlight && latestSnapshot) return latestSnapshot;
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

        // 1. Scans (parallel, scanner-loop caches per code for 5 min)
        const found = new Map<string, { result: ScanResult; direction: 'long' | 'short'; sources: string[] }>();
        const capBand = marketCapBand();
        await Promise.all(plan.scans.map(async ({ code, direction }) => {
            try {
                const results = await runScan(code, { aboveVolume: 500_000, ...capBand });
                for (const r of results) {
                    if (!r.symbol || r.secType !== 'STK') continue;
                    const existing = found.get(r.symbol);
                    if (existing) {
                        existing.sources.push(code);
                    } else {
                        found.set(r.symbol, { result: r, direction, sources: [code] });
                    }
                }
            } catch (err) {
                logger.warn(`[opportunity-engine] scan ${code} failed: ${err}`);
            }
        }));

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

        // 3. Score sequentially (IBKR historical-data pacing)
        const opportunities: Opportunity[] = [];
        for (const [symbol, meta] of candidates) {
            const signal = await scoreSymbol(symbol, meta.direction);
            if (signal) {
                const rvol = signal.snapshot.rvol;
                const compositeRank = Math.round(
                    signal.compositeScore
                    + Math.min(10, (rvol ?? 0) * 2)
                    + 3 * (meta.sources.length - 1),
                );
                opportunities.push({
                    symbol,
                    longName: meta.result.longName,
                    direction: meta.direction,
                    signalScore: signal.compositeScore,
                    rating: signal.rating,
                    compositeRank,
                    price: signal.snapshot.price,
                    rvol,
                    atr: signal.snapshot.atr,
                    rsi: signal.snapshot.rsi,
                    vwap: signal.snapshot.vwap,
                    scanSources: meta.sources,
                });
            }
            await sleep(SCORE_PACING_MS);
        }
        opportunities.sort((a, b) => b.compositeRank - a.compositeRank);

        const snapshot: OpportunitySnapshot = {
            timestamp: Date.now(),
            phase: plan.phase,
            sessionLabel: `${info.session} ${info.currentTimeET}`,
            marketOpen: info.session === MarketSession.REGULAR || info.session === MarketSession.PRE_MARKET,
            scanned: found.size,
            scored: opportunities.length,
            opportunities,
            topN: Math.min(topN(), opportunities.length),
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

// --- Breadth events (sector-wide melt-ups; see breadth-detector.ts) ---
// Separate pipeline from single-name triggers: its own small daily cap and
// per-vehicle cooldown, and it never consumes the single-name slots. A
// detected breadth day also RELIEVES the single-name cap — on Jul 30 the
// 10/day cap exhausted by midday and AMD/INTC/DELL/TSM/ARM were never
// evaluated at all.

export type BreadthCallback = (event: BreadthEvent, snapshot: OpportunitySnapshot) => void | Promise<void>;
const breadthCallbacks = new Set<BreadthCallback>();
const lastBreadthVehicleAt = new Map<string, number>();
let breadthVehicleTriggersToday = 0;
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
        lastBreadthVehicleAt.clear();
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

    // Semis-led risk-off tape with no scan evidence yet → pre-arm the
    // short-vehicle evaluation from the ETF proxies (2026-08-18: the chip
    // selloff was knowable at 08:00; scan accumulation wakes at ~09:35).
    const event = scanEvent ?? regimeBreadthEvent(await getMarketRegime());
    if (!event) return;

    if (breadthCallbacks.size === 0) return;
    if (breadthVehicleTriggersToday >= breadthMaxPerDay()) return;
    // Cooldown per vehicle+direction: a violent reversal day may fairly
    // evaluate the same vehicle short after the morning's long.
    const cooldownKey = `${event.vehicle}:${event.direction}`;
    const last = lastBreadthVehicleAt.get(cooldownKey) ?? 0;
    const now = Date.now();
    if (now - last < breadthCooldownMs()) return;

    lastBreadthVehicleAt.set(cooldownKey, now);
    breadthVehicleTriggersToday++;
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
                // Breadth first: a detected regime day relieves the
                // single-name cap for the trigger pass of the SAME cycle.
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
