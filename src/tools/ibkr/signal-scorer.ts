/**
 * Signal Scorer tool — multi-factor signal scoring for trade candidates.
 *
 * Computes a 0–100 composite score from:
 *   - Momentum (MACD slope, RSI trend, price vs EMAs)
 *   - Mean reversion (distance from VWAP/Bollinger midline, RSI extremes)
 *   - Volume confirmation (RVOL, volume Z-score)
 *   - Trend alignment (EMA stack, price position in structure)
 *
 * The score is directional — caller specifies long or short bias and the
 * scorer evaluates whether the indicators support that direction.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Bar } from '@stoqey/ib';
import { BarSizeSetting, Contract, EventName, SecType, WhatToShow } from '@stoqey/ib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { allocReqId, getIBApi, isNonFatalIbkrError } from './connection.js';
import { type AllIndicators, type OHLCV, computeAll } from './ta-indicators.js';

// ---------------------------------------------------------------------------
// Factor weights — calibratable via scripts/calibrate-scorer.ts
//
// Resolution order: explicit `weights` argument > setActiveWeights() override
// (used by the calibration grid search) > .dexter/data/scorer-weights.json
// (written by calibration --apply) > equal DEFAULT_WEIGHTS.
// ---------------------------------------------------------------------------

export interface FactorWeights {
    momentum: number;
    meanReversion: number;
    volume: number;
    trend: number;
}

export const DEFAULT_WEIGHTS: FactorWeights = {
    momentum: 0.25,
    meanReversion: 0.25,
    volume: 0.25,
    trend: 0.25,
};

function normalizeWeights(w: FactorWeights): FactorWeights {
    const m = Math.max(0, w.momentum);
    const r = Math.max(0, w.meanReversion);
    const v = Math.max(0, w.volume);
    const t = Math.max(0, w.trend);
    const sum = m + r + v + t;
    if (!(sum > 0)) return DEFAULT_WEIGHTS;
    return { momentum: m / sum, meanReversion: r / sum, volume: v / sum, trend: t / sum };
}

let weightsOverride: FactorWeights | null = null;
let fileWeights: FactorWeights | null | undefined; // undefined = not yet loaded

/** Set (or clear with null) an in-process weights override — calibration use. */
export function setActiveWeights(w: FactorWeights | null): void {
    weightsOverride = w ? normalizeWeights(w) : null;
}

function loadFileWeights(): FactorWeights | null {
    if (fileWeights !== undefined) return fileWeights;
    try {
        const dir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
        const raw = JSON.parse(readFileSync(join(dir, 'scorer-weights.json'), 'utf-8')) as Partial<FactorWeights>;
        if (
            typeof raw.momentum === 'number' && typeof raw.meanReversion === 'number' &&
            typeof raw.volume === 'number' && typeof raw.trend === 'number'
        ) {
            fileWeights = normalizeWeights(raw as FactorWeights);
        } else {
            fileWeights = null;
        }
    } catch {
        fileWeights = null;
    }
    return fileWeights;
}

