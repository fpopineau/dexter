/**
 * Benchmark & capture ledger — measure the system against the market,
 * not against itself.
 *
 * Nightly at 16:45 ET (after the data archive):
 *
 *   1. GROUND TRUTH: the day's top movers, dexter-blind — from the
 *      post-close gainer/loser scanners, with per-symbol metrics from
 *      daily bars (gap vs intraday split: the overnight gap portion is
 *      uncapturable by policy and must not count as a miss).
 *   2. FUNNEL JOIN: how far each mover got through the pipeline —
 *      scanned/ranked (opportunity snapshots), triggered (recorded live
 *      by this service), proposed / refused (proposals + refusal ledger),
 *      executed (with capture efficiency vs the move available after the
 *      entry fill).
 *   3. COUNTERFACTUAL REPLAY (phase 2): each refusal with full levels is
 *      replayed against the day's 1-min bars — would the entry have
 *      filled, and would the stop or the target have been hit first?
 *      Ties inside one bar count as STOP (pessimistic). Outcomes persist
 *      on the refusal rows; the cumulative per-gate scoreboard turns
 *      "should we loosen gate X?" into a data query.
 *
 * Output: one JSONL record per day (benchmark-ledger.jsonl — the
 * calibration dataset) + a WhatsApp digest. Deterministic, no LLM.
 * Disable with BENCHMARK=false.
 */

import { BarSizeSetting } from '@stoqey/ib';
import { Cron } from 'croner';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchBars } from '@/tools/ibkr/signal-scorer.js';
import { logger } from '@/utils';
import { isMarketHoliday } from '@/utils/market-hours.js';
import { findUpcomingEarnings, reportedRecently } from './earnings-calendar.js';
import { getSymbolRankStatsSince, onBreadthTrigger, onOpportunityTrigger } from './opportunity-engine.js';
import { runScan } from './scanner-loop.js';
import {
    etDayStartMs,
    getGateScoreboard,
    listProposals,
    listRefusalsSince,
    setRefusalOutcome,
    type RefusalRecord,
} from './trade-proposals.js';

const ET = 'America/New_York';
const BENCHMARK_CRON = '45 16 * * 1-5';
const TOP_GAINERS = 10;
const TOP_LOSERS = 5;

// ---------------------------------------------------------------------------
// Pure pieces (unit-tested)
// ---------------------------------------------------------------------------

export interface DayMetrics {
    prevClose: number;
    open: number;
    high: number;
    low: number;
    close: number;
    /** Close vs previous close, %. */
    dayPct: number;
    /** Open vs previous close, % — the uncapturable overnight portion. */
    gapPct: number;
    /** Close vs open, % — what an intraday system could have played. */
    intradayPct: number;
}

/** Split a mover's day into gap (uncapturable) and intraday (capturable). */
export function computeDayMetrics(prevClose: number, open: number, high: number, low: number, close: number): DayMetrics | null {
    if (!(prevClose > 0) || !(open > 0) || !(close > 0)) return null;
    return {
        prevClose, open, high, low, close,
        dayPct: Math.round(((close - prevClose) / prevClose) * 10000) / 100,
        gapPct: Math.round(((open - prevClose) / prevClose) * 10000) / 100,
        intradayPct: Math.round(((close - open) / open) * 10000) / 100,
    };
}

export interface ReplayBar { open: number; high: number; low: number }

export type ReplayOutcome = 'unfilled' | 'target' | 'stop' | 'open';

export interface ReplayResult {
    outcome: ReplayOutcome;
    /** STP_LMT only: the trigger was touched (even if the limit never filled).
     *  Distinguishes "the move ran without us" from "never set up". */
    triggered: boolean;
    /** Index of the bar where the entry filled; null = never filled. */
    fillBar: number | null;
    /** Max favorable excursion after the fill, % of entry (≥ 0; bar-resolution
     *  approximation, exit bar included). */
    mfePct: number | null;
    /** Max adverse excursion after the fill, % of entry (≥ 0). */
    maePct: number | null;
}

