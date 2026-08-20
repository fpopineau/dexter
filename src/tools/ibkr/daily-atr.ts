/**
 * Daily risk context (ATR(14) + EMA(10) of closes) for the proposal risk
 * gate's noise-stop and extension checks.
 *
 * Fetched server-side so the values can't be gamed by the model proposing
 * the trade. Fail-open: a data problem returns nulls and the gate simply
 * skips those checks — the hard checks (coherence, R/R, sizing) still run.
 */

import { BarSizeSetting } from '@stoqey/ib';
import { atr, ema } from './ta-indicators.js';
import { fetchBars } from './signal-scorer.js';
import { reportedRecently } from '@/services/earnings-calendar.js';
import { logger } from '@/utils';

export interface DailyRiskContext {
    /** Daily ATR(14), USD. */
    dailyAtr: number | null;
    /** EMA(10) of daily closes — the short-term mean for the extension check. */
    ema10: number | null;
    /** Reported earnings within the last session (earnings-gap exception
     *  for the extension guard). Null = could not verify → guard stays strict. */
    recentEarnings: boolean | null;
    /** Prior COMPLETED session's close — the day-move reference for the
     *  entry-context instrumentation (same completed-bars discipline as
     *  ATR: today's in-progress bar never references itself). */
    prevClose: number | null;
    /** 20-day average daily volume in SHARES (WP7 microstructure gate).
     *  LIVE-VERIFIED 2026-08-21 (scripts/verify-paper-prereqs.ts): this
     *  fetch path returns share-denominated daily volume — NO lot factor.
     *  The provisional ×100 read AAPL at 3.09B shares/day (100× its ~31M
     *  ADV), which would have let min_avg_volume pass almost anything. */
    avgDailyVolume20d: number | null;
}

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { value: DailyRiskContext; at: number }>();

const NONE: DailyRiskContext = { dailyAtr: null, ema10: null, recentEarnings: null, prevClose: null, avgDailyVolume20d: null };

function lastValid(series: number[]): number | null {
    for (let i = series.length - 1; i >= 0; i--) {
        if (!isNaN(series[i])) return Math.round(series[i] * 100) / 100;
    }
    return null;
}

export async function fetchDailyRiskContext(symbol: string): Promise<DailyRiskContext> {
    // Unit tests run without a Gateway — never let them (or a dead
    // connection) block proposal creation.
    if (process.env.NODE_ENV === 'test') return NONE;

    const sym = symbol.toUpperCase();
    const hit = cache.get(sym);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

    // Fresh object, never the shared NONE — recentEarnings is patched below.
    let value: DailyRiskContext = { ...NONE };
    try {
        const bars = await Promise.race([
            fetchBars(sym, BarSizeSetting.DAYS_ONE, '2 M', true),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('timeout after 8s')), 8_000)),
        ]);
        // COMPLETED bars only: on a gap day the in-progress bar's huge range
        // inflates ATR, which deflates measured extension — the gap grants
        // itself permission to be chased (observed live: MEDP +17% measured
        // 2.8× ATR with today's bar, 4.2× without). The reference regime is
        // yesterday's, not the event's.
        const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const todayEt = `${et.getFullYear()}${String(et.getMonth() + 1).padStart(2, '0')}${String(et.getDate()).padStart(2, '0')}`;
        const completed = bars.filter((b) => (b.time ?? '').slice(0, 8) !== todayEt);
        const highs = completed.map((b) => b.high ?? NaN);
        const lows = completed.map((b) => b.low ?? NaN);
        const closes = completed.map((b) => b.close ?? NaN);
        // 20-day mean of COMPLETED-session volumes, in shares (WP7 —
        // share-denominated as delivered, live-verified 2026-08-21).
        const volumes = completed.map((b) => b.volume ?? NaN).filter((v) => Number.isFinite(v) && v >= 0).slice(-20);
        const avgDailyVolume20d = volumes.length >= 10
            ? Math.round(volumes.reduce((s, v) => s + v, 0) / volumes.length)
            : null;
        value = {
            dailyAtr: lastValid(atr(highs, lows, closes, 14).atr),
            ema10: lastValid(ema(closes, 10)),
            recentEarnings: null,
            prevClose: lastValid(closes),
            avgDailyVolume20d,
        };
    } catch (err) {
        logger.warn(`[daily-risk-context] ${sym}: ${err instanceof Error ? err.message : String(err)} — ATR/extension checks skipped`);
    }

    // Earnings look-back for the extension guard's earnings-gap exception.
    // Own timeout, own failure mode: unavailable → null → the guard stays
    // strict. Usually a cache hit (6h per-day calendar cache).
    try {
        value.recentEarnings = await Promise.race([
            reportedRecently(sym),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 6_000)),
        ]);
    } catch {
        value.recentEarnings = null;
    }
    cache.set(sym, { value, at: Date.now() });
    return value;
}
