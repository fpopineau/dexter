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

/** Session key from a bar time — works for both IBKR intraday
 *  ('yyyymmdd  HH:MM:SS') and ISO ('YYYY-MM-DD HH:MM:SS') formats. */
function sessionKey(time: string | undefined): string {
    return (time ?? '').replace(/[^0-9]/g, '').slice(0, 8);
}

/** Time-of-day key ('HH:MM') from a bar time, both formats. */
function todKey(time: string | undefined): string | null {
    const m = /(\d{2}):(\d{2})/.exec(time ?? '');
    return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * VWAP — cumulative, RESET AT EACH SESSION BOUNDARY when bar times are
 * provided (WP10, audit 2026-08-20: callers pass multi-day windows, and a
 * 10-day cumulative "VWAP" put trending names permanently far from their
 * anchor — the ±0.3%/±1% mean-reversion bands are calibrated for the
 * SESSION vwap). Without times, the old whole-window behavior remains
 * (single-session callers).
 */
export function vwap(
    high: number[],
    low: number[],
    close: number[],
    volume: number[],
    times?: string[],
): VWAPResult {
    const len = high.length;
    const result = new Array<number>(len).fill(NaN);

    let cumTP = 0;
    let cumVol = 0;
    let session = '';
    for (let i = 0; i < len; i++) {
        if (times) {
            const key = sessionKey(times[i]);
            if (key !== session) {
                session = key;
                cumTP = 0;
                cumVol = 0;
            }
        }
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
 * Volume analysis (WP10). Both measures compare the current bar against
 * PRIOR data only — the old windows included the bar under test, which
 * self-damped every burst (a true 3× bar read ~2.6×).
 *
 * RVOL: with bar times, current volume vs the mean of the SAME
 * time-of-day across prior sessions — the 09:35 bar is judged against
 * prior 09:35 bars, not the previous afternoon's dead tape (the audit's
 * core RVOL complaint: a rolling window confuses the normal intraday
 * volume curve with unusual volume). Without times, falls back to the
 * prior-`lookback`-bars mean.
 *
 * Z-score: current volume vs the prior `lookback` bars' mean/stddev.
 */
export function volumeAnalysis(volume: number[], lookback = 20, times?: string[]): VolumeResult {
    const len = volume.length;
    const zScore = new Array<number>(len).fill(NaN);
    const rvol = new Array<number>(len).fill(NaN);

    // Prior same-time-of-day volumes, accumulated as we scan forward.
    const byTod = new Map<string, number[]>();

    for (let i = 0; i < len; i++) {
        // Z-score from the PRIOR window (excludes bar i).
        if (i >= lookback) {
            const slice = volume.slice(i - lookback, i);
            const mean = slice.reduce((a, b) => a + b, 0) / lookback;
            const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / lookback;
            const std = Math.sqrt(variance);
            zScore[i] = std > 0 ? (volume[i] - mean) / std : 0;
            if (!times) rvol[i] = mean > 0 ? volume[i] / mean : NaN;
        }

        if (times) {
            const tod = todKey(times[i]);
            if (tod !== null) {
                const prior = byTod.get(tod);
                if (prior && prior.length >= 3) {
                    const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
                    rvol[i] = mean > 0 ? volume[i] / mean : NaN;
                }
                if (prior) prior.push(volume[i]);
                else byTod.set(tod, [volume[i]]);
            }
        }
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
        vwap: vwap(data.high, data.low, data.close, data.volume, data.time),
        volume: volumeAnalysis(data.volume, 20, data.time),
        ema9: ema(data.close, 9),
        ema21: ema(data.close, 21),
        ema50: ema(data.close, 50),
        ema200: ema(data.close, 200),
        sma20: sma(data.close, 20),
    };
}
