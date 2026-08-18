/**
 * Entry context — the market state at proposal creation, persisted so the
 * entry-quality question stops being folklore (2026-08-18 entry audit:
 * 72/79 executed entries were limits at the current quote, median 47s to
 * fill, 12% wins — every one proposed AFTER the move that discovered it).
 *
 * Four numbers, captured server-side at creation and written onto the
 * proposal row: how extended the market was (× daily ATR beyond EMA10),
 * how far from session VWAP, how big the day's move already was, and how
 * long after the open. All signed IN THE TRADE'S DIRECTION (positive =
 * the market had already gone the way of the trade — the chase side), so
 * outcome-vs-context analysis is one query with no direction split.
 *
 * Fail-open by design: any missing input leaves its field null — honest
 * gaps, never guesses. Nothing here gates; these columns exist so the
 * NEXT calibration of the gates is set from evidence.
 */

import { BarSizeSetting } from '@stoqey/ib';
import { fetchBars } from '@/tools/ibkr/signal-scorer.js';
import { logger } from '@/utils';

export interface EntryContext {
    /** (ref − ema10) / dailyAtr, signed in the trade direction — the
     *  extension-guard measure, persisted instead of discarded. */
    extensionAtr: number | null;
    /** Distance from session VWAP, % of VWAP, signed in the trade
     *  direction (positive = the chase side of VWAP). */
    vwapDistPct: number | null;
    /** Day move at proposal time vs the prior session close, %, signed in
     *  the trade direction (positive = the move had already happened). */
    dayMovePct: number | null;
    /** Minutes since 09:30 ET (negative = pre-market). */
    minutesSinceOpen: number | null;
}

const NONE: EntryContext = { extensionAtr: null, vwapDistPct: null, dayMovePct: null, minutesSinceOpen: null };

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Pure assembly of the context from whatever inputs are in hand.
 * `ref` is the market reference price — the live last when available,
 * else the proposed entry (documented approximation).
 */
export function buildEntryContext(input: {
    direction: 'long' | 'short';
    ref: number;
    dailyAtr?: number | null;
    ema10?: number | null;
    prevClose?: number | null;
    vwap?: number | null;
    minutesSinceOpen?: number | null;
}): EntryContext {
    const { direction, ref } = input;
    if (!(ref > 0)) return { ...NONE, minutesSinceOpen: input.minutesSinceOpen ?? null };
    const sign = direction === 'long' ? 1 : -1;
    const extensionAtr =
        input.dailyAtr != null && input.dailyAtr > 0 && input.ema10 != null && input.ema10 > 0
            ? r2((sign * (ref - input.ema10)) / input.dailyAtr)
            : null;
    const vwapDistPct =
        input.vwap != null && input.vwap > 0
            ? r2((sign * (ref - input.vwap)) / input.vwap * 100)
            : null;
    const dayMovePct =
        input.prevClose != null && input.prevClose > 0
            ? r2((sign * (ref - input.prevClose)) / input.prevClose * 100)
            : null;
    return { extensionAtr, vwapDistPct, dayMovePct, minutesSinceOpen: input.minutesSinceOpen ?? null };
}

/** Minutes since 09:30 ET (negative pre-market). Pure; `now` injectable. */
export function minutesSinceOpenEt(now: Date = new Date()): number {
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return et.getHours() * 60 + et.getMinutes() - (9 * 60 + 30);
}

/**
 * Session VWAP from intraday bars: Σ(WAP × volume) / Σ(volume), with the
 * bar's typical price (H+L+C)/3 standing in when WAP is missing. Null when
 * no bar carries volume — never a price guess.
 */
export function sessionVwapFromBars(
    bars: Array<{ WAP?: number; high?: number; low?: number; close?: number; volume?: number }>,
): number | null {
    let pv = 0;
    let vol = 0;
    for (const b of bars) {
        if (typeof b.volume !== 'number' || !(b.volume > 0)) continue;
        const price = typeof b.WAP === 'number' && b.WAP > 0
            ? b.WAP
            : (typeof b.high === 'number' && typeof b.low === 'number' && typeof b.close === 'number'
                && b.high > 0 && b.low > 0 && b.close > 0
                ? (b.high + b.low + b.close) / 3
                : null);
        if (price === null) continue;
        pv += price * b.volume;
        vol += b.volume;
    }
    return vol > 0 ? Math.round((pv / vol) * 10000) / 10000 : null;
}

/**
 * Today's session VWAP for a symbol, from 1-min RTH bars. Only meaningful
 * once the session is open — pre-market returns null rather than passing
 * off yesterday's VWAP as today's. Fail-open on any data problem.
 */
export async function fetchSessionVwap(symbol: string): Promise<number | null> {
    if (process.env.NODE_ENV === 'test') return null;
    if (minutesSinceOpenEt() < 0) return null;
    try {
        const bars = await Promise.race([
            fetchBars(symbol.toUpperCase(), BarSizeSetting.MINUTES_ONE, '1 D', true),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('timeout after 6s')), 6_000)),
        ]);
        // Guard against a stale feed handing back yesterday's session.
        const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const todayEt = `${et.getFullYear()}${String(et.getMonth() + 1).padStart(2, '0')}${String(et.getDate()).padStart(2, '0')}`;
        return sessionVwapFromBars(bars.filter((b) => (b.time ?? '').slice(0, 8) === todayEt));
    } catch (err) {
        logger.warn(`[entry-context] ${symbol}: VWAP unavailable (${err instanceof Error ? err.message : String(err)})`);
        return null;
    }
}
