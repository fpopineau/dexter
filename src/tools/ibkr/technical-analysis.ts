/**
 * Technical Analysis tool — fetches historical bars from IBKR and computes
 * indicators, returning a structured snapshot the agent can reason about.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Bar } from '@stoqey/ib';
import { BarSizeSetting, Contract, EventName, SecType, WhatToShow } from '@stoqey/ib';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { allocReqId, getIBApi } from './connection.js';
import {
    type AllIndicators,
    type OHLCV,
    computeAll,
} from './ta-indicators.js';

export const TECHNICAL_ANALYSIS_DESCRIPTION = `
Compute technical indicators for a US equity ticker using live IBKR data.
Returns RSI, MACD (line/signal/histogram), Bollinger Bands, ATR, VWAP,
volume analysis (Z-score, RVOL), and EMAs (9/21/50/200) at the latest bar,
plus a compact recent-history window.
Requires a running TWS or IB Gateway connection.
`.trim();

const BAR_SIZE_MAP: Record<string, BarSizeSetting> = {
    '1 min': BarSizeSetting.MINUTES_ONE,
    '5 mins': BarSizeSetting.MINUTES_FIVE,
    '15 mins': BarSizeSetting.MINUTES_FIFTEEN,
    '30 mins': BarSizeSetting.MINUTES_THIRTY,
    '1 hour': BarSizeSetting.HOURS_ONE,
    '1 day': BarSizeSetting.DAYS_ONE,
};

/** Duration string that gives enough history for 200-period indicators at each bar size. */
const DURATION_FOR_BAR: Record<string, string> = {
    '1 min': '2 D',     // ~780 bars/day → 2 days ≈ 1560 bars
    '5 mins': '10 D',   // ~78 bars/day → 10 days ≈ 780 bars
    '15 mins': '1 M',   // ~26 bars/day → 1 month ≈ 550 bars
    '30 mins': '2 M',   // ~13 bars/day → 2 months ≈ 550 bars
    '1 hour': '6 M',    // ~7 bars/day → 6 months ≈ 900 bars
    '1 day': '2 Y',     // 1 bar/day → 2 years ≈ 500 bars
};

const TechnicalAnalysisSchema = z.object({
    ticker: z
        .string()
        .describe("US equity ticker symbol, e.g. 'AAPL'."),
    barSize: z
        .string()
        .default('5 mins')
        .describe("Bar size: '1 min', '5 mins', '15 mins', '30 mins', '1 hour', '1 day'. Defaults to '5 mins'."),
    useRTH: z
        .boolean()
        .default(true)
        .describe('Regular Trading Hours only. Defaults to true.'),
    exchange: z
        .string()
        .default('SMART')
        .describe("Exchange routing. Defaults to 'SMART'."),
    currency: z
        .string()
        .default('USD')
        .describe("Currency. Defaults to 'USD'."),
});

/** Fetch bars from IBKR (reuses the same event pattern as ibkr/historical.ts). */
async function fetchBars(
    ticker: string,
    barSize: BarSizeSetting,
    duration: string,
    useRTH: boolean,
    exchange: string,
    currency: string,
): Promise<Bar[]> {
    const api = await getIBApi();
    const reqId = allocReqId();

    const contract: Contract = {
        symbol: ticker,
        secType: SecType.STK,
        exchange,
        currency,
    };

    const bars: Bar[] = [];

    return new Promise<Bar[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve(bars); // partial is acceptable
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
            clearTimeout(timeout);
            cleanup();
            reject(new Error(`[TA] Historical data error ${code}: ${err.message}`));
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
            '',       // now
            duration,
            barSize,
            WhatToShow.TRADES,
            useRTH ? 1 : 0,
            1,        // formatDate
            false,    // keepUpToDate
        );
    });
}

/** Convert Bar[] to the OHLCV arrays our indicator library expects. */
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

/** Pick the last valid (non-NaN) value from an array. */
function last(arr: number[]): number | null {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (!isNaN(arr[i])) return Math.round(arr[i] * 1e4) / 1e4;
    }
    return null;
}

/** Build a compact snapshot of the latest indicator values. */
function buildSnapshot(ind: AllIndicators, ohlcv: OHLCV) {
    const n = ohlcv.close.length;
    const latestClose = n > 0 ? ohlcv.close[n - 1] : null;

    return {
        price: latestClose,
        rsi: last(ind.rsi.rsi),
        macd: {
            line: last(ind.macd.macd),
            signal: last(ind.macd.signal),
            histogram: last(ind.macd.histogram),
        },
        bollinger: {
            upper: last(ind.bollinger.upper),
            middle: last(ind.bollinger.middle),
            lower: last(ind.bollinger.lower),
            percentB: last(ind.bollinger.percentB),
            bandwidth: last(ind.bollinger.bandwidth),
        },
        atr: last(ind.atr.atr),
        vwap: last(ind.vwap.vwap),
        volume: {
            zScore: last(ind.volume.zScore),
            rvol: last(ind.volume.rvol),
        },
        emas: {
            ema9: last(ind.ema9),
            ema21: last(ind.ema21),
            ema50: last(ind.ema50),
            ema200: last(ind.ema200),
        },
        sma20: last(ind.sma20),
    };
}

/** Build a small recent-history table (last N bars) for trend context. */
function buildRecentHistory(ind: AllIndicators, ohlcv: OHLCV, count = 5) {
    const n = ohlcv.close.length;
    const start = Math.max(0, n - count);
    const rows = [];

    for (let i = start; i < n; i++) {
        rows.push({
            time: ohlcv.time[i],
            close: ohlcv.close[i],
            rsi: isNaN(ind.rsi.rsi[i]) ? null : Math.round(ind.rsi.rsi[i] * 100) / 100,
            macdHist: isNaN(ind.macd.histogram[i])
                ? null
                : Math.round(ind.macd.histogram[i] * 1e4) / 1e4,
            volume: ohlcv.volume[i],
        });
    }
    return rows;
}

export function createTechnicalAnalysis() {
    return new DynamicStructuredTool({
        name: 'technical_analysis',
        description:
            'Compute technical indicators (RSI, MACD, Bollinger, ATR, VWAP, EMAs, volume) for a US equity from live IBKR bar data. Returns latest snapshot plus recent history.',
        schema: TechnicalAnalysisSchema,
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

            const bars = await fetchBars(
                ticker,
                barSize,
                duration,
                input.useRTH,
                input.exchange,
                input.currency,
            );

            if (bars.length === 0) {
                return formatToolResult({ error: `No bars returned for ${ticker}` });
            }

            const ohlcv = barsToOHLCV(bars);
            const indicators = computeAll(ohlcv);

            return formatToolResult({
                ticker,
                barSize: barSizeLabel,
                barCount: bars.length,
                latestBar: ohlcv.time[ohlcv.time.length - 1],
                snapshot: buildSnapshot(indicators, ohlcv),
                recentHistory: buildRecentHistory(indicators, ohlcv),
            });
        },
    });
}
