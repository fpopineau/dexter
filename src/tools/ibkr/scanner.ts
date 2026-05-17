/**
 * IBKR Market Scanner tool — exposes IBKR's built-in market scanners
 * to the agent for finding top movers, volume leaders, gappers, etc.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { runScan, type ScanCode } from '../../services/scanner-loop.js';
import { formatToolResult } from '../types.js';

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

export const IBKR_SCANNER_DESCRIPTION = `
Run an IBKR market scanner to find stocks matching specific criteria.
Available scan types:
  - TOP_PERC_GAIN — biggest percentage gainers
  - TOP_PERC_LOSE — biggest percentage losers
  - MOST_ACTIVE — highest trading volume
  - HOT_BY_VOLUME — unusual volume (vs average)
  - HIGH_OPEN_GAP — stocks gapping up at open
  - LOW_OPEN_GAP — stocks gapping down at open
  - TOP_OPEN_PERC_GAIN — top gainers from open price
  - TOP_OPEN_PERC_LOSE — top losers from open price
  - TOP_TRADE_COUNT — most trades
  - TOP_TRADE_RATE — highest trade rate

Returns ranked results with symbol, company name, and scan metrics.
Requires a running TWS or IB Gateway connection.
Results are cached for 5 minutes to avoid redundant requests.
`.trim();

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ScannerSchema = z.object({
    scanCode: z
        .enum([
            'TOP_PERC_GAIN',
            'TOP_PERC_LOSE',
            'MOST_ACTIVE',
            'HOT_BY_VOLUME',
            'HIGH_OPEN_GAP',
            'LOW_OPEN_GAP',
            'TOP_OPEN_PERC_GAIN',
            'TOP_OPEN_PERC_LOSE',
            'TOP_TRADE_COUNT',
            'TOP_TRADE_RATE',
        ])
        .describe('The type of market scan to run.'),
    numberOfRows: z
        .number()
        .default(15)
        .describe('Number of results to return (max 50). Defaults to 15.'),
    minPrice: z
        .number()
        .default(5)
        .describe('Minimum stock price filter. Defaults to $5.'),
    minVolume: z
        .number()
        .default(100000)
        .describe('Minimum volume filter. Defaults to 100,000.'),
    minMarketCap: z
        .number()
        .default(500000000)
        .describe('Minimum market cap filter in USD. Defaults to $500M.'),
    locationCode: z
        .string()
        .default('STK.US.MAJOR')
        .describe("Market location. Defaults to 'STK.US.MAJOR'. Other options: 'STK.US', 'STK.NYSE', 'STK.NASDAQ'."),
});

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createIbkrScanner() {
    return new DynamicStructuredTool({
        name: 'ibkr_scanner',
        description:
            'Run an IBKR market scanner (top gainers, losers, most active, gappers, unusual volume). Returns ranked stock results.',
        schema: ScannerSchema,
        func: async (input) => {
            const results = await runScan(input.scanCode as ScanCode, {
                numberOfRows: Math.min(input.numberOfRows, 50),
                abovePrice: input.minPrice,
                aboveVolume: input.minVolume,
                marketCapAbove: input.minMarketCap,
                locationCode: input.locationCode,
            });

            if (results.length === 0) {
                return formatToolResult({
                    scanCode: input.scanCode,
                    message: 'No results matched the scan criteria.',
                    results: [],
                });
            }

            return formatToolResult({
                scanCode: input.scanCode,
                resultCount: results.length,
                results: results.map((r) => ({
                    rank: r.rank + 1, // 0-indexed from IBKR → 1-indexed for display
                    symbol: r.symbol,
                    name: r.longName,
                    exchange: r.exchange,
                    distance: r.distance,
                    benchmark: r.benchmark,
                    projection: r.projection,
                })),
            });
        },
    });
}
