/**
 * Simulator service (REQ-SIM-006, live-loop WP2) — the nightly pipeline
 * slot between the benchmark (16:45 ET) and WP3's looks/digest:
 *
 *   archive 16:20 → benchmark 16:45 → SIMULATOR SETTLE 17:10 → looks → digest
 *
 * Single-flight with a three-state run stamp (`sim-settle-run.json`:
 * running → completed | failed) like the EOD triage; a boot catch-up runs
 * the settle when today's stamp is missing after 17:10 ET on a trading day
 * (the nightly restart window routinely kills long jobs). A failed settle
 * is REPORTED (log + the report callback), never silently skipped.
 *
 * Observability only: reads the ledgers and the bars, writes simulator.db.
 * Nothing here can place, modify or cancel an order (REQ-SIM-007).
 */

import { Cron } from 'croner';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getRiskRules } from '@/tools/ibkr/risk-rules.js';
import { logger } from '@/utils';
import { isMarketHalfDay, isMarketHoliday } from '@/utils/market-hours.js';
import { currentRung } from '../ladder-state.js';
import { runLoopNightly } from '../loop/nightly.js';
import { getPerformanceBaseline, listProposals, listRefusalsSince, type TradeProposal } from '../trade-proposals.js';
import { DEFAULT_MAX_GAP_MS, loadSimBars } from './bars.js';
import { formatSettleReport, summarizeVariants, twinCalibration, type SettleRunCounts } from './report.js';
import { runSettleOnce, type SettleDeps } from './settle.js';
import { findSimTrade, listOpenSimTrades, listSimTrades, upsertSimTrade } from './store.js';
import { VARIANTS_V1 } from './variants.js';

const ET = 'America/New_York';
const SETTLE_CRON = '10 17 * * 1-5';
const SETTLE_MIN_ET = 17 * 60 + 10;
const LOOKBACK_MS = 3 * 86_400_000;
const FALLBACK_NETLIQ_USD = 11_700;

export type ReportCallback = (message: string) => void | Promise<void>;
const callbacks = new Set<ReportCallback>();

export function onSimulatorReport(cb: ReportCallback): () => void {
    callbacks.add(cb);
    return () => callbacks.delete(cb);
}

export function isSimulatorEnabled(): boolean {
    return (process.env.SIMULATOR ?? '').trim().toLowerCase() !== 'false';
}

export function simCommissionConfig(env: Record<string, string | undefined> = process.env): { perShareUsd: number; minUsd: number } {
    const per = Number(env.SIM_COMMISSION_PER_SHARE_USD);
    const min = Number(env.SIM_COMMISSION_MIN_USD);
    return {
        perShareUsd: Number.isFinite(per) && per >= 0 ? per : 0.005,
        minUsd: Number.isFinite(min) && min >= 0 ? min : 1.0,
    };
}

// --- run stamp -------------------------------------------------------------

interface RunStamp { date: string; status: 'running' | 'completed' | 'failed'; at: number; counts?: SettleRunCounts }

function stampPath(): string {
    return join(process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data'), 'sim-settle-run.json');
}

function readStamp(): RunStamp | null {
    try {
        if (!existsSync(stampPath())) return null;
        return JSON.parse(readFileSync(stampPath(), 'utf-8')) as RunStamp;
    } catch {
        return null;
    }
}

function writeStamp(s: RunStamp): void {
    try {
        mkdirSync(dirname(stampPath()), { recursive: true });
        writeFileSync(stampPath(), JSON.stringify(s, null, 2));
    } catch (err) {
        logger.warn(`[simulator] run stamp not persisted: ${err}`);
    }
}

function etToday(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: ET });
}

function etMinutesNow(): number {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: ET }));
    return et.getHours() * 60 + et.getMinutes();
}

// --- the live run ----------------------------------------------------------

function liveDeps(): SettleDeps {
    return {
        now: Date.now(),
        lookbackMs: LOOKBACK_MS,
        listProposalsSince: async (sinceMs) => (await listProposals(undefined, 1000)).filter((p) => p.createdAt >= sinceMs),
        listRefusalsSince,
        loadBars: (symbol, fromT, toT, opts) => loadSimBars(symbol, fromT, toT, { ...opts, maxGapMs: DEFAULT_MAX_GAP_MS }),
        store: { find: findSimTrade, upsert: upsertSimTrade, listOpen: listOpenSimTrades },
        rules: getRiskRules(),
        rungPct: currentRung(),
        netLiq: getPerformanceBaseline()?.netLiq ?? FALLBACK_NETLIQ_USD,
        commissions: simCommissionConfig(),
        isHalfDay: isMarketHalfDay,
    };
}

let inFlight = false;

/** One settle pass with the run stamp and the report. Exported for scripts. */
export async function runSimulatorSettleOnce(): Promise<SettleRunCounts | null> {
    if (inFlight) { logger.info('[simulator] settle already running — skipped'); return null; }
    inFlight = true;
    const today = etToday();
    writeStamp({ date: today, status: 'running', at: Date.now() });
    let counts: SettleRunCounts | null = null;
    try {
        counts = await runSettleOnce(liveDeps());
        writeStamp({ date: today, status: counts.failed > 0 ? 'failed' : 'completed', at: Date.now(), counts });
        await report(today, counts);
    } catch (err) {
        writeStamp({ date: today, status: 'failed', at: Date.now() });
        const msg = `🧪 Simulator settle ${today} FAILED — ${err instanceof Error ? err.message : err}`;
        logger.error(`[simulator] ${msg}`);
        for (const cb of [...callbacks]) { try { await cb(msg); } catch { /* delivery is best-effort */ } }
    } finally {
        inFlight = false;
    }
    // WP7 (REQ-BENCH-004/005): the overnight benchmark replays yesterday's
    // archived universe after the settle — observability, its own store; a
    // failure is reported and never blocks the looks.
    await runOvernightBenchmarkSafely(today);
    // Live-loop WP3: the nightly pipeline is settle → LOOKS → DIGEST. The
    // looks run whether or not the settle succeeded (a failed settle leaves
    // the shadow section stale, the deployable verdict does not depend on
    // it); runLoopNightly never throws.
    await runLoopNightly();
    return counts;
}

