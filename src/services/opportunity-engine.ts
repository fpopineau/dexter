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
import { getMarketSession, MarketSession } from '@/utils/market-hours.js';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { addSymbol, removeSymbol } from './ibkr-stream.js';
import { detectBreadth, type BreadthEvent } from './breadth-detector.js';
import { runScan, type ScanCode, type ScanResult } from './scanner-loop.js';
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

        // 2. Pick candidates: multi-scan symbols first, then by scanner rank
        const candidates = [...found.entries()]
            .sort((a, b) => (b[1].sources.length - a[1].sources.length) || (a[1].result.rank - b[1].result.rank))
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

    const event = detectBreadth(lastSurfaced);
    if (!event) return;

    if (breadthActiveDate !== today) {
        breadthActiveDate = today;
        logger.info(
            `[opportunity-engine] BREADTH day: ${event.movers.length} watchlist movers in gainer scans ` +
            `(${event.movers.join(' ')}) — single-name trigger cap +${breadthCapBonus()}, vehicle ${event.vehicle}`,
        );
    }

    if (breadthCallbacks.size === 0) return;
    if (breadthVehicleTriggersToday >= breadthMaxPerDay()) return;
    const last = lastBreadthVehicleAt.get(event.vehicle) ?? 0;
    const now = Date.now();
    if (now - last < breadthCooldownMs()) return;

    lastBreadthVehicleAt.set(event.vehicle, now);
    breadthVehicleTriggersToday++;
    logger.info(`[opportunity-engine] BREADTH TRIGGER ${event.vehicle} (movers: ${event.movers.join(' ')})`);
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
    const capBonus = breadthActiveDate === today ? breadthCapBonus() : 0;
    const maxTriggers = triggerMaxPerDay() + capBonus;

    for (const opp of snapshot.opportunities.slice(0, 3)) {
        if (opp.compositeRank < threshold) continue;
        if (triggersToday >= maxTriggers) {
            logger.info(`[opportunity-engine] trigger cap reached for today (${maxTriggers}${capBonus ? ` incl. breadth bonus +${capBonus}` : ''})`);
            return;
        }
        const last = lastTriggerAt.get(opp.symbol) ?? 0;
        if (now - last < cooldown) continue;

        lastTriggerAt.set(opp.symbol, now);
        triggersToday++;
        logger.info(`[opportunity-engine] TRIGGER ${opp.symbol} (${opp.direction}, rank ${opp.compositeRank})`);
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

/** Engine status for diagnostics. */
export function engineStatus(): { running: boolean; phase: EnginePhase; lastCycleAt: number | null } {
    return {
        running,
        phase: planForNow().phase,
        lastCycleAt: latestSnapshot?.timestamp ?? null,
    };
}
