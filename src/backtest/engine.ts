/**
 * Backtest engine — bar-by-bar replay orchestrator.
 *
 * Ties together: data-loader → ta-indicators → signal-scorer → simulator → metrics.
 * Supports walk-forward validation and optional GDELT sentiment integration.
 */

import { computeSignalScore, type SignalResult } from '@/tools/ibkr/signal-scorer.js';
import {
    computeAll,
    type OHLCV
} from '@/tools/ibkr/ta-indicators.js';
import { logger } from '@/utils';
import { barsToOHLCV, loadArchive, loadFirstRate, type Bar, type LoadOptions } from './data-loader.js';
import { computeMetrics, type BacktestMetrics, type EquityPoint, type Trade } from './metrics.js';
import { aggregateDaily, loadSentiment, type DailySentiment } from './sentiment-loader.js';
import { Simulator, type OrderRequest, type SimulatorConfig } from './simulator.js';

/** Engine contract version (WP9, REMEDIATION-2026-08-20). Bump on any
 *  change to fill timing, advance semantics, or sizing — calibrate-scorer
 *  refuses to run against an engine older than what it was written for.
 *  'wp9-honest-replay-1': next-bar fills, per-symbol advance, gap-aware
 *  exits, warm-up preload, risk-based sizing, 2R defaults. */
export const ENGINE_VERSION = 'wp9-honest-replay-1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EngineConfig {
    /** Tickers to backtest. */
    tickers: string[];
    /** Data source: 'firstrate' or 'archive' (SQLite). */
    dataSource: 'firstrate' | 'archive';
    /** Start date 'YYYY-MM-DD'. */
    startDate: string;
    /** End date 'YYYY-MM-DD'. */
    endDate: string;
    /** Bar size for TA computation. Default '5 mins'. */
    barSize?: string;
    /** Timeframe for resampling (only for FirstRate 1-min data). */
    timeframe?: '1m' | '5m' | '15m' | '1h' | '1d';
    /** FirstRate data directory override. */
    firstRateDir?: string;
    /** Number of bars of lookback needed for indicators. Default 200. */
    lookbackBars?: number;
    /** Simulator configuration overrides. */
    simulator?: Partial<SimulatorConfig>;

    // Signal generation
    /** Minimum signal score to trigger an order (0–100). Default 60. */
    minSignalScore?: number;
    /** Direction bias: 'long', 'short', or 'both'. Default 'long'. */
    direction?: 'long' | 'short' | 'both';
    /** Stop-loss as ATR multiple. Default 2.0. */
    stopAtrMultiple?: number;
    /** Take-profit as ATR multiple. Default 3.0. */
    targetAtrMultiple?: number;
    /** Maximum bars to hold a position. Default 0 (unlimited). */
    maxBarsHeld?: number;

    // Sentiment
    /** Enable GDELT sentiment overlay. WP9: requires allowSentimentLookahead
     *  — the overlay keys on the CALENDAR DAY's aggregate, so a 09:35 bar
     *  sees 15:50 news. Disabled with a warning unless explicitly allowed. */
    useSentiment?: boolean;
    /** Explicit opt-in to the sentiment overlay's day-level look-ahead. */
    allowSentimentLookahead?: boolean;
    /** GDELT data directory override. */
    gdeltDir?: string;
    /** Sentiment score boost/penalty range (added to signal score). Default 10. */
    sentimentWeight?: number;

    /** Test/strategy hook (WP9): when set, replaces the scorer entirely —
     *  called once per (ticker, completed bar) with the lookback window;
     *  return an order to submit or null. */
    signalOverride?: (ticker: string, window: OHLCV, bar: Bar) => OrderRequest | null;

    // Walk-forward
    /** Enable walk-forward validation. */
    walkForward?: boolean;
    /** Training window in calendar days. Default 180 (6 months). */
    trainDays?: number;
    /** Test window in calendar days. Default 30 (1 month). */
    testDays?: number;
}

export interface BacktestResult {
    config: EngineConfig;
    metrics: BacktestMetrics;
    trades: Trade[];
    equityCurve: EquityPoint[];
    /** Per-symbol metrics if multi-symbol. */
    perSymbol?: Record<string, BacktestMetrics>;
    /** Walk-forward fold results (if enabled). */
    folds?: WalkForwardFold[];
}