/** Weights in effect right now (override > file > defaults). */
export function getActiveWeights(): FactorWeights {
    return weightsOverride ?? loadFileWeights() ?? DEFAULT_WEIGHTS;
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

export const SIGNAL_SCORER_DESCRIPTION = `
Multi-factor signal scorer for trade candidates. Takes a ticker and trade
direction (long/short) and returns a composite score (0–100) broken down by:
  - Momentum (25%) — MACD histogram slope, RSI direction, price vs EMAs
  - Mean reversion (25%) — distance from VWAP/Bollinger midline, RSI extremes
  - Volume (25%) — RVOL strength, volume Z-score confirmation
  - Trend (25%) — EMA stack alignment, price position in trend structure

Scores ≥ 60 are actionable. Scores ≥ 80 are high-conviction.
Requires a running TWS or IB Gateway connection for live data.
`.trim();

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SignalScorerSchema = z.object({
    ticker: z
        .string()
        .describe("US equity ticker symbol, e.g. 'AAPL'."),
    direction: z
        .enum(['long', 'short'])
        .describe("Trade direction to evaluate: 'long' or 'short'."),
    barSize: z
        .string()
        .default('5 mins')
        .describe("Bar size for TA computation: '5 mins', '15 mins', '1 hour', '1 day'. Defaults to '5 mins'."),
    useRTH: z
        .boolean()
        .default(true)
        .describe('Regular Trading Hours only. Defaults to true.'),
});

// ---------------------------------------------------------------------------
// Bar size → duration (enough for 200-period indicators)
// ---------------------------------------------------------------------------

const BAR_SIZE_MAP: Record<string, BarSizeSetting> = {
    '1 min': BarSizeSetting.MINUTES_ONE,
    '5 mins': BarSizeSetting.MINUTES_FIVE,
    '15 mins': BarSizeSetting.MINUTES_FIFTEEN,
    '30 mins': BarSizeSetting.MINUTES_THIRTY,
    '1 hour': BarSizeSetting.HOURS_ONE,
    '1 day': BarSizeSetting.DAYS_ONE,
};

const DURATION_FOR_BAR: Record<string, string> = {
    '1 min': '2 D',
    '5 mins': '10 D',
    '15 mins': '1 M',
    '30 mins': '2 M',
    '1 hour': '6 M',
    '1 day': '2 Y',
};

// ---------------------------------------------------------------------------
// Data fetching (same pattern as technical-analysis.ts)
// ---------------------------------------------------------------------------

export async function fetchBars(
    ticker: string,
    barSize: BarSizeSetting,
    duration: string,
    useRTH: boolean,
): Promise<Bar[]> {
    const api = await getIBApi();
    const reqId = allocReqId();

    const contract: Contract = {
        symbol: ticker,
        secType: SecType.STK,
        exchange: 'SMART',
        currency: 'USD',
    };

    const bars: Bar[] = [];

    return new Promise<Bar[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve(bars);
        }, 30_000);

        const onHistoricalData = (
            id: number,
            time: string,
            open: number,
            high: number,
            low: number,
            close: number,
            volume: number,
            count: number | undefined,
            WAP: number,
            _hasGaps?: boolean | undefined,
        ) => {
            if (id !== reqId) return;
            if (typeof time === 'string' && time.startsWith('finished')) {
                clearTimeout(timeout);
                cleanup();
                resolve(bars);
                return;
            }
            bars.push({ time, open, high, low, close, volume, count, WAP });
        };

        const onError = (err: Error, code: number, id: number) => {
            if (id !== reqId) return;
            if (isNonFatalIbkrError(code)) return;
            clearTimeout(timeout);
            cleanup();
            reject(new Error(`[SignalScorer] Historical data error ${code}: ${err.message}`));
        };

        function cleanup() {
            api.off(EventName.historicalData, onHistoricalData);
            api.off(EventName.error, onError);
        }

        api.on(EventName.historicalData, onHistoricalData);
        api.on(EventName.error, onError);

        api.reqHistoricalData(
            reqId,
            contract,
            '',
            duration,
            barSize,
            WhatToShow.TRADES,
            useRTH ? 1 : 0,
            1,
            false,
        );
    });
}

function barsToOHLCV(bars: Bar[]): OHLCV {
    return {
        time: bars.map((b) => b.time ?? ''),
        open: bars.map((b) => b.open ?? 0),
        high: bars.map((b) => b.high ?? 0),
        low: bars.map((b) => b.low ?? 0),
        close: bars.map((b) => b.close ?? 0),
        volume: bars.map((b) => b.volume ?? 0),
    };
}

// ---------------------------------------------------------------------------
// Scoring functions
// ---------------------------------------------------------------------------

/** Get last valid (non-NaN) value from array. */
function lastValid(arr: number[]): number {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (!isNaN(arr[i])) return arr[i];
    }
    return NaN;
}

/** Get the Nth-from-last valid value. offset=0 → last, offset=1 → second-to-last, etc. */
function nthLast(arr: number[], offset: number): number {
    let found = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (!isNaN(arr[i])) {
            if (found === offset) return arr[i];
            found++;
        }
    }
    return NaN;
}

