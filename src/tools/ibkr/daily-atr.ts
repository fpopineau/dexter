/**
 * Daily ATR(14) lookup for the proposal risk gate's noise-stop check.
 *
 * Fetched server-side so the value can't be gamed by the model proposing
 * the trade. Fail-open: a data problem returns null and the gate simply
 * skips the ATR check — the hard checks (coherence, R/R, sizing) still run.
 */

import { BarSizeSetting } from '@stoqey/ib';
import { atr } from './ta-indicators.js';
import { fetchBars } from './signal-scorer.js';
import { logger } from '@/utils';

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { value: number | null; at: number }>();

export async function fetchDailyAtr(symbol: string): Promise<number | null> {
    // Unit tests run without a Gateway — never let them (or a dead
    // connection) block proposal creation.
    if (process.env.NODE_ENV === 'test') return null;

    const sym = symbol.toUpperCase();
    const hit = cache.get(sym);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

    let value: number | null = null;
    try {
        const bars = await Promise.race([
            fetchBars(sym, BarSizeSetting.DAYS_ONE, '2 M', true),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('timeout after 8s')), 8_000)),
        ]);
        const highs = bars.map((b) => b.high ?? NaN);
        const lows = bars.map((b) => b.low ?? NaN);
        const closes = bars.map((b) => b.close ?? NaN);
        const series = atr(highs, lows, closes, 14).atr;
        for (let i = series.length - 1; i >= 0; i--) {
            if (!isNaN(series[i])) { value = Math.round(series[i] * 100) / 100; break; }
        }
    } catch (err) {
        logger.warn(`[daily-atr] ${sym}: ${err instanceof Error ? err.message : String(err)} — ATR check skipped`);
    }
    cache.set(sym, { value, at: Date.now() });
    return value;
}