export interface WalkForwardFold {
    foldIndex: number;
    /** Train range kept for a FUTURE fitting step. WP9 deleted the inert
     *  train simulation: it fitted nothing, selected nothing, and doubled
     *  runtime for a display-only number that dressed segmented replay up
     *  as walk-forward validation. */
    trainStart: string;
    trainEnd: string;
    testStart: string;
    testEnd: string;
    testMetrics: BacktestMetrics;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().substring(0, 10);
}

/** WP9: the sentiment overlay keys on the calendar DAY's aggregate — a
 *  09:35 bar sees 15:50 news. Usable only with the look-ahead explicitly
 *  owned; otherwise disabled loudly. */
function resolveSentimentUse(config: EngineConfig): boolean {
    if (!config.useSentiment) return false;
    if (config.allowSentimentLookahead) return true;
    logger.warn(
        '[engine] useSentiment DISABLED: the day-level GDELT overlay applies the whole day\'s news to every ' +
        'intraday bar (look-ahead). Pass allowSentimentLookahead: true to own that bias explicitly.',
    );
    return false;
}

/** Per-symbol realized equity curve: starting capital stepped by each
 *  trade's net P&L at its exit time. Realized-only (no intrabar marks),
 *  but honestly PER-SYMBOL. */
function buildRealizedCurve(trades: Trade[], startingCapital: number): EquityPoint[] {
    const sorted = [...trades].sort((a, b) => a.exitTime.localeCompare(b.exitTime));
    let equity = startingCapital;
    let peak = startingCapital;
    return sorted.map((t) => {
        equity += t.pnl;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        return { time: t.exitTime, equity, drawdown: dd, drawdownPct: peak > 0 ? dd / peak : 0 };
    });
}

/** Get the last N values from a OHLCV, including current bar. */
function sliceOHLCV(ohlcv: OHLCV, endIdx: number, length: number): OHLCV {
    const start = Math.max(0, endIdx - length + 1);
    const end = endIdx + 1;
    return {
        time: ohlcv.time.slice(start, end),
        open: ohlcv.open.slice(start, end),
        high: ohlcv.high.slice(start, end),
        low: ohlcv.low.slice(start, end),
        close: ohlcv.close.slice(start, end),
        volume: ohlcv.volume.slice(start, end),
    };
}

/** Get last non-NaN value from array. */
function lastValid(arr: number[]): number {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (!isNaN(arr[i])) return arr[i];
    }
    return NaN;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run a full backtest.
 */
export async function runBacktest(config: EngineConfig): Promise<BacktestResult> {
    const {
        tickers,
        startDate,
        endDate,
        walkForward = false,
        trainDays = 180,
        testDays = 30,
    } = config;

    if (walkForward) {
        return runWalkForward(config, trainDays, testDays);
    }

    // Single-pass backtest
    logger.info(`[engine] Starting backtest (${ENGINE_VERSION}): ${tickers.join(',')} ${startDate} → ${endDate}`);

    const allBars = await loadAllBars(config);
    const sentiment = resolveSentimentUse(config)
        ? await loadSentimentData(config)
        : new Map<string, DailySentiment[]>();

    const sim = new Simulator(config.simulator);
    const { trades, equityCurve } = runSimulation(config, allBars, sentiment, sim);

    const metrics = computeMetrics(trades, equityCurve, sim.config.startingCapital);

    // Per-symbol metrics from PER-SYMBOL realized curves (WP9): the old
    // code passed the PORTFOLIO curve, so every curve-derived field
    // (Sharpe, drawdown, returns) was identical across symbols.
    let perSymbol: Record<string, BacktestMetrics> | undefined;
    if (tickers.length > 1) {
        perSymbol = {};
        for (const ticker of tickers) {
            const symbolTrades = trades.filter((t) => t.symbol === ticker);
            if (symbolTrades.length > 0) {
                perSymbol[ticker] = computeMetrics(
                    symbolTrades,
                    buildRealizedCurve(symbolTrades, sim.config.startingCapital),
                    sim.config.startingCapital,
                );
            }
        }
    }

    logger.info(
        `[engine] Backtest complete: ${trades.length} trades, Sharpe=${metrics.sharpeRatio.toFixed(2)}, ` +
        `MaxDD=${(metrics.maxDrawdownPct * 100).toFixed(1)}%, WinRate=${(metrics.winRate * 100).toFixed(1)}%`,
    );

    return { config, metrics, trades, equityCurve, perSymbol };
}

// ---------------------------------------------------------------------------
// Walk-forward
// ---------------------------------------------------------------------------