/** Clamp a value to [0, 100]. */
function clamp100(v: number): number {
    return Math.max(0, Math.min(100, v));
}

interface FactorScore {
    score: number;      // 0–100
    components: Record<string, { value: number | null; contribution: number; note: string }>;
}

/**
 * Momentum factor (25% of total):
 *   - MACD histogram direction (is it accelerating in our direction?)
 *   - RSI level and direction
 *   - Price vs key EMAs (9, 21, 50)
 */
function scoreMomentum(ind: AllIndicators, close: number[], direction: 'long' | 'short'): FactorScore {
    const isLong = direction === 'long';
    const components: FactorScore['components'] = {};
    let total = 0;

    // --- MACD histogram slope (0–35 pts) ---
    const histNow = lastValid(ind.macd.histogram);
    const histPrev = nthLast(ind.macd.histogram, 1);
    let macdScore = 0;
    let macdNote = '';
    if (!isNaN(histNow) && !isNaN(histPrev)) {
        const slope = histNow - histPrev;
        const favorable = isLong ? slope > 0 : slope < 0;
        const magnitude = Math.abs(slope);
        // Positive & in-direction = full score; positive & against = penalize
        if (favorable) {
            macdScore = Math.min(35, 15 + magnitude * 500); // scale small values up
        } else {
            macdScore = Math.max(0, 15 - magnitude * 500);
        }
        macdNote = `histogram ${histNow > 0 ? '+' : ''}${histNow.toFixed(4)}, slope ${slope > 0 ? '+' : ''}${slope.toFixed(4)}`;
    } else {
        macdScore = 15; // neutral if no data
        macdNote = 'insufficient data';
    }
    macdScore = clamp100(macdScore);
    components['macd_slope'] = { value: histNow || null, contribution: macdScore, note: macdNote };
    total += macdScore;

    // --- RSI direction (0–30 pts) ---
    const rsiNow = lastValid(ind.rsi.rsi);
    const rsiPrev = nthLast(ind.rsi.rsi, 1);
    let rsiScore = 0;
    let rsiNote = '';
    if (!isNaN(rsiNow)) {
        const rsiSlope = !isNaN(rsiPrev) ? rsiNow - rsiPrev : 0;
        if (isLong) {
            // Long: RSI 40–65 with rising slope is ideal; >70 = overextended
            if (rsiNow >= 40 && rsiNow <= 65) rsiScore = 20;
            else if (rsiNow > 65 && rsiNow <= 75) rsiScore = 10;
            else if (rsiNow > 75) rsiScore = 0; // overextended
            else if (rsiNow >= 30 && rsiNow < 40) rsiScore = 15; // oversold bounce potential
            else rsiScore = 5;
            if (rsiSlope > 0) rsiScore = Math.min(30, rsiScore + 10);
        } else {
            // Short: RSI 35–60 with falling slope is ideal; <30 = oversold
            if (rsiNow >= 35 && rsiNow <= 60) rsiScore = 20;
            else if (rsiNow > 60 && rsiNow <= 70) rsiScore = 15; // overbought fade
            else if (rsiNow > 70) rsiScore = 20; // overbought = good for short
            else if (rsiNow < 30) rsiScore = 0; // oversold, bad for short
            else rsiScore = 5;
            if (rsiSlope < 0) rsiScore = Math.min(30, rsiScore + 10);
        }
        rsiNote = `RSI ${rsiNow.toFixed(1)}, slope ${rsiSlope > 0 ? '+' : ''}${rsiSlope.toFixed(1)}`;
    } else {
        rsiScore = 15;
        rsiNote = 'insufficient data';
    }
    components['rsi_direction'] = { value: rsiNow || null, contribution: rsiScore, note: rsiNote };
    total += rsiScore;

    // --- Price vs EMAs (0–35 pts) ---
    const price = close[close.length - 1];
    const e9 = lastValid(ind.ema9);
    const e21 = lastValid(ind.ema21);
    const e50 = lastValid(ind.ema50);
    let emaScore = 0;
    let emaNote = '';
    if (!isNaN(price) && !isNaN(e9) && !isNaN(e21)) {
        const aboveE9 = price > e9;
        const aboveE21 = price > e21;
        const aboveE50 = !isNaN(e50) && price > e50;

        if (isLong) {
            if (aboveE9) emaScore += 12;
            if (aboveE21) emaScore += 12;
            if (aboveE50) emaScore += 11;
        } else {
            if (!aboveE9) emaScore += 12;
            if (!aboveE21) emaScore += 12;
            if (!aboveE50) emaScore += 11;
        }
        const positions = [
            aboveE9 ? '> EMA9' : '< EMA9',
            aboveE21 ? '> EMA21' : '< EMA21',
            !isNaN(e50) ? (aboveE50 ? '> EMA50' : '< EMA50') : '',
        ].filter(Boolean);
        emaNote = positions.join(', ');
    } else {
        emaScore = 15;
        emaNote = 'insufficient EMA data';
    }
    components['price_vs_emas'] = { value: price || null, contribution: emaScore, note: emaNote };
    total += emaScore;

    return { score: clamp100(total), components };
}

