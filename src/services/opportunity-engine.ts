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
import { runScan, type ScanCode, type ScanResult } from './scanner-loop.js';

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

const scorerTool = createSignalScorer();

async function scoreSymbol(
    symbol: string,
    direction: 'long' | 'short',
): Promise<SignalResult | null> {
    try {
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
        await Promise.all(plan.scans.map(async ({ code, direction }) => {
            try {
                const results = await runScan(code, { aboveVolume: 500_000 });
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
                await runCycleOnce();
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
        void runCycleOnce().catch((err) => logger.error(`[opportunity-engine] initial cycle failed: ${err}`));
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

/** Engine status for diagnostics. */
export function engineStatus(): { running: boolean; phase: EnginePhase; lastCycleAt: number | null } {
    return {
        running,
        phase: planForNow().phase,
        lastCycleAt: latestSnapshot?.timestamp ?? null,
    };
}
