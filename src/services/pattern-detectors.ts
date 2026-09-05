/**
 * Swing pattern detectors — pure functions over daily OHLCV bars.
 *
 * Stage 3 of the custom scanner plan: these consume the daily history the
 * nightly universe sweep archives and surface multi-day setups the intraday
 * IBKR scanners cannot see. All three patterns are ENTRY-DISCIPLINED by
 * construction — they trigger on pullbacks, tight bases, and handle pivots,
 * not on extended vertical moves (the first live week's failure mode).
 *
 * Deterministic, tunable via the constants below, no I/O — unit-tested on
 * synthetic fixtures.
 */

import { atr, ema } from '@/tools/ibkr/ta-indicators.js';

export interface DailyBar {
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export type PatternName = 'pullback-in-uptrend' | 'flat-base' | 'cup-and-handle';

/** REQ-LANE-005: the detector heuristics are versioned — a lane cohort
 *  records which version produced its setups. */
export const DETECTOR_VERSION = 'v1';

/** Where the setup stands relative to its pivot at the last close:
 *  'pivot-ready' (below the pivot, waiting for the trigger) or
 *  'breakout-confirmed' (closed at/above the pivot within the detector's
 *  extension ceiling). 'retest' needs breakout history the archive does not
 *  keep yet (WP7). */
export type PatternState = 'pivot-ready' | 'breakout-confirmed';

export interface PatternMatch {
    pattern: PatternName;
    detectorVersion: string;
    state: PatternState;
    /** 0–100, deterministic quality score (base 60 + measured qualities). */
    score: number;
    /** The breakout/resumption level the setup pivots on. */
    pivot: number;
    /** Suggested STP_LMT trigger (just above the pivot/prior-day high). */
    suggestedEntry: number;
    /** Suggested stop at the setup's structure low. */
    suggestedStop: number;
    /** One line of measured evidence. */
    note: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const last = <T>(xs: T[]): T => xs[xs.length - 1];

// ---------------------------------------------------------------------------
// Pullback-in-uptrend: established uptrend, orderly 3–12% pullback toward
// the 20-day EMA on contracting volume. Entry on resumption above the prior
// day's high; stop under the pullback low.
// ---------------------------------------------------------------------------

const PB_MIN_BARS = 60;
const PB_MIN_TREND_GAIN = 0.25;   // 25%+ off the 120d low into the recent high
const PB_DEPTH_MIN = 0.03;
const PB_DEPTH_MAX = 0.12;
const PB_EMA_PROXIMITY = 0.03;    // low within 3% of the 20-day EMA

export function detectPullbackInUptrend(bars: DailyBar[]): PatternMatch | null {
    if (bars.length < PB_MIN_BARS) return null;
    const closes = bars.map((b) => b.close);
    const vols = bars.map((b) => b.volume);
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const c = last(closes);
    const e20 = last(ema20);
    const e50 = last(ema50);
    const e50Prev = ema50[ema50.length - 11];
    if ([e20, e50, e50Prev].some((v) => isNaN(v))) return null;

    // Trend: price above a rising 50-day EMA, 20 above 50.
    if (!(c > e50 && e20 > e50 && e50 > e50Prev)) return null;

    // Prior gain: recent high vs the 120-day low.
    const look = bars.slice(-120);
    const hi20 = Math.max(...bars.slice(-20).map((b) => b.high));
    const lo120 = Math.min(...look.map((b) => b.low));
    const gain = (hi20 - lo120) / lo120;
    if (gain < PB_MIN_TREND_GAIN) return null;

    // Orderly pullback from the 20-day high, near the 20-day EMA.
    const depth = (hi20 - c) / hi20;
    if (depth < PB_DEPTH_MIN || depth > PB_DEPTH_MAX) return null;
    const lowRecent = Math.min(...bars.slice(-5).map((b) => b.low));
    if (lowRecent > e20 * (1 + PB_EMA_PROXIMITY)) return null;

    // Volume contraction into the pullback.
    const vPull = avg(vols.slice(-5));
    const vPrior = avg(vols.slice(-20, -5));
    const contraction = vPrior > 0 ? vPull / vPrior : 1;

    let score = 60;
    if (depth >= 0.04 && depth <= 0.08) score += 10;          // sweet-spot depth
    if (contraction < 0.85) score += 15;                       // real dry-up
    else if (contraction < 1) score += 7;
    if (gain >= 0.5) score += 10;                              // strong prior trend

    const entry = r2(last(bars).high * 1.002);
    const stop = r2(lowRecent * 0.995);
    return {
        pattern: 'pullback-in-uptrend',
        detectorVersion: DETECTOR_VERSION,
        state: last(bars).close >= hi20 ? 'breakout-confirmed' : 'pivot-ready',
        score: Math.min(95, score),
        pivot: r2(hi20),
        suggestedEntry: entry,
        suggestedStop: stop,
        note: `+${Math.round(gain * 100)}% trend, ${(depth * 100).toFixed(1)}% pullback to EMA20, ` +
            `pullback volume ${Math.round(contraction * 100)}% of prior`,
    };
}

// ---------------------------------------------------------------------------
// Flat base: a 20–35 day tight range (≤10%) after a prior advance, price
// holding near the top of the base on contracting volume. Entry above the
// base high; stop at the base low.
// ---------------------------------------------------------------------------

const FB_MIN_BARS = 90;
const FB_LEN_MIN = 20;
const FB_LEN_MAX = 35;
const FB_MIN_RANGE = 0.02;   // a real base still breathes — 0% range is dead tape
const FB_MAX_RANGE = 0.10;
const FB_NEAR_HIGH = 0.05;
const FB_PRIOR_GAIN = 0.25;

export function detectFlatBase(bars: DailyBar[]): PatternMatch | null {
    if (bars.length < FB_MIN_BARS) return null;

    // Find the tightest qualifying base length.
    let best: { len: number; range: number; hi: number; lo: number } | null = null;
    for (let len = FB_LEN_MIN; len <= FB_LEN_MAX; len++) {
        const base = bars.slice(-len);
        const hi = Math.max(...base.map((b) => b.high));
        const lo = Math.min(...base.map((b) => b.low));
        const range = (hi - lo) / hi;
        if (range >= FB_MIN_RANGE && range <= FB_MAX_RANGE && (!best || range < best.range)) best = { len, range, hi, lo };
    }
    if (!best) return null;

    const c = last(bars).close;
    if ((best.hi - c) / best.hi > FB_NEAR_HIGH) return null; // sagging in the base

    // Prior advance into the base.
    const before = bars.slice(-(best.len + 60), -best.len);
    if (before.length < 30) return null;
    const loBefore = Math.min(...before.map((b) => b.low));
    const gain = (best.hi - loBefore) / loBefore;
    if (gain < FB_PRIOR_GAIN) return null;

    // Volume contraction inside the base — but zero volume is a halted or
    // bad-data tape, not a quiet base.
    const vBase = avg(bars.slice(-best.len).map((b) => b.volume));
    const vBefore = avg(before.map((b) => b.volume));
    if (vBase <= 0 || vBefore <= 0) return null;
    const contraction = vBase / vBefore;

    let score = 60;
    if (best.range <= 0.06) score += 15;                       // very tight
    else if (best.range <= 0.08) score += 8;
    if (contraction < 0.8) score += 12;
    if (gain >= 0.5) score += 8;

    return {
        pattern: 'flat-base',
        detectorVersion: DETECTOR_VERSION,
        state: last(bars).close >= best.hi ? 'breakout-confirmed' : 'pivot-ready',
        score: Math.min(95, score),
        pivot: r2(best.hi),
        suggestedEntry: r2(best.hi * 1.002),
        suggestedStop: r2(best.lo * 0.995),
        note: `${best.len}d base, ${(best.range * 100).toFixed(1)}% range after +${Math.round(gain * 100)}% advance, ` +
            `base volume ${Math.round(contraction * 100)}% of prior`,
    };
}

// ---------------------------------------------------------------------------
// Cup-and-handle: left rim → rounded 12–35% correction → recovery to a
// right rim near the left → short handle drifting in the upper half.
// Entry above the handle high; stop under the handle low.
// ---------------------------------------------------------------------------

const CH_MIN_BARS = 120;
const CH_DEPTH_MIN = 0.12;
const CH_DEPTH_MAX = 0.35;
const CH_CUP_MIN_LEN = 30;
const CH_RIM_TOLERANCE = 0.10;    // rims within 10% of each other
const CH_HANDLE_MIN = 4;
const CH_HANDLE_MAX = 20;
const CH_HANDLE_MAX_DEPTH = 0.12;
const CH_NEAR_PIVOT = 0.08;       // close within 8% below the pivot

export function detectCupAndHandle(bars: DailyBar[]): PatternMatch | null {
    if (bars.length < CH_MIN_BARS) return null;
    const n = bars.length;

    // Right rim: the high of the last ~30 bars, excluding the last few
    // (those form the handle).
    let iR = -1, rimR = -Infinity;
    for (let i = n - 30; i < n - CH_HANDLE_MIN; i++) {
        if (bars[i].high >= rimR) { rimR = bars[i].high; iR = i; }
    }
    if (iR < 0) return null;

    // Handle: everything after the right rim — short, shallow, upper half.
    const handle = bars.slice(iR + 1);
    if (handle.length < CH_HANDLE_MIN || handle.length > CH_HANDLE_MAX) return null;
    // The PIVOT is the handle high fixed BEFORE the last bar (review
    // 2026-09-06, finding 14): a close can never exceed its own bar's high,
    // so a pivot that included the last bar made 'breakout-confirmed'
    // unreachable. The last bar is the one that may confirm the breakout.
    const pivotBars = handle.length > CH_HANDLE_MIN ? handle.slice(0, -1) : handle;
    const handleHigh = Math.max(...pivotBars.map((b) => b.high));
    const handleLow = Math.min(...handle.map((b) => b.low));
    const handleDepth = (rimR - handleLow) / rimR;
    if (handleDepth > CH_HANDLE_MAX_DEPTH) return null;
    const c = last(bars).close;
    if ((rimR - c) / rimR > CH_NEAR_PIVOT) return null;   // fell away from the pivot
    if (c > rimR * 1.02) return null;                     // already broken out

    // Left rim: the high before the cup, within 10% of the right rim.
    const searchFrom = Math.max(0, iR - 150);
    let iL = -1, rimL = -Infinity;
    for (let i = searchFrom; i <= iR - CH_CUP_MIN_LEN; i++) {
        if (bars[i].high >= rimL) { rimL = bars[i].high; iL = i; }
    }
    if (iL < 0) return null;
    if (Math.abs(rimL - rimR) / rimR > CH_RIM_TOLERANCE) return null;

    // Cup bottom: depth in range, roughly centered (U, not V at the edge).
    const cup = bars.slice(iL, iR + 1);
    let iBot = 0, bot = Infinity;
    for (let i = 0; i < cup.length; i++) {
        if (cup[i].low < bot) { bot = cup[i].low; iBot = i; }
    }
    const rimHi = Math.max(rimL, rimR);
    const depth = (rimHi - bot) / rimHi;
    if (depth < CH_DEPTH_MIN || depth > CH_DEPTH_MAX) return null;
    const pos = iBot / cup.length;
    if (pos < 0.2 || pos > 0.8) return null;

    // Handle must hold the upper half of the cup.
    if (handleLow < rimHi - (rimHi - bot) / 2) return null;

    // Volume dry-up in the handle vs the cup.
    const vHandle = avg(handle.map((b) => b.volume));
    const vCup = avg(cup.map((b) => b.volume));
    const contraction = vCup > 0 ? vHandle / vCup : 1;

    let score = 65;
    if (depth >= 0.15 && depth <= 0.30) score += 10;           // classic depth
    if (Math.abs(rimL - rimR) / rimR <= 0.05) score += 8;      // symmetric rims
    if (contraction < 0.8) score += 12;
    if (handleDepth <= 0.08) score += 5;

    return {
        pattern: 'cup-and-handle',
        detectorVersion: DETECTOR_VERSION,
        // Confirmed = the last CLOSE is at/above the pivot fixed before it
        // (and under the 2 % extension ceiling checked above).
        state: c >= handleHigh ? 'breakout-confirmed' : 'pivot-ready',
        score: Math.min(98, score),
        pivot: r2(handleHigh),
        suggestedEntry: r2(handleHigh * 1.002),
        suggestedStop: r2(handleLow * 0.995),
        note: `${cup.length}d cup ${(depth * 100).toFixed(0)}% deep, ${handle.length}d handle ` +
            `(${(handleDepth * 100).toFixed(1)}% depth), handle volume ${Math.round(contraction * 100)}% of cup`,
    };
}

// ---------------------------------------------------------------------------

/** Run every detector; strongest matches first. */
export function detectPatterns(bars: DailyBar[]): PatternMatch[] {
    return [detectPullbackInUptrend(bars), detectFlatBase(bars), detectCupAndHandle(bars)]
        .filter((m): m is PatternMatch => m !== null)
        .sort((a, b) => b.score - a.score);
}

/** Daily ATR(14) from the same bars — for sizing hints in scan output. */
export function dailyAtrOf(bars: DailyBar[]): number | null {
    const series = atr(bars.map((b) => b.high), bars.map((b) => b.low), bars.map((b) => b.close), 14).atr;
    for (let i = series.length - 1; i >= 0; i--) if (!isNaN(series[i])) return r2(series[i]);
    return null;
}