/**
 * Mean reversion factor (25% of total):
 *   - Distance from VWAP (for intraday)
 *   - Bollinger %B (distance from midline)
 *   - RSI extremes (oversold for long, overbought for short)
 */
function scoreMeanReversion(ind: AllIndicators, close: number[], direction: 'long' | 'short'): FactorScore {
    const isLong = direction === 'long';
    const components: FactorScore['components'] = {};
    let total = 0;

    const price = close[close.length - 1];

    // --- VWAP distance (0–35 pts) ---
    const vwapVal = lastValid(ind.vwap.vwap);
    let vwapScore = 0;
    let vwapNote = '';
    if (!isNaN(vwapVal) && !isNaN(price) && vwapVal > 0) {
        const pctFromVwap = ((price - vwapVal) / vwapVal) * 100;
        if (isLong) {
            // Long mean-reversion: price below VWAP is favorable
            if (pctFromVwap < -1) vwapScore = 35;       // > 1% below = strong reversion signal
            else if (pctFromVwap < -0.3) vwapScore = 25; // slightly below
            else if (pctFromVwap < 0.3) vwapScore = 15;  // near VWAP — neutral
            else if (pctFromVwap < 1) vwapScore = 8;     // slightly above — weak
            else vwapScore = 0;                           // far above — no reversion
        } else {
            if (pctFromVwap > 1) vwapScore = 35;
            else if (pctFromVwap > 0.3) vwapScore = 25;
            else if (pctFromVwap > -0.3) vwapScore = 15;
            else if (pctFromVwap > -1) vwapScore = 8;
            else vwapScore = 0;
        }
        vwapNote = `${pctFromVwap > 0 ? '+' : ''}${pctFromVwap.toFixed(2)}% from VWAP`;
    } else {
        vwapScore = 15;
        vwapNote = 'VWAP not available';
    }
    components['vwap_distance'] = { value: vwapVal || null, contribution: vwapScore, note: vwapNote };
    total += vwapScore;

    // --- Bollinger %B (0–35 pts) ---
    const pctB = lastValid(ind.bollinger.percentB);
    let bbScore = 0;
    let bbNote = '';
    if (!isNaN(pctB)) {
        if (isLong) {
            // Long reversion: %B < 0.2 is oversold (near lower band)
            if (pctB < 0.1) bbScore = 35;
            else if (pctB < 0.25) bbScore = 28;
            else if (pctB < 0.4) bbScore = 18;
            else if (pctB < 0.6) bbScore = 10;
            else bbScore = 0; // near upper band — no long reversion
        } else {
            if (pctB > 0.9) bbScore = 35;
            else if (pctB > 0.75) bbScore = 28;
            else if (pctB > 0.6) bbScore = 18;
            else if (pctB > 0.4) bbScore = 10;
            else bbScore = 0;
        }
        bbNote = `%B = ${pctB.toFixed(3)}`;
    } else {
        bbScore = 15;
        bbNote = 'insufficient data';
    }
    components['bollinger_pctb'] = { value: pctB || null, contribution: bbScore, note: bbNote };
    total += bbScore;

    // --- RSI extreme (0–30 pts) ---
    const rsiVal = lastValid(ind.rsi.rsi);
    let rsiExtScore = 0;
    let rsiExtNote = '';
    if (!isNaN(rsiVal)) {
        if (isLong) {
            if (rsiVal < 25) rsiExtScore = 30;
            else if (rsiVal < 35) rsiExtScore = 22;
            else if (rsiVal < 45) rsiExtScore = 12;
            else rsiExtScore = 0;
        } else {
            if (rsiVal > 75) rsiExtScore = 30;
            else if (rsiVal > 65) rsiExtScore = 22;
            else if (rsiVal > 55) rsiExtScore = 12;
            else rsiExtScore = 0;
        }
        rsiExtNote = `RSI ${rsiVal.toFixed(1)} — ${rsiVal < 30 ? 'oversold' : rsiVal > 70 ? 'overbought' : 'neutral'}`;
    } else {
        rsiExtScore = 15;
        rsiExtNote = 'no data';
    }
    components['rsi_extreme'] = { value: rsiVal || null, contribution: rsiExtScore, note: rsiExtNote };
    total += rsiExtScore;

    return { score: clamp100(total), components };
}

