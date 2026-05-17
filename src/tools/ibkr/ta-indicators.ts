/**
 * Pure-math technical indicator library.
 *
 * Each function takes a plain number[] (typically close prices or OHLCV arrays)
 * and returns computed indicator values. No external dependencies.
 *
 * Naming convention: functions return arrays aligned to the input — leading
 * entries are NaN where insufficient history exists.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple Moving Average over `period` values. Returns array same length as input. */
export function sma(data: number[], period: number): number[] {
    const result = new Array<number>(data.length).fill(NaN);
    if (data.length < period) return result;

    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i];
    result[period - 1] = sum / period;

    for (let i = period; i < data.length; i++) {
        sum += data[i] - data[i - period];
        result[i] = sum / period;
    }
    return result;
}

/** Exponential Moving Average. Uses SMA as seed for the first value. */
export function ema(data: number[], period: number): number[] {
    const result = new Array<number>(data.length).fill(NaN);
    if (data.length < period) return result;

    const k = 2 / (period + 1);
    // Seed with SMA
    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i];
    result[period - 1] = sum / period;

    for (let i = period; i < data.length; i++) {
        result[i] = data[i] * k + result[i - 1] * (1 - k);
    }
    return result;
}

// ---------------------------------------------------------------------------
// RSI
// ---------------------------------------------------------------------------

export interface RSIResult {
    rsi: number[];
}

/**
 * Relative Strength Index (Wilder smoothing).
 * Default period = 14.
 */
export function rsi(close: number[], period = 14): RSIResult {
    const result = new Array<number>(close.length).fill(NaN);
    if (close.length < period + 1) return { rsi: result };

    let avgGain = 0;
    let avgLoss = 0;

    // Initial average over first `period` changes
    for (let i = 1; i <= period; i++) {
        const delta = close[i] - close[i - 1];
        if (delta > 0) avgGain += delta;
        else avgLoss += Math.abs(delta);
    }
    avgGain /= period;
    avgLoss /= period;

    result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < close.length; i++) {
        const delta = close[i] - close[i - 1];
        const gain = delta > 0 ? delta : 0;
        const loss = delta < 0 ? Math.abs(delta) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

    return { rsi: result };
}

// ---------------------------------------------------------------------------
// MACD
// ---------------------------------------------------------------------------

export interface MACDResult {
    macd: number[];
    signal: number[];
    histogram: number[];
}

/**
 * MACD (Moving Average Convergence Divergence).
 * Default: fast=12, slow=26, signal=9.
 */
export function macd(
    close: number[],
    fastPeriod = 12,
    slowPeriod = 26,
    signalPeriod = 9,
): MACDResult {
    const fastEma = ema(close, fastPeriod);
    const slowEma = ema(close, slowPeriod);

    const macdLine = new Array<number>(close.length).fill(NaN);
    for (let i = 0; i < close.length; i++) {
        if (!isNaN(fastEma[i]) && !isNaN(slowEma[i])) {
            macdLine[i] = fastEma[i] - slowEma[i];
        }
    }

    // Signal line = EMA of MACD line (skip NaN prefix)
    const firstValid = macdLine.findIndex((v) => !isNaN(v));
    const macdValues = firstValid >= 0 ? macdLine.slice(firstValid) : [];
    const signalEma = ema(macdValues, signalPeriod);

    const signalLine = new Array<number>(close.length).fill(NaN);
    const histogram = new Array<number>(close.length).fill(NaN);

    for (let i = 0; i < signalEma.length; i++) {
        const idx = firstValid + i;
        signalLine[idx] = signalEma[i];
        if (!isNaN(macdLine[idx]) && !isNaN(signalEma[i])) {
            histogram[idx] = macdLine[idx] - signalEma[i];
        }
    }

    return { macd: macdLine, signal: signalLine, histogram };
}

// ---------------------------------------------------------------------------
// Bollinger Bands
// ---------------------------------------------------------------------------

export interface BollingerResult {
    upper: number[];
    middle: number[];
    lower: number[];
    bandwidth: number[];
    percentB: number[];
}

/**
 * Bollinger Bands. Default: period=20, stdDev=2.
 */