async function runWalkForward(
    config: EngineConfig,
    trainDays: number,
    testDays: number,
): Promise<BacktestResult> {
    const { startDate, endDate } = config;
    const folds: WalkForwardFold[] = [];
    const allTrades: Trade[] = [];
    const allEquity: EquityPoint[] = [];
    const startingCapital = config.simulator?.startingCapital ?? 100_000;

    // Each fold's simulator restarts at startingCapital; chain the
    // out-of-sample curves multiplicatively so the aggregate equity curve
    // compounds across folds instead of resetting (which made the headline
    // metrics reflect only the LAST fold).
    let chainScale = 1;

    let foldIdx = 0;
    let cursor = startDate;

    while (cursor < endDate) {
        const trainStart = cursor;
        const trainEnd = addDays(trainStart, trainDays);
        const testStart = trainEnd;
        const testEnd = addDays(testStart, testDays);

        if (testStart >= endDate) break;
        const effectiveTestEnd = testEnd > endDate ? endDate : testEnd;

        logger.info(`[engine] Walk-forward fold ${foldIdx}: train ${trainStart}→${trainEnd} (reserved), test ${testStart}→${effectiveTestEnd}`);

        // WP9: NO train simulation — there is no fitting step, so running
        // the strategy over the train window fitted nothing, selected
        // nothing, and doubled runtime for a display-only number. The
        // train range is preserved on the fold for the day a fitting step
        // exists; until then this is honestly labeled segmented replay.
        const testConfig = { ...config, startDate: testStart, endDate: effectiveTestEnd, walkForward: false };
        const testBars = await loadAllBars(testConfig);
        const testSentiment = resolveSentimentUse(config)
            ? await loadSentimentData(testConfig)
            : new Map<string, DailySentiment[]>();
        const testSim = new Simulator(config.simulator);
        const testResult = runSimulation(testConfig, testBars, testSentiment, testSim);
        const testMetrics = computeMetrics(testResult.trades, testResult.equityCurve, testSim.config.startingCapital);

        folds.push({
            foldIndex: foldIdx,
            trainStart,
            trainEnd,
            testStart,
            testEnd: effectiveTestEnd,
            testMetrics,
        });

        allTrades.push(...testResult.trades);
        for (const pt of testResult.equityCurve) {
            allEquity.push({ ...pt, equity: pt.equity * chainScale });
        }
        if (testResult.equityCurve.length > 0) {
            const foldEnd = testResult.equityCurve[testResult.equityCurve.length - 1].equity;
            chainScale *= foldEnd / startingCapital;
        }

        cursor = addDays(cursor, testDays); // step forward by test window
        foldIdx++;
    }

    const metrics = computeMetrics(allTrades, allEquity, startingCapital);

    if (folds.length === 0) {
        logger.warn(
            `[engine] Walk-forward produced 0 folds: period ${startDate}→${endDate} is shorter than ` +
            `one train+test window (${trainDays}+${testDays} days). Extend the period or shrink trainDays/testDays.`,
        );
    }
    logger.info(`[engine] Walk-forward complete: ${folds.length} folds, ${allTrades.length} OOS trades, Sharpe=${metrics.sharpeRatio.toFixed(2)}`);

    return { config, metrics, trades: allTrades, equityCurve: allEquity, folds };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/** Approximate RTH bars per session per timeframe — sizes the warm-up. */
const BARS_PER_DAY: Record<string, number> = { '1m': 390, '5m': 78, '15m': 26, '1h': 7, '1d': 1 };

/** WP9: indicators need `lookback` bars BEFORE the first tradable bar —
 *  the old loader started at startDate, so every window (and every
 *  walk-forward test fold) burned its first ~lookback bars producing
 *  nothing. Load from earlier; runSimulation gates signals and the equity
 *  curve to startDate. */
function warmupStartDate(config: EngineConfig): string {
    const perDay = BARS_PER_DAY[config.timeframe ?? '5m'] ?? 78;
    const tradingDays = Math.ceil((config.lookbackBars ?? 200) / perDay);
    const calendarDays = Math.ceil(tradingDays * 1.5) + 3; // weekends/holidays buffer
    return addDays(config.startDate, -calendarDays);
}

async function loadAllBars(config: EngineConfig): Promise<Map<string, Bar[]>> {
    const result = new Map<string, Bar[]>();
    const loadOpts: LoadOptions = {
        startDate: warmupStartDate(config),
        endDate: config.endDate,
        timeframe: config.timeframe ?? '5m',
    };

    for (const ticker of config.tickers) {
        let bars: Bar[];
        if (config.dataSource === 'firstrate') {
            bars = await loadFirstRate(ticker, loadOpts, config.firstRateDir);
        } else {
            bars = await loadArchive(ticker, config.barSize ?? '5 mins', loadOpts);
        }
        if (bars.length > 0) {
            result.set(ticker, bars);
        } else {
            logger.warn(`[engine] No bars loaded for ${ticker}`);
        }
    }

    return result;
}

async function loadSentimentData(config: EngineConfig): Promise<Map<string, DailySentiment[]>> {
    const records = await loadSentiment(
        config.startDate,
        config.endDate,
        config.tickers,
        config.gdeltDir,
    );
    const daily = aggregateDaily(records);

    // Group by ticker
    const grouped = new Map<string, DailySentiment[]>();
    for (const d of daily) {
        const arr = grouped.get(d.ticker);
        if (arr) arr.push(d);
        else grouped.set(d.ticker, [d]);
    }
    return grouped;
}

// ---------------------------------------------------------------------------
// Core simulation loop
// ---------------------------------------------------------------------------

/**
 * The replay loop (WP9). Exported for the engine harness — fully
 * injectable: bars in, trades out, no I/O.
 *
 * ORDERING CONTRACT (the anchor): each timestamp ADVANCES the simulator
 * FIRST (pending orders fill at this bar's open), then generates signals
 * from this completed bar (their orders fill at the NEXT bar's open). The
 * old code inverted this — an order decided on bar i's close filled at
 * bar i's open, harvesting each bar's own body on entry.
 */
export function runSimulation(
    config: EngineConfig,
    allBars: Map<string, Bar[]>,
    sentiment: Map<string, DailySentiment[]>,
    sim: Simulator,
): { trades: Trade[]; equityCurve: EquityPoint[] } {
    const lookback = config.lookbackBars ?? 200;
    const minScore = config.minSignalScore ?? 60;
    const direction = config.direction ?? 'long';
    const stopAtr = config.stopAtrMultiple ?? 2.0;
    const targetAtr = config.targetAtrMultiple ?? 4.0;
    const maxBarsHeld = config.maxBarsHeld ?? 0;
    const sentimentWeight = config.sentimentWeight ?? 10;
    const barSize = config.barSize ?? '5 mins';

    // Build sentiment lookup: ticker → date → DailySentiment
    const sentimentLookup = new Map<string, Map<string, DailySentiment>>();
    for (const [ticker, dailies] of sentiment) {
        const byDate = new Map<string, DailySentiment>();
        for (const d of dailies) byDate.set(d.date, d);
        sentimentLookup.set(ticker, byDate);
    }

    // Per-ticker OHLCV and time→index maps built ONCE — the old loop did a
    // findIndex per (timestamp × ticker), O(N²) with an array copy per bar.
    const ohlcvByTicker = new Map<string, OHLCV>();
    const indexByTicker = new Map<string, Map<string, number>>();
    for (const [ticker, bars] of allBars) {
        ohlcvByTicker.set(ticker, barsToOHLCV(bars));
        const idx = new Map<string, number>();
        bars.forEach((b, i) => idx.set(b.time, i));
        indexByTicker.set(ticker, idx);
    }

    const timeline = buildTimeline(allBars);
    for (const { time, barsByTicker } of timeline) {
        // Warm-up bars (before startDate) feed indicators only: no orders
        // exist yet, and a flat warm-up equity curve would dilute Sharpe.
        const live = time >= config.startDate;
        if (live) sim.processBars(time, barsByTicker);

        for (const [ticker, bar] of barsByTicker) {
            const idx = indexByTicker.get(ticker)!.get(time)!;
            if (idx < lookback || !live) continue;
            const window = sliceOHLCV(ohlcvByTicker.get(ticker)!, idx, lookback);
            if (config.signalOverride) {
                const order = config.signalOverride(ticker, window, bar);
                if (order) sim.submitOrder(order);
                continue;
            }
            generateSignal(ticker, bar, window, minScore, direction, stopAtr, targetAtr, maxBarsHeld, sentimentWeight, barSize, sentimentLookup, sim);
        }
    }

    // Close remaining positions, each at its own symbol's last close.
    sim.closeAll('end_of_backtest');

    return { trades: sim.trades, equityCurve: sim.equityCurve };
}

// ---------------------------------------------------------------------------
// Signal generation for one bar
// ---------------------------------------------------------------------------

function generateSignal(
    ticker: string,
    bar: Bar,
    ohlcvWindow: OHLCV,
    minScore: number,
    directionBias: 'long' | 'short' | 'both',
    stopAtrMult: number,
    targetAtrMult: number,
    maxBarsHeld: number,
    sentimentWeight: number,
    barSize: string,
    sentimentLookup: Map<string, Map<string, DailySentiment>>,
    sim: Simulator,
): void {
    // Skip if already have a position in this symbol
    if (sim.getPositionsForSymbol(ticker).length > 0) return;
    if (sim.isDailyHalted()) return;

    // Compute indicators
    const indicators = computeAll(ohlcvWindow);

    // Get ATR for stops/targets
    const atrValues = indicators.atr?.atr;
    const currentAtr = atrValues ? lastValid(atrValues) : NaN;
    if (isNaN(currentAtr) || currentAtr <= 0) return;

    const price = bar.close;

    // Evaluate directions
    const directions: Array<'long' | 'short'> = directionBias === 'both'
        ? ['long', 'short']
        : [directionBias];

    let bestSignal: SignalResult | null = null;
    let bestDirection: 'long' | 'short' = 'long';

    for (const dir of directions) {
        const signal = computeSignalScore(ticker, dir, barSize, indicators, ohlcvWindow);
        let adjustedScore = signal.compositeScore;

        // Sentiment overlay
        const tickerSentiment = sentimentLookup.get(ticker);
        if (tickerSentiment) {
            const date = bar.time.substring(0, 10);
            const daySentiment = tickerSentiment.get(date);
            if (daySentiment) {
                // Goldstein scale is -10 to +10. Normalize to -1..+1 and apply weight.
                const sentimentBoost = (daySentiment.avgGoldstein / 10) * sentimentWeight;
                // For long: positive sentiment boosts, negative penalizes
                // For short: inverse
                adjustedScore += dir === 'long' ? sentimentBoost : -sentimentBoost;
                adjustedScore = Math.max(0, Math.min(100, adjustedScore));
            }
        }

        if (adjustedScore >= minScore) {
            if (!bestSignal || adjustedScore > bestSignal.compositeScore) {
                bestSignal = { ...signal, compositeScore: adjustedScore };
                bestDirection = dir;
            }
        }
    }

    if (!bestSignal) return;

    // Compute stop and target
    let stopLoss: number;
    let takeProfit: number;
    if (bestDirection === 'long') {
        stopLoss = price - currentAtr * stopAtrMult;
        takeProfit = price + currentAtr * targetAtrMult;
    } else {
        stopLoss = price + currentAtr * stopAtrMult;
        takeProfit = price - currentAtr * targetAtrMult;
    }

    const order: OrderRequest = {
        symbol: ticker,
        direction: bestDirection,
        quantity: 0, // auto-size
        stopLoss,
        takeProfit,
        maxBarsHeld: maxBarsHeld || undefined,
        signalScore: bestSignal.compositeScore,
    };

    sim.submitOrder(order);
}

// ---------------------------------------------------------------------------
// Multi-symbol timeline
// ---------------------------------------------------------------------------

interface TimelineEntry {
    time: string;
    barsByTicker: Map<string, Bar>;
}

function buildTimeline(allBars: Map<string, Bar[]>): TimelineEntry[] {
    // Collect all unique timestamps
    const timeSet = new Set<string>();
    for (const bars of allBars.values()) {
        for (const bar of bars) {
            timeSet.add(bar.time);
        }
    }

    // Build index for each ticker: time → bar
    const indices = new Map<string, Map<string, Bar>>();
    for (const [ticker, bars] of allBars) {
        const idx = new Map<string, Bar>();
        for (const bar of bars) idx.set(bar.time, bar);
        indices.set(ticker, idx);
    }

    // Build sorted timeline
    const sortedTimes = [...timeSet].sort();
    const timeline: TimelineEntry[] = [];

    for (const time of sortedTimes) {
        const barsByTicker = new Map<string, Bar>();
        for (const [ticker, idx] of indices) {
            const bar = idx.get(time);
            if (bar) barsByTicker.set(ticker, bar);
        }
        if (barsByTicker.size > 0) {
            timeline.push({ time, barsByTicker });
        }
    }

    return timeline;
}