/**
 * Volume confirmation factor (25% of total):
 *   - RVOL (relative volume vs 20-bar average)
 *   - Volume Z-score (statistical significance)
 *   - Volume trend (are recent bars showing increasing volume?)
 */
function scoreVolume(ind: AllIndicators, volumes: number[]): FactorScore {
    const components: FactorScore['components'] = {};
    let total = 0;

    // --- RVOL (0–40 pts) ---
    const rvolVal = lastValid(ind.volume.rvol);
    let rvolScore = 0;
    let rvolNote = '';
    if (!isNaN(rvolVal)) {
        if (rvolVal >= 3.0) rvolScore = 40;
        else if (rvolVal >= 2.0) rvolScore = 35;
        else if (rvolVal >= 1.5) rvolScore = 28;
        else if (rvolVal >= 1.0) rvolScore = 18;
        else if (rvolVal >= 0.7) rvolScore = 8;
        else rvolScore = 0; // very low volume — no conviction
        rvolNote = `RVOL = ${rvolVal.toFixed(2)}×`;
    } else {
        rvolScore = 15;
        rvolNote = 'no volume data';
    }
    components['rvol'] = { value: rvolVal || null, contribution: rvolScore, note: rvolNote };
    total += rvolScore;

    // --- Z-score (0–30 pts) ---
    const zVal = lastValid(ind.volume.zScore);
    let zScore = 0;
    let zNote = '';
    if (!isNaN(zVal)) {
        if (zVal >= 2.5) zScore = 30;
        else if (zVal >= 1.5) zScore = 22;
        else if (zVal >= 0.5) zScore = 12;
        else if (zVal >= 0) zScore = 5;
        else zScore = 0; // below average
        zNote = `Z-score = ${zVal.toFixed(2)}`;
    } else {
        zScore = 10;
        zNote = 'no data';
    }
    components['volume_zscore'] = { value: zVal || null, contribution: zScore, note: zNote };
    total += zScore;

    // --- Volume trend (last 5 bars increasing?) (0–30 pts) ---
    const n = volumes.length;
    let trendScore = 0;
    let trendNote = '';
    if (n >= 5) {
        const recent5 = volumes.slice(-5);
        let increasing = 0;
        for (let i = 1; i < recent5.length; i++) {
            if (recent5[i] > recent5[i - 1]) increasing++;
        }
        trendScore = Math.round((increasing / 4) * 30);
        trendNote = `${increasing}/4 bars with increasing volume`;
    } else {
        trendScore = 10;
        trendNote = 'insufficient bars';
    }
    components['volume_trend'] = { value: null, contribution: trendScore, note: trendNote };
    total += trendScore;

    return { score: clamp100(total), components };
}