async function runOvernightBenchmarkSafely(today: string): Promise<void> {
    try {
        const { runOvernightBenchmarkOnce } = await import('../overnight-benchmark.js');
        const archive = await import('../candidate-archive.js');
        const { listProposals: listAll, listRefusalsSince: refusalsSince } = await import('../trade-proposals.js');
        const { counts, reports } = await runOvernightBenchmarkOnce({
            now: Date.now(),
            rules: getRiskRules(),
            rungPct: currentRung(),
            netLiq: getPerformanceBaseline()?.netLiq ?? FALLBACK_NETLIQ_USD,
            commissions: simCommissionConfig(),
            listPending: () => archive.listCandidates({ lane: 'overnight', replayStatus: 'pending' }),
            listDays: async (days) => (await Promise.all(days.map((day) => archive.listCandidates({ day })))).flat(),
            update: archive.updateCandidate,
            loadBars: (symbol, fromT, toT, opts) => loadSimBars(symbol, fromT, toT, { ...opts, maxGapMs: DEFAULT_MAX_GAP_MS }),
            isHalfDay: isMarketHalfDay,
            ledgerSince: async (sinceMs) => ({
                proposals: (await listAll(undefined, 1000)).filter((p) => p.createdAt >= sinceMs)
                    .map((p) => ({ id: p.id, symbol: p.symbol, strategyId: p.strategyId, createdAt: p.createdAt })),
                refusals: (await refusalsSince(sinceMs)).map((r) => ({ symbol: r.symbol, createdAt: r.createdAt, gate: r.gate })),
            }),
        });
        logger.info(`[overnight-benchmark] ${today}: ${JSON.stringify(counts)}`);
        for (const msg of reports) {
            for (const cb of [...callbacks]) { try { await cb(msg); } catch (err) { logger.error(`[overnight-benchmark] report callback failed: ${err}`); } }
        }
    } catch (err) {
        const msg = `🌙 Overnight benchmark ${today} FAILED — ${err instanceof Error ? err.message : err}`;
        logger.error(`[overnight-benchmark] ${msg}`);
        for (const cb of [...callbacks]) { try { await cb(msg); } catch { /* delivery is best-effort */ } }
    }
}

async function report(today: string, counts: SettleRunCounts): Promise<void> {
    const since = Date.now() - 30 * 86_400_000;
    const rows = await listSimTrades({ sinceMs: since });
    const proposals: TradeProposal[] = (await listProposals(undefined, 1000)).filter((p) => p.createdAt >= since);
    const actuals = new Map(proposals.map((p) => [p.id, { entryFillPrice: p.entryFillPrice, exitReason: p.exitReason }]));
    const message = formatSettleReport({
        date: today,
        summaries: summarizeVariants(rows),
        twin: twinCalibration(rows, actuals),
        inactive: VARIANTS_V1.filter((v) => v.status !== 'active').map((v) => v.name),
        run: counts,
    });
    logger.info(`[simulator] ${today}: ${JSON.stringify(counts)}`);
    for (const cb of [...callbacks]) {
        try { await cb(message); } catch (err) { logger.error(`[simulator] report callback failed: ${err}`); }
    }
}

let job: Cron | null = null;
let catchUpTimer: ReturnType<typeof setTimeout> | null = null;

export function startSimulator(): void {
    if (job || !isSimulatorEnabled()) return;
    job = new Cron(SETTLE_CRON, { timezone: ET }, () => {
        if (isMarketHoliday(etToday())) return;
        runSimulatorSettleOnce().catch((err) => logger.error(`[simulator] run failed: ${err}`));
    });
    // Boot catch-up: today's settle missing after the slot on a trading day.
    if (process.env.NODE_ENV !== 'test') {
        const t: ReturnType<typeof setTimeout> = setTimeout(() => {
            if (catchUpTimer !== t) return; // stopped while queued (review-35 lifecycle pattern)
            catchUpTimer = null;
            const today = etToday();
            const stamp = readStamp();
            const done = stamp?.date === today && stamp.status === 'completed';
            if (!done && etMinutesNow() >= SETTLE_MIN_ET && !isMarketHoliday(today)) {
                logger.info('[simulator] boot catch-up: today\'s settle not completed — running now');
                runSimulatorSettleOnce().catch((err) => logger.error(`[simulator] catch-up failed: ${err}`));
            }
        }, 45_000);
        catchUpTimer = t;
    }
    logger.info(`[simulator] scheduled ${SETTLE_CRON} ET: nightly shadow-variant settle (${VARIANTS_V1.filter((v) => v.status === 'active').length} active variants)`);
}

export function stopSimulator(): void {
    if (catchUpTimer) { clearTimeout(catchUpTimer); catchUpTimer = null; }
    if (job) { job.stop(); job = null; }
}