export function bollingerBands(
    close: number[],
    period = 20,
    stdDevMult = 2,
): BollingerResult {
    const middle = sma(close, period);
    const upper = new Array<number>(close.length).fill(NaN);
    const lower = new Array<number>(close.length).fill(NaN);
    const bandwidth = new Array<number>(close.length).fill(NaN);
    const percentB = new Array<number>(close.length).fill(NaN);

    for (let i = period - 1; i < close.length; i++) {
        const slice = close.slice(i - period + 1, i + 1);
        const mean = middle[i];
        const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
        const stdDev = Math.sqrt(variance);

        upper[i] = mean + stdDevMult * stdDev;
        lower[i] = mean - stdDevMult * stdDev;
        bandwidth[i] = stdDev > 0 ? (upper[i] - lower[i]) / mean : 0;
        percentB[i] = upper[i] !== lower[i] ? (close[i] - lower[i]) / (upper[i] - lower[i]) : 0.5;
    }

    return { upper, middle, lower, bandwidth, percentB };
}

// ---------------------------------------------------------------------------
// ATR (Average True Range)
// ---------------------------------------------------------------------------

export interface ATRResult {
    atr: number[];
}

/**
 * Average True Range (Wilder smoothing). Default period = 14.
 * Requires high[], low[], close[] of equal length.
 */
export function atr(
    high: number[],
    low: number[],
    close: number[],
    period = 14,
): ATRResult {
    const len = high.length;
    const result = new Array<number>(len).fill(NaN);
    if (len < period + 1) return { atr: result };

    const tr = new Array<number>(len).fill(0);
    tr[0] = high[0] - low[0];
    for (let i = 1; i < len; i++) {
        tr[i] = Math.max(
            high[i] - low[i],
            Math.abs(high[i] - close[i - 1]),
            Math.abs(low[i] - close[i - 1]),
        );
    }

    // Initial ATR = simple average of first `period` true ranges
    let sum = 0;
    for (let i = 0; i < period; i++) sum += tr[i];
    result[period - 1] = sum / period;

    // Wilder smoothing
    for (let i = period; i < len; i++) {
        result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
    }

    return { atr: result };
}

// ---------------------------------------------------------------------------
// VWAP (Volume-Weighted Average Price)
// ---------------------------------------------------------------------------

export interface VWAPResult {
    vwap: number[];
}

/**
 * VWAP — cumulative within the provided bar window.
 * Typically reset daily (caller provides one day of bars).
 */
export function vwap(
    high: number[],
    low: number[],
    close: number[],
    volume: number[],
): VWAPResult {
    const len = high.length;
    const result = new Array<number>(len).fill(NaN);

    let cumTP = 0;
    let cumVol = 0;
    for (let i = 0; i < len; i++) {
        const tp = (high[i] + low[i] + close[i]) / 3;
        cumTP += tp * volume[i];
        cumVol += volume[i];
        result[i] = cumVol > 0 ? cumTP / cumVol : NaN;
    }

    return { vwap: result };
}

// ---------------------------------------------------------------------------
// Volume Z-score & Relative Volume
// ---------------------------------------------------------------------------

export interface VolumeResult {
    zScore: number[];
    rvol: number[];
}

/**
 * Volume analysis: Z-score (current vol vs rolling mean/stddev) and
 * Relative Volume (current vs rolling average).
 * Default lookback = 20 bars.
 */
export function volumeAnalysis(volume: number[], lookback = 20): VolumeResult {
    const len = volume.length;
    const zScore = new Array<number>(len).fill(NaN);
    const rvol = new Array<number>(len).fill(NaN);

    for (let i = lookback - 1; i < len; i++) {
        const slice = volume.slice(i - lookback + 1, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / lookback;
        const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / lookback;
        const std = Math.sqrt(variance);

        rvol[i] = mean > 0 ? volume[i] / mean : NaN;
        zScore[i] = std > 0 ? (volume[i] - mean) / std : 0;
    }

    return { zScore, rvol };
}

// ---------------------------------------------------------------------------
// Convenience: compute all indicators at once
// ---------------------------------------------------------------------------

export interface OHLCV {
    time: string[];
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    volume: number[];
}

export interface AllIndicators {
    rsi: RSIResult;
    macd: MACDResult;
    bollinger: BollingerResult;
    atr: ATRResult;
    vwap: VWAPResult;
    volume: VolumeResult;
    ema9: number[];
    ema21: number[];
    ema50: number[];
    ema200: number[];
    sma20: number[];
}

/**
 * Compute all Phase-1 indicators from OHLCV data in one call.
 */
export function computeAll(data: OHLCV): AllIndicators {
    return {
        rsi: rsi(data.close),
        macd: macd(data.close),
        bollinger: bollingerBands(data.close),
        atr: atr(data.high, data.low, data.close),
        vwap: vwap(data.high, data.low, data.close, data.volume),
        volume: volumeAnalysis(data.volume),
        ema9: ema(data.close, 9),
        ema21: ema(data.close, 21),
        ema50: ema(data.close, 50),
        ema200: ema(data.close, 200),
        sma20: sma(data.close, 20),
    };
}