/**
 * Replay a refused bracket against bars (chronological, post-refusal).
 *
 * Entry fill: LMT fills when price trades through the limit (long: low ≤
 * entry); MKT fills on the first bar. STP_LMT models the LIMIT BAND, not
 * just the trigger touch — on a violent breakout the stop triggers while
 * the limit never fills, and a replay that counts that as a fill flatters
 * exactly the counterfactuals it exists to score (the SMCI critique,
 * 2026-08-13):
 *   - bar crosses the trigger from within (long: open < trigger ≤ high):
 *     price traded THROUGH the band — filled (a single-tick jump over the
 *     whole band is a halt-reopen case, rare enough to accept);
 *   - bar opens at/beyond the trigger: the order is working as a pure
 *     limit from the open — fills only when price trades back into the
 *     band (long: low ≤ entryLimit), this bar or any later one;
 *   - no entryLimit recorded → legacy touch-fill.
 *
 * After the fill, the first bar touching stop or target decides; BOTH in
 * one bar → STOP (pessimistic — replays must not flatter). MFE/MAE are
 * tracked from the fill bar through the exit bar inclusive, referenced to
 * the entry level (MKT: the first bar's open).
 */
export function replayBracket(
    bars: ReplayBar[],
    direction: 'long' | 'short',
    entryType: string,
    entry: number,
    stop: number,
    target: number,
    entryLimit: number | null = null,
): ReplayResult {
    const long = direction === 'long';
    let filled = false;
    let triggered = false;
    let fillBar: number | null = null;
    let ref: number | null = null;     // excursion reference price
    let bestFav = 0;                    // favorable excursion, price units
    let bestAdv = 0;                    // adverse excursion, price units

    const finish = (outcome: ReplayOutcome): ReplayResult => ({
        outcome,
        triggered,
        fillBar,
        mfePct: ref !== null ? Math.round((bestFav / ref) * 10000) / 100 : null,
        maePct: ref !== null ? Math.round((bestAdv / ref) * 10000) / 100 : null,
    });

    for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        if (!(b.high > 0) || !(b.low > 0) || !(b.open > 0)) continue;

        if (!filled) {
            if (entryType === 'MKT') {
                filled = true; fillBar = i; ref = b.open;
            } else if (entryType === 'STP_LMT') {
                if (!triggered) {
                    triggered = long ? b.high >= entry : b.low <= entry;
                    if (triggered) {
                        const crossedWithin = long ? b.open < entry : b.open > entry;
                        const bandAtOpen = entryLimit === null
                            || (long ? b.open <= entryLimit : b.open >= entryLimit);
                        if (crossedWithin || bandAtOpen) {
                            filled = true; fillBar = i; ref = entry;
                        }
                    }
                } else if (entryLimit !== null && (long ? b.low <= entryLimit : b.high >= entryLimit)) {
                    // Resting limit finally trades — filled at the limit.
                    filled = true; fillBar = i; ref = entryLimit;
                }
                if (!filled) continue;
            } else {
                const fills = long ? b.low <= entry : b.high >= entry;
                if (!fills) continue;
                filled = true; fillBar = i; ref = entry;
            }
            // The fill bar itself can also resolve the exit — fall through.
        }

        if (ref !== null) {
            bestFav = Math.max(bestFav, long ? b.high - ref : ref - b.low);
            bestAdv = Math.max(bestAdv, long ? ref - b.low : b.high - ref);
        }
        const hitStop = long ? b.low <= stop : b.high >= stop;
        const hitTarget = long ? b.high >= target : b.low <= target;
        if (hitStop) return finish('stop');       // pessimistic on stop+target ties
        if (hitTarget) return finish('target');
    }
    return finish(filled ? 'open' : 'unfilled');
}

export interface FunnelStage {
    seen: boolean;
    maxRank: number | null;
    triggered: boolean;
    proposed: boolean;
    refusedBy: string[];
    /** A position was actually OPENED (an entry filled). An accepted order
     *  that never filled is `placedUnfilled`, never an execution
     *  (2026-09-08: INTC's resting bid read as "EXECUTED pnl $0"). */
    executed: boolean;
    placedUnfilled: boolean;
    /** The entry level of the unfilled order (for the "vs day low/high" line). */
    entryPlaced: number | null;
    /** Realized P&L of trades closed today on this symbol (null = none). */
    realizedPnl: number | null;
    /** % of the post-entry available move that was captured (longs: high
     *  above fill; null when not executed or metrics missing). */
    capturePct: number | null;
}

/** Earnings-relation of a mover: reported within the last session, or
 *  reporting within a day. Splits the ledger into two populations that
 *  must be judged separately — the gap of an earnings mover is forgone
 *  BY POLICY, not missed. */
export type Catalyst = 'earnings' | 'earnings-pending' | null;

