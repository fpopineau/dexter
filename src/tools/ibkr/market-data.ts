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
import { allocReqId, getIBApi } from './connection.js';

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
} as const;

const tickLabel: Record<number, string> = {
    [TICK.BID]: 'bid',
    [TICK.ASK]: 'ask',
    [TICK.LAST]: 'last',
    [TICK.HIGH]: 'high',
    [TICK.LOW]: 'low',
    [TICK.VOLUME]: 'volume',
    [TICK.CLOSE]: 'prevClose',
    [TICK.OPEN]: 'open',
};

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

            const snapshot: Record<string, number> = { ticker: 0 };
            delete snapshot.ticker; // just to initialize as empty typed record

            return new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    api.cancelMktData(reqId);
                    cleanup();
                    // Return whatever we collected so far rather than failing
                    resolve(
                        formatToolResult({ ticker, ...snapshot, partial: true }),
                    );
                }, 8_000);

                const onTickPrice = (
                    id: number,
                    field: TickType,
                    value: number,
                    _attribs?: unknown,
                ) => {
                    if (id !== reqId) return;
                    const label = tickLabel[field as number];
                    if (label) snapshot[label] = value;
                };

                const onTickSize = (
                    id: number,
                    field?: TickType,
                    value?: number,
                ) => {
                    if (id !== reqId) return;
                    if ((field as number) === TICK.VOLUME && value !== undefined) snapshot.volume = value;
                };

                const onTickSnapshotEnd = (id: number) => {
                    if (id !== reqId) return;
                    clearTimeout(timeout);
                    cleanup();
                    resolve(formatToolResult({ ticker, ...snapshot }));
                };

                const onError = (err: Error, code: number, id: number) => {
                    if (id !== reqId) return;
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