/**
 * Trend alignment factor (25% of total):
 *   - EMA stack (9 > 21 > 50 > 200 for bullish)
 *   - Price in trend structure (higher highs/lows or lower highs/lows)
 *   - ATR context (volatility environment)
 */
function scoreTrend(ind: AllIndicators, ohlcv: OHLCV, direction: 'long' | 'short'): FactorScore {
    const isLong = direction === 'long';
    const components: FactorScore['components'] = {};
    let total = 0;

    // --- EMA stack alignment (0–45 pts) ---
    const e9 = lastValid(ind.ema9);
    const e21 = lastValid(ind.ema21);
    const e50 = lastValid(ind.ema50);
    const e200 = lastValid(ind.ema200);
    let stackScore = 0;
    let stackNote = '';
    const emas = [
        { label: 'EMA9', val: e9 },
        { label: 'EMA21', val: e21 },
        { label: 'EMA50', val: e50 },
        { label: 'EMA200', val: e200 },
    ].filter((e) => !isNaN(e.val));

    if (emas.length >= 3) {
        let orderedPairs = 0;
        const totalPairs = emas.length - 1;
        for (let i = 0; i < totalPairs; i++) {
            const above = emas[i].val > emas[i + 1].val;
            if (isLong ? above : !above) orderedPairs++;
        }
        stackScore = Math.round((orderedPairs / totalPairs) * 45);
        const order = emas.map((e) => `${e.label}(${e.val.toFixed(2)})`).join(isLong ? ' > ' : ' < ');
        stackNote = `${orderedPairs}/${totalPairs} pairs aligned: ${order}`;
    } else {
        stackScore = 20;
        stackNote = 'insufficient EMA data';
    }
    components['ema_stack'] = { value: null, contribution: stackScore, note: stackNote };
    total += stackScore;

    // --- Price structure: higher highs/lows or lower highs/lows (0–30 pts) ---
    const n = ohlcv.high.length;
    let structScore = 0;
    let structNote = '';
    if (n >= 10) {
        // Compare last 5 bar highs/lows to previous 5
        const recentHighs = ohlcv.high.slice(-5);
        const priorHighs = ohlcv.high.slice(-10, -5);
        const recentLows = ohlcv.low.slice(-5);
        const priorLows = ohlcv.low.slice(-10, -5);

        const maxRecentH = Math.max(...recentHighs);
        const maxPriorH = Math.max(...priorHighs);
        const minRecentL = Math.min(...recentLows);
        const minPriorL = Math.min(...priorLows);

        const higherHigh = maxRecentH > maxPriorH;
        const higherLow = minRecentL > minPriorL;
        const lowerHigh = maxRecentH < maxPriorH;
        const lowerLow = minRecentL < minPriorL;

        if (isLong) {
            if (higherHigh && higherLow) { structScore = 30; structNote = 'higher highs & higher lows'; }
            else if (higherHigh || higherLow) { structScore = 18; structNote = higherHigh ? 'higher highs' : 'higher lows'; }
            else if (lowerHigh && lowerLow) { structScore = 0; structNote = 'lower highs & lower lows (downtrend)'; }
            else { structScore = 10; structNote = 'mixed structure'; }
        } else {
            if (lowerHigh && lowerLow) { structScore = 30; structNote = 'lower highs & lower lows'; }
            else if (lowerHigh || lowerLow) { structScore = 18; structNote = lowerHigh ? 'lower highs' : 'lower lows'; }
            else if (higherHigh && higherLow) { structScore = 0; structNote = 'higher highs & higher lows (uptrend)'; }
            else { structScore = 10; structNote = 'mixed structure'; }
        }
    } else {
        structScore = 10;
        structNote = 'insufficient bars for structure';
    }
    components['price_structure'] = { value: null, contribution: structScore, note: structNote };
    total += structScore;

    // --- ATR context: moderate volatility is ideal (0–25 pts) ---
    const atrVal = lastValid(ind.atr.atr);
    let atrScore = 0;
    let atrNote = '';
    if (!isNaN(atrVal) && !isNaN(e21) && e21 > 0) {
        const atrPct = (atrVal / e21) * 100; // ATR as % of price
        // Moderate ATR (1–4% of price) = healthy volatility for trading
        if (atrPct >= 1 && atrPct <= 4) { atrScore = 25; atrNote = `ATR ${atrPct.toFixed(2)}% — ideal range`; }
        else if (atrPct > 4 && atrPct <= 7) { atrScore = 15; atrNote = `ATR ${atrPct.toFixed(2)}% — elevated`; }
        else if (atrPct > 7) { atrScore = 5; atrNote = `ATR ${atrPct.toFixed(2)}% — very high volatility`; }
        else { atrScore = 10; atrNote = `ATR ${atrPct.toFixed(2)}% — low volatility`; }
    } else {
        atrScore = 12;
        atrNote = 'no ATR data';
    }
    components['atr_context'] = { value: atrVal || null, contribution: atrScore, note: atrNote };
    total += atrScore;

    return { score: clamp100(total), components };
}

