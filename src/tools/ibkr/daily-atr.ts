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
        const highs = bars.map((b) => b.high ?? NaN);
        const lows = bars.map((b) => b.low ?? NaN);
        const closes = bars.map((b) => b.close ?? NaN);
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
