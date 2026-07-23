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
import { logger } from '@/utils';

export interface DailyRiskContext {
    /** Daily ATR(14), USD. */
    dailyAtr: number | null;
    /** EMA(10) of daily closes — the short-term mean for the extension check. */
    ema10: number | null;
}

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { value: DailyRiskContext; at: number }>();

const NONE: DailyRiskContext = { dailyAtr: null, ema10: null };

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

    let value: DailyRiskContext = NONE;
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
        value = {
            dailyAtr: lastValid(atr(highs, lows, closes, 14).atr),
            ema10: lastValid(ema(closes, 10)),
        };
    } catch (err) {
        logger.warn(`[daily-risk-context] ${sym}: ${err instanceof Error ? err.message : String(err)} — ATR/extension checks skipped`);
    }
    cache.set(sym, { value, at: Date.now() });
    return value;
}