/** One line of the digest per mover. */
export function formatMoverLine(symbol: string, m: DayMetrics, f: FunnelStage, catalyst: Catalyst = null): string {
    const move = `${m.dayPct >= 0 ? '+' : ''}${m.dayPct.toFixed(1)}% (gap ${m.gapPct >= 0 ? '+' : ''}${m.gapPct.toFixed(1)}, intraday ${m.intradayPct >= 0 ? '+' : ''}${m.intradayPct.toFixed(1)})`;
    let stage: string;
    if (f.executed) {
        stage = `EXECUTED${f.realizedPnl != null ? ` pnl ${f.realizedPnl >= 0 ? '+' : ''}$${f.realizedPnl.toFixed(0)}` : ''}${f.capturePct != null ? `, captured ${f.capturePct.toFixed(0)}% of available` : ''}`;
    } else if (f.placedUnfilled) {
        stage = `entry placed, NEVER FILLED — no position${f.entryPlaced != null ? ` (entry ${f.entryPlaced} vs day low ${m.low} / high ${m.high})` : ''}`;
    } else if (f.refusedBy.length) stage = `refused: ${[...new Set(f.refusedBy)].join(', ')}`;
    else if (f.proposed) stage = 'proposed, not executed';
    else if (f.triggered) stage = 'triggered, no proposal';
    else if (f.seen) stage = `seen (max rank ${f.maxRank}), never triggered`;
    else stage = 'NEVER SEEN by the scanners';
    const tag = catalyst === 'earnings' ? ' · 📅 earnings' : catalyst === 'earnings-pending' ? ' · 📅 reports soon' : '';
    return `• ${symbol} ${move}${tag} — ${stage}`;
}

// ---------------------------------------------------------------------------
// Trigger-event recording (funnel stage 'triggered' is not persisted
// anywhere else — this service records fires as they happen)
// ---------------------------------------------------------------------------

function triggerEventsPath(): string {
    return join(process.env.DEXTER_DATA_DIR || join('.dexter', 'data'), 'trigger-events.json');
}

interface TriggerEvent { at: number; symbol: string; kind: 'single' | 'breadth' }

function loadTriggerEvents(): TriggerEvent[] {
    try {
        return JSON.parse(readFileSync(triggerEventsPath(), 'utf-8')) as TriggerEvent[];
    } catch { return []; }
}

function recordTriggerEvent(symbol: string, kind: 'single' | 'breadth'): void {
    try {
        const events = loadTriggerEvents().filter((e) => Date.now() - e.at < 7 * 24 * 3600_000);
        events.push({ at: Date.now(), symbol: symbol.toUpperCase(), kind });
        writeFileSync(triggerEventsPath(), JSON.stringify(events));
    } catch (err) {
        logger.warn(`[benchmark] trigger event persist failed: ${err}`);
    }
}

// ---------------------------------------------------------------------------
// Report bus (bridged to WhatsApp by the gateway)
// ---------------------------------------------------------------------------

type ReportCallback = (message: string) => void | Promise<void>;
const callbacks = new Set<ReportCallback>();

export function onBenchmarkReport(cb: ReportCallback): () => void {
    callbacks.add(cb);
    return () => callbacks.delete(cb);
}

export function isBenchmarkEnabled(): boolean {
    return (process.env.BENCHMARK ?? 'true').trim().toLowerCase() !== 'false';
}

function ledgerPath(): string {
    return join(process.env.DEXTER_DATA_DIR || join('.dexter', 'data'), 'benchmark-ledger.jsonl');
}

// ---------------------------------------------------------------------------
// The nightly run
// ---------------------------------------------------------------------------

async function dayMetricsFor(symbol: string): Promise<DayMetrics | null> {
    try {
        const bars = (await fetchBars(symbol, BarSizeSetting.DAYS_ONE, '3 D', true)).filter((b) => b.close != null);
        if (bars.length < 2) return null;
        const today = bars[bars.length - 1];
        const prev = bars[bars.length - 2];
        return computeDayMetrics(prev.close!, today.open ?? today.close!, today.high ?? today.close!, today.low ?? today.close!, today.close!);
    } catch { return null; }
}

