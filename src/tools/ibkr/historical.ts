/**
 * IBKR historical data tool — fetch historical OHLCV bars from TWS/IB Gateway.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Bar } from '@stoqey/ib';
import { BarSizeSetting, Contract, EventName, SecType, WhatToShow } from '@stoqey/ib';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { allocReqId, getIBApi } from './connection.js';

export const IBKR_HISTORICAL_DESCRIPTION = `
Fetches historical OHLCV bar data from Interactive Brokers for a given ticker.
Supports bar sizes from 1 second to 1 month and various duration strings (e.g. "1 D", "1 W", "1 M", "1 Y").
Requires a running TWS or IB Gateway connection.
`.trim();

/** Map of user-friendly bar-size strings to BarSizeSetting enum values. */
const BAR_SIZE_MAP: Record<string, BarSizeSetting> = {
    '1 secs': BarSizeSetting.SECONDS_ONE,
    '5 secs': BarSizeSetting.SECONDS_FIVE,
    '10 secs': BarSizeSetting.SECONDS_TEN,
    '15 secs': BarSizeSetting.SECONDS_FIFTEEN,
    '30 secs': BarSizeSetting.SECONDS_THIRTY,
    '1 min': BarSizeSetting.MINUTES_ONE,
    '2 mins': BarSizeSetting.MINUTES_TWO,
    '3 mins': BarSizeSetting.MINUTES_THREE,
    '5 mins': BarSizeSetting.MINUTES_FIVE,
    '10 mins': BarSizeSetting.MINUTES_TEN,
    '15 mins': BarSizeSetting.MINUTES_FIFTEEN,
    '20 mins': BarSizeSetting.MINUTES_TWENTY,
    '30 mins': BarSizeSetting.MINUTES_THIRTY,
    '1 hour': BarSizeSetting.HOURS_ONE,
    '2 hours': BarSizeSetting.HOURS_TWO,
    '3 hours': BarSizeSetting.HOURS_THREE,
    '4 hours': BarSizeSetting.HOURS_FOUR,
    '8 hours': BarSizeSetting.HOURS_EIGHT,
    '1 day': BarSizeSetting.DAYS_ONE,
    '1 week': BarSizeSetting.WEEKS_ONE,
    '1 month': BarSizeSetting.MONTHS_ONE,
};

const IbkrHistoricalSchema = z.object({
    ticker: z
        .string()
        .describe("US equity ticker symbol, e.g. 'AAPL'."),
    duration: z
        .string()
        .default('1 D')
        .describe("Duration string, e.g. '1 D' (1 day), '5 D', '1 W', '1 M', '1 Y'. Defaults to '1 D'."),
    barSize: z
        .string()
        .default('5 mins')
        .describe("Bar size, e.g. '1 min', '5 mins', '1 hour', '1 day'. Defaults to '5 mins'."),
    whatToShow: z
        .enum(['TRADES', 'MIDPOINT', 'BID', 'ASK', 'BID_ASK', 'ADJUSTED_LAST'])
        .default('TRADES')
        .describe("Data type. Defaults to 'TRADES'."),
    useRTH: z
        .boolean()
        .default(true)
        .describe('Use Regular Trading Hours only. Defaults to true.'),
    endDateTime: z
        .string()
        .optional()
        .describe("End date/time in 'YYYYMMDD HH:mm:ss' format. Omit for current time."),
    exchange: z
        .string()
        .default('SMART')
        .describe("Exchange routing. Defaults to 'SMART'."),
    currency: z
        .string()
        .default('USD')
        .describe("Currency. Defaults to 'USD'."),
});

export function createIbkrHistorical() {
    return new DynamicStructuredTool({
        name: 'ibkr_historical',
        description:
            'Fetch historical OHLCV bars from Interactive Brokers. Supports 1-second to 1-month bars with flexible duration and RTH filtering.',
        schema: IbkrHistoricalSchema,
        func: async (input) => {
            const api = await getIBApi();
            const reqId = allocReqId();
            const ticker = input.ticker.trim().toUpperCase();

            const contract: Contract = {
                symbol: ticker,
                secType: SecType.STK,
                exchange: input.exchange,
                currency: input.currency,
            };

            const barSize = BAR_SIZE_MAP[input.barSize];
            if (!barSize) {
                return formatToolResult({
                    error: `Invalid barSize '${input.barSize}'. Valid: ${Object.keys(BAR_SIZE_MAP).join(', ')}`,
                });
            }

            const bars: Bar[] = [];

            return new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    cleanup();
                    resolve(
                        formatToolResult({
                            ticker,
                            barSize: input.barSize,
                            duration: input.duration,
                            barCount: bars.length,
                            bars,
                            partial: true,
                        }),
                    );
                }, 30_000);

                // Each bar arrives as a historicalData event.
                // The final event has time starting with "finished-" to signal completion.
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
                        resolve(
                            formatToolResult({
                                ticker,
                                barSize: input.barSize,
                                duration: input.duration,
                                whatToShow: input.whatToShow,
                                useRTH: input.useRTH,
                                barCount: bars.length,
                                bars,
                            }),
                        );
                        return;
                    }
                    bars.push({ time, open, high, low, close, volume, count, WAP });
                };

                const onError = (err: Error, code: number, id: number) => {
                    if (id !== reqId) return;
                    clearTimeout(timeout);
                    cleanup();
                    reject(new Error(`[IBKR] Historical data error ${code}: ${err.message}`));
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
                    input.endDateTime || '',
                    input.duration,
                    barSize,
                    input.whatToShow as WhatToShow,
                    input.useRTH ? 1 : 0,
                    1, // formatDate: 1 = yyyyMMdd HH:mm:ss
                    false, // keepUpToDate
                );
            });
        },
    });
}
