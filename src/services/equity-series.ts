/**
 * Equity series (REQ-VAL-006, review 2026-08-23) — a persisted, marked
 * NetLiq time series the validation scorecard judges PORTFOLIO drawdown
 * from.
 *
 * The closed-trade equity curve (realized P&L accumulated in close order)
 * misses everything that happens while positions are open: unrealized
 * troughs, correlated open exposure, overnight gaps that later recover.
 * A portfolio can breach its drawdown limit intraday and the close-order
 * curve never shows it. The verdict criterion therefore reads this series
 * — peak-to-trough of MARKED equity — and the closed-trade curve stays an
 * informational diagnostic.
 *
 * Sampling: every 15 minutes while the gateway runs (RTH or not — the
 * overnight mark IS the gap), plus a sample shortly after boot. Each line
 * is `{ts, netLiq}` (USD, FX-converted by the daily-loss guard). A NetLiq
 * the broker cannot report is skipped, never faked. Append-only JSONL in
 * DEXTER_DATA_DIR/equity-series.jsonl; the scorecard filters by window.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/utils';
import { parseEquitySeries, type EquitySample } from '@/utils/equity-series-math.js';
import { getNetLiquidation } from './daily-loss-guard.js';

export { parseEquitySeries, portfolioDrawdown, etDayOf, type EquitySample, type PortfolioDrawdown } from '@/utils/equity-series-math.js';

// 5 minutes (review 2026-08-23: 15-min sampling left 3× the gap the
// coverage criterion tolerates; the account-summary call is cheap).
const SAMPLE_INTERVAL_MS = 5 * 60_000;
const BOOT_DELAY_MS = 30_000;

export function equitySeriesPath(): string {
    return join(process.env.DEXTER_DATA_DIR || join('.dexter', 'data'), 'equity-series.jsonl');
}

export function readEquitySeries(): EquitySample[] {
    try {
        return parseEquitySeries(readFileSync(equitySeriesPath(), 'utf-8'));
    } catch {
        return [];
    }
}

/** One sample. Exported for the boot path and tests. */
export async function sampleEquityOnce(): Promise<EquitySample | null> {
    const netLiq = await getNetLiquidation().catch(() => null);
    if (netLiq === null || !(netLiq > 0)) {
        logger.warn('[equity-series] NetLiq unavailable — sample skipped (never faked)');
        return null;
    }
    const sample: EquitySample = { ts: Date.now(), netLiq };
    try {
        appendFileSync(equitySeriesPath(), `${JSON.stringify(sample)}\n`);
    } catch (err) {
        logger.warn(`[equity-series] append failed: ${err}`);
        return null;
    }
    return sample;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the sampler (idempotent). */
export function startEquitySeries(): void {
    if (timer) return;
    timer = setInterval(() => {
        sampleEquityOnce().catch((err) => logger.warn(`[equity-series] sample failed: ${err}`));
    }, SAMPLE_INTERVAL_MS);
    if (process.env.NODE_ENV !== 'test') {
        setTimeout(() => {
            sampleEquityOnce().catch((err) => logger.warn(`[equity-series] boot sample failed: ${err}`));
        }, BOOT_DELAY_MS);
    }
    logger.info(`[equity-series] started: marked NetLiq every ${SAMPLE_INTERVAL_MS / 60_000}min → ${equitySeriesPath()} (portfolio-drawdown criterion, VALIDATION-PROTOCOL.md)`);
}

export function stopEquitySeries(): void {
    if (timer) { clearInterval(timer); timer = null; }
}