export async function runBenchmarkOnce(): Promise<void> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: ET });
    if (isMarketHoliday(today)) return;
    const dayStart = etDayStartMs();

    // 1. Ground truth: post-close top movers (dexter-blind, but through the
    //    same tradability floor the system itself uses).
    const movers = new Map<string, 'up' | 'down'>();
    for (const [code, dir] of [['TOP_PERC_GAIN', 'up'], ['TOP_PERC_LOSE', 'down']] as const) {
        try {
            const results = await runScan(code, { aboveVolume: 500_000 });
            for (const r of results.slice(0, dir === 'up' ? TOP_GAINERS : TOP_LOSERS)) {
                if (r.symbol && r.secType === 'STK') movers.set(r.symbol, dir);
            }
        } catch (err) {
            logger.warn(`[benchmark] ${code} scan failed: ${err}`);
        }
    }
    if (movers.size === 0) {
        logger.warn('[benchmark] no movers from post-close scans — skipping this run');
        return;
    }

    // 2. Funnel data for the day.
    const rankStats = await getSymbolRankStatsSince(dayStart);
    const triggeredToday = new Set(loadTriggerEvents().filter((e) => e.at >= dayStart).map((e) => e.symbol));
    const proposalsToday = (await listProposals(undefined, 200).catch(() => []))
        .filter((p) => p.createdAt >= dayStart);
    const refusalsToday = await listRefusalsSince(dayStart).catch(() => [] as RefusalRecord[]);

    // Catalyst tagging: reported within the last session, or reports within
    // a day (calendar is cached per-day; failures degrade to untagged).
    const pendingEarnings = await findUpcomingEarnings([...movers.keys()], 1)
        .then((r) => new Set(r.hits.map((h) => h.symbol)))
        .catch(() => new Set<string>());
    const catalystFor = async (symbol: string): Promise<Catalyst> => {
        try {
            if (await reportedRecently(symbol)) return 'earnings';
        } catch { /* untagged */ }
        return pendingEarnings.has(symbol) ? 'earnings-pending' : null;
    };

    const moverLines: string[] = [];
    const ledgerMovers: Array<Record<string, unknown>> = [];
    for (const [symbol, moveDir] of movers) {
        const metrics = await dayMetricsFor(symbol);
        if (!metrics) continue;
        const catalyst = await catalystFor(symbol);
        const props = proposalsToday.filter((p) => p.symbol === symbol);
        // Executed = a position was OPENED (entry filled). An accepted order
        // whose entry never filled (cancelled at expiry, or still resting)
        // is placed-unfilled and stays out of the realized statistics.
        const accepted = props.filter((p) => p.status === 'executed' || p.status === 'closed');
        const executed = accepted.filter((p) => p.entryFillPrice != null);
        const unfilled = accepted.filter((p) => p.entryFillPrice == null);
        const closedWithPnl = executed.filter((p) => p.realizedPnl != null);
        const realizedPnl = closedWithPnl.length
            ? Math.round(closedWithPnl.reduce((s, p) => s + (p.realizedPnl ?? 0), 0) * 100) / 100
            : null;
        // Capture: realized move per share vs move available after the fill.
        let capturePct: number | null = null;
        const fill = executed.find((p) => p.entryFillPrice != null);
        if (fill?.entryFillPrice != null) {
            const available = fill.direction === 'long' ? metrics.high - fill.entryFillPrice : fill.entryFillPrice - metrics.low;
            const perShare = closedWithPnl.length && fill.quantity > 0 ? (realizedPnl ?? 0) / fill.quantity : null;
            if (available > 0 && perShare != null) capturePct = Math.round((perShare / available) * 100);
        }
        const funnel: FunnelStage = {
            seen: rankStats.has(symbol),
            maxRank: rankStats.get(symbol)?.maxRank ?? null,
            triggered: triggeredToday.has(symbol),
            proposed: props.length > 0,
            refusedBy: refusalsToday.filter((r) => r.symbol === symbol).map((r) => r.gate),
            executed: executed.length > 0,
            placedUnfilled: executed.length === 0 && unfilled.length > 0,
            entryPlaced: unfilled[0]?.entry ?? unfilled[0]?.entryLimit ?? null,
            realizedPnl,
            capturePct,
        };
        moverLines.push(formatMoverLine(symbol, metrics, funnel, catalyst));
        ledgerMovers.push({ symbol, moveDir, catalyst, ...metrics, ...funnel });
    }

    // 3. Counterfactual replay of today's unevaluated refusals.
    let replayed = 0;
    for (const r of refusalsToday) {
        if (r.outcome !== null) continue;
        if (r.entry == null || r.stop == null || r.target == null) {
            await setRefusalOutcome(r.id, 'unknown', 'incomplete levels').catch(() => { /* best-effort */ });
            continue;
        }
        try {
            // The counterfactual starts at the refusal, not at the open.
            const c = new Date(new Date(r.createdAt).toLocaleString('en-US', { timeZone: ET }));
            const createdEt = Date.UTC(c.getFullYear(), c.getMonth(), c.getDate(), c.getHours(), c.getMinutes(), c.getSeconds());
            const bars = (await fetchBars(r.symbol, BarSizeSetting.MINUTES_ONE, '1 D', true))
                .filter((b) => b.open != null && b.high != null && b.low != null && b.time != null)
                .filter((b) => {
                    const m = /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(b.time!);
                    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) >= createdEt : false;
                })
                .map((b) => ({ open: b.open!, high: b.high!, low: b.low! }));
            const res = replayBracket(bars, r.direction, r.entryType, r.entry, r.stop, r.target, r.entryLimit);
            const rr = Math.abs(r.target - r.entry) / Math.max(Math.abs(r.entry - r.stop), 1e-9);
            const excursion = res.mfePct != null && res.maePct != null
                ? ` (MFE +${res.mfePct}% / MAE -${res.maePct}%)` : '';
            const note = res.outcome === 'target' ? `would have WON ~${rr.toFixed(1)}R${excursion}`
                : res.outcome === 'stop' ? `would have lost 1R${excursion}`
                : res.outcome === 'unfilled'
                    ? (res.triggered ? 'trigger touched but the limit never filled — the move ran without us' : 'entry never filled')
                : `still open at the close${excursion}`;
            await setRefusalOutcome(r.id, res.outcome, note, res.mfePct, res.maePct);
            replayed++;
        } catch (err) {
            logger.warn(`[benchmark] replay ${r.symbol} failed: ${err}`);
        }
        await new Promise((res) => setTimeout(res, 300)); // IBKR pacing
    }

    // 4. Persist the day's record + notify.
    const scoreboard = await getGateScoreboard().catch(() => []);
    try {
        appendFileSync(ledgerPath(), JSON.stringify({ day: today, movers: ledgerMovers, replayedRefusals: replayed }) + '\n');
    } catch (err) {
        logger.warn(`[benchmark] ledger persist failed: ${err}`);
    }

    const funnelCounts = {
        movers: ledgerMovers.length,
        seen: ledgerMovers.filter((m) => m.seen).length,
        triggered: ledgerMovers.filter((m) => m.triggered).length,
        proposed: ledgerMovers.filter((m) => m.proposed).length,
        executed: ledgerMovers.filter((m) => m.executed).length,
        placedUnfilled: ledgerMovers.filter((m) => m.placedUnfilled).length,
    };
    const scoreLines = scoreboard
        .filter((g) => g.wouldStop + g.wouldTarget > 0)
        .slice(0, 5)
        .map((g) => `${g.gate}: ${g.total} blocked → ${g.wouldStop} would-stop / ${g.wouldTarget} would-target`);

    const message =
        `📐 Capture report ${today}\n${moverLines.join('\n')}\n` +
        `Funnel: ${funnelCounts.movers} movers → ${funnelCounts.seen} seen → ${funnelCounts.triggered} triggered → ` +
        `${funnelCounts.proposed} proposed → ${funnelCounts.executed} executed${funnelCounts.placedUnfilled ? ` (+${funnelCounts.placedUnfilled} placed, never filled)` : ''}.` +
        (scoreLines.length ? `\nGate scoreboard (cumulative): ${scoreLines.join(' · ')}` : '');

    logger.info(`[benchmark] ${today}: ${funnelCounts.movers} movers, ${replayed} refusals replayed`);
    for (const cb of [...callbacks]) {
        try { await cb(message); } catch (err) {
            logger.error(`[benchmark] report callback failed: ${err}`);
        }
    }
}

let job: Cron | null = null;
let unsubTrigger: (() => void) | null = null;
let unsubBreadth: (() => void) | null = null;

/** Start the nightly benchmark + live trigger-event recording (idempotent). */
export function startBenchmark(): void {
    if (job || !isBenchmarkEnabled()) return;
    unsubTrigger = onOpportunityTrigger((opp) => recordTriggerEvent(opp.symbol, 'single'));
    unsubBreadth = onBreadthTrigger((ev) => recordTriggerEvent(ev.vehicle, 'breadth'));
    job = new Cron(BENCHMARK_CRON, { timezone: ET }, () => {
        runBenchmarkOnce().catch((err) => logger.error(`[benchmark] run failed: ${err}`));
    });
    logger.info('[benchmark] scheduled 16:45 ET: top-mover capture report + refusal counterfactual replay');
}

export function stopBenchmark(): void {
    if (job) { job.stop(); job = null; }
    unsubTrigger?.(); unsubTrigger = null;
    unsubBreadth?.(); unsubBreadth = null;
}