// ---------------------------------------------------------------------------
// Composite score
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bar freshness — deterministic staleness detection
// ---------------------------------------------------------------------------
// Live incident (2026-08-05): after IB Gateway's noon auto-restart the
// historical farm woke lazily and served bars ending at YESTERDAY'S close
// during pre-market; the live snapshot disagreed with the indicators. The
// model happened to notice — this makes the check deterministic so no
// consumer has to.

export interface BarFreshness {
    /** Raw IBKR time of the newest bar, e.g. '20260805 07:40:00'. */
    lastBarTime: string | null;
    /** Minutes since the newest bar (ET frame); null for daily bars or
     *  unparseable times. */
    lastBarAgeMin: number | null;
    /** True when new bars SHOULD exist (US extended session, Mon–Fri
     *  04:00–20:00 ET) and the newest bar is older than the threshold. */
    stale: boolean;
    /** Present only when stale — written for the consuming model. */
    staleNote?: string;
}

const STALE_AFTER_MIN = 15;

/** Assess how fresh the newest bar is. Pure; `now` injectable for tests.
 *  Bar times are interpreted in America/New_York (US equities). */
export function assessBarFreshness(lastBarTime: string | undefined, now: Date = new Date()): BarFreshness {
    const raw = (lastBarTime ?? '').trim();
    const m = /^(\d{4})(\d{2})(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/.exec(raw);
    if (!m) return { lastBarTime: raw || null, lastBarAgeMin: null, stale: false };
    if (m[4] === undefined) {
        // Daily bar — freshness is a different question (previous session
        // close is legitimate); leave to the daily-context consumers.
        return { lastBarTime: raw, lastBarAgeMin: null, stale: false };
    }

    // Compare bar and clock in the same fictional UTC frame built from ET
    // components — correct across DST without offset arithmetic.
    const barMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const nowMs = Date.UTC(et.getFullYear(), et.getMonth(), et.getDate(), et.getHours(), et.getMinutes(), et.getSeconds());
    const ageMin = Math.round((nowMs - barMs) / 60_000);

    const day = et.getDay();
    const hour = et.getHours();
    const expectFresh = day >= 1 && day <= 5 && hour >= 4 && hour < 20;
    const stale = expectFresh && ageMin > STALE_AFTER_MIN;

    return {
        lastBarTime: raw,
        lastBarAgeMin: ageMin,
        stale,
        ...(stale ? {
            staleNote:
                `STALE DATA: newest bar is ${ageMin} min old (${raw} ET) while the market session is active — ` +
                `the historical feed is lagging (typical right after an IB Gateway restart). Do NOT size a trade ` +
                `from these indicators; retry in a minute and cross-check against a live quote`,
        } : {}),
    };
}

export interface SignalResult {
    ticker: string;
    direction: 'long' | 'short';
    barSize: string;
    compositeScore: number;
    rating: string;
    factors: {
        momentum: { score: number; weight: number; weighted: number; components: FactorScore['components'] };
        meanReversion: { score: number; weight: number; weighted: number; components: FactorScore['components'] };
        volume: { score: number; weight: number; weighted: number; components: FactorScore['components'] };
        trend: { score: number; weight: number; weighted: number; components: FactorScore['components'] };
    };
    snapshot: {
        price: number | null;
        rsi: number | null;
        macdHistogram: number | null;
        vwap: number | null;
        atr: number | null;
        rvol: number | null;
    };
    /** Deterministic staleness assessment of the newest bar. */
    freshness: BarFreshness;
}

export function computeSignalScore(
    ticker: string,
    direction: 'long' | 'short',
    barSize: string,
    indicators: AllIndicators,
    ohlcv: OHLCV,
    weights?: FactorWeights,
): SignalResult {
    const w = weights ? normalizeWeights(weights) : getActiveWeights();
    const mom = scoreMomentum(indicators, ohlcv.close, direction);
    const mr = scoreMeanReversion(indicators, ohlcv.close, direction);
    const vol = scoreVolume(indicators, ohlcv.volume);
    const trend = scoreTrend(indicators, ohlcv, direction);

    const composite = Math.round(
        mom.score * w.momentum + mr.score * w.meanReversion + vol.score * w.volume + trend.score * w.trend,
    );

    let rating: string;
    if (composite >= 80) rating = 'strong';
    else if (composite >= 60) rating = 'actionable';
    else if (composite >= 40) rating = 'neutral';
    else rating = 'weak';

    const n = ohlcv.close.length;

    return {
        ticker,
        direction,
        barSize,
        compositeScore: composite,
        rating,
        factors: {
            momentum: { score: mom.score, weight: w.momentum, weighted: Math.round(mom.score * w.momentum), components: mom.components },
            meanReversion: { score: mr.score, weight: w.meanReversion, weighted: Math.round(mr.score * w.meanReversion), components: mr.components },
            volume: { score: vol.score, weight: w.volume, weighted: Math.round(vol.score * w.volume), components: vol.components },
            trend: { score: trend.score, weight: w.trend, weighted: Math.round(trend.score * w.trend), components: trend.components },
        },
        freshness: assessBarFreshness(n > 0 ? ohlcv.time[n - 1] : undefined),
        snapshot: {
            price: n > 0 ? ohlcv.close[n - 1] : null,
            rsi: (() => { const v = lastValid(indicators.rsi.rsi); return isNaN(v) ? null : Math.round(v * 100) / 100; })(),
            macdHistogram: (() => { const v = lastValid(indicators.macd.histogram); return isNaN(v) ? null : Math.round(v * 1e4) / 1e4; })(),
            vwap: (() => { const v = lastValid(indicators.vwap.vwap); return isNaN(v) ? null : Math.round(v * 100) / 100; })(),
            atr: (() => { const v = lastValid(indicators.atr.atr); return isNaN(v) ? null : Math.round(v * 100) / 100; })(),
            rvol: (() => { const v = lastValid(indicators.volume.rvol); return isNaN(v) ? null : Math.round(v * 100) / 100; })(),
        },
    };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createSignalScorer() {
    return new DynamicStructuredTool({
        name: 'signal_scorer',
        description:
            'Score a trade signal (0–100) for a US equity. Evaluates momentum, mean-reversion, volume confirmation, and trend alignment for a given direction (long/short). Scores ≥ 60 are actionable.',
        schema: SignalScorerSchema,
        func: async (input) => {
            const ticker = input.ticker.trim().toUpperCase();
            const barSizeLabel = input.barSize;

            const barSize = BAR_SIZE_MAP[barSizeLabel];
            if (!barSize) {
                return formatToolResult({
                    error: `Invalid barSize '${barSizeLabel}'. Valid: ${Object.keys(BAR_SIZE_MAP).join(', ')}`,
                });
            }

            const duration = DURATION_FOR_BAR[barSizeLabel];

            const bars = await fetchBars(ticker, barSize, duration, input.useRTH);

            if (bars.length === 0) {
                return formatToolResult({ error: `No bars returned for ${ticker}` });
            }

            const ohlcv = barsToOHLCV(bars);
            const indicators = computeAll(ohlcv);
            const result = computeSignalScore(ticker, input.direction, barSizeLabel, indicators, ohlcv);

            return formatToolResult(result);
        },
    });
}
