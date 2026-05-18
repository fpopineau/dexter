/**
 * IBKR market data tool — real-time snapshot quotes via TWS/IB Gateway.
 * Requests a market data snapshot for a given ticker and returns
 * bid/ask/last/open/high/low/close/volume.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import type { TickType } from '@stoqey/ib';
import { Contract, EventName, SecType } from '@stoqey/ib';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { allocReqId, getIBApi, isNonFatalIbkrError } from './connection.js';

export const IBKR_MARKET_DATA_DESCRIPTION = `
Fetches a real-time market data snapshot from Interactive Brokers for a US equity ticker.
Returns bid, ask, last price, open, high, low, previous close, and volume.
Requires a running TWS or IB Gateway connection.
`.trim();

/** TickType enum values we care about. */
const TICK = {
    BID: 1,
    ASK: 2,
    LAST: 4,
    HIGH: 6,
    LOW: 7,
    VOLUME: 8,
    CLOSE: 9,
    OPEN: 14,
    // Delayed equivalents (~15 min). IBKR sends these instead when
    // reqMarketDataType(3 or 4) is active.
    DELAYED_BID: 66,
    DELAYED_ASK: 67,
    DELAYED_LAST: 68,
    DELAYED_HIGH: 72,
    DELAYED_LOW: 73,
    DELAYED_VOLUME: 74,
    DELAYED_CLOSE: 75,
    DELAYED_OPEN: 76,
} as const;

// Map both live and delayed tick codes to the same labels so callers
// don't have to care which feed type is in use. The `delayed` flag in
// the result tells them whether the data is delayed.
const tickLabel: Record<number, string> = {
    [TICK.BID]: 'bid',
    [TICK.ASK]: 'ask',
    [TICK.LAST]: 'last',
    [TICK.HIGH]: 'high',
    [TICK.LOW]: 'low',
    [TICK.VOLUME]: 'volume',
    [TICK.CLOSE]: 'prevClose',
    [TICK.OPEN]: 'open',
    [TICK.DELAYED_BID]: 'bid',
    [TICK.DELAYED_ASK]: 'ask',
    [TICK.DELAYED_LAST]: 'last',
    [TICK.DELAYED_HIGH]: 'high',
    [TICK.DELAYED_LOW]: 'low',
    [TICK.DELAYED_VOLUME]: 'volume',
    [TICK.DELAYED_CLOSE]: 'prevClose',
    [TICK.DELAYED_OPEN]: 'open',
};

const DELAYED_TICK_CODES = new Set<number>([
    TICK.DELAYED_BID, TICK.DELAYED_ASK, TICK.DELAYED_LAST,
    TICK.DELAYED_HIGH, TICK.DELAYED_LOW, TICK.DELAYED_VOLUME,
    TICK.DELAYED_CLOSE, TICK.DELAYED_OPEN,
]);

const IbkrMarketDataSchema = z.object({
    ticker: z
        .string()
        .describe("US equity ticker symbol, e.g. 'AAPL'."),
    exchange: z
        .string()
        .default('SMART')
        .describe("Exchange routing. Defaults to 'SMART' (best execution)."),
    currency: z
        .string()
        .default('USD')
        .describe("Currency. Defaults to 'USD'."),
});

export function createIbkrMarketData() {
    return new DynamicStructuredTool({
        name: 'ibkr_market_data',
        description:
            'Fetch a real-time market data snapshot from Interactive Brokers for a US equity. Returns bid, ask, last, open, high, low, prevClose, and volume.',
        schema: IbkrMarketDataSchema,
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

            const snapshot: Record<string, number> = {};
            let delayed = false;

            return new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    api.cancelMktData(reqId);
                    cleanup();
                    // Return whatever we collected so far rather than failing
                    resolve(
                        formatToolResult({ ticker, delayed, ...snapshot, partial: true }),
                    );
                }, 8_000);

                const onTickPrice = (
                    id: number,
                    field: TickType,
                    value: number,
                    _attribs?: unknown,
                ) => {
                    if (id !== reqId) return;
                    if (value === -1) return; // IBKR sentinel for "no data"
                    const code = field as number;
                    const label = tickLabel[code];
                    if (label) snapshot[label] = value;
                    if (DELAYED_TICK_CODES.has(code)) delayed = true;
                };

                const onTickSize = (
                    id: number,
                    field?: TickType,
                    value?: number,
                ) => {
                    if (id !== reqId) return;
                    if (value === undefined) return;
                    const code = field as number;
                    if (code === TICK.VOLUME || code === TICK.DELAYED_VOLUME) {
                        snapshot.volume = value;
                        if (code === TICK.DELAYED_VOLUME) delayed = true;
                    }
                };

                const onTickSnapshotEnd = (id: number) => {
                    if (id !== reqId) return;
                    clearTimeout(timeout);
                    cleanup();
                    resolve(formatToolResult({ ticker, delayed, ...snapshot }));
                };

                const onError = (err: Error, code: number, id: number) => {
                    if (id !== reqId) return;
                    if (isNonFatalIbkrError(code)) return;
                    clearTimeout(timeout);
                    cleanup();
                    reject(new Error(`[IBKR] Market data error ${code}: ${err.message}`));
                };

                function cleanup() {
                    api.off(EventName.tickPrice, onTickPrice);
                    api.off(EventName.tickSize, onTickSize);
                    api.off(EventName.tickSnapshotEnd, onTickSnapshotEnd);
                    api.off(EventName.error, onError);
                }

                api.on(EventName.tickPrice, onTickPrice);
                api.on(EventName.tickSize, onTickSize);
                api.on(EventName.tickSnapshotEnd, onTickSnapshotEnd);
                api.on(EventName.error, onError);

                // Request snapshot (snapshot=true, regulatorySnapshot=false)
                api.reqMktData(reqId, contract, '', true, false);
            });
        },
    });
}
