/**
 * Opportunities tool — exposes the Opportunity Engine's ranked snapshot
 * to the agent. Read-only and advisory: never places orders.
 *
 * Actions:
 *   latest  — return the most recent snapshot (fast, no market calls)
 *   refresh — run a full scan→score→rank cycle now, then return it
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
    engineStatus,
    getLatestSnapshot,
    runCycleOnce,
    type Opportunity,
    type OpportunitySnapshot,
} from '@/services/opportunity-engine.js';
import { formatToolResult } from '../types.js';

export const OPPORTUNITIES_DESCRIPTION = `
Ranked trading opportunities from the continuous market scanner (Opportunity Engine).

Actions:
  **latest** (default) — return the most recent ranked snapshot. Fast; no market requests.
  **refresh** — run a fresh scan+score cycle now (takes ~30-60s; respects IBKR pacing), then return it.

Each opportunity carries: symbol, direction (long/short), signalScore (0-100 multi-factor),
compositeRank (signal + RVOL bonus + multi-scanner presence), price, RVOL, ATR, RSI, VWAP,
and which scanners surfaced it. Entries are sorted by compositeRank descending.

Use 'latest' first; only 'refresh' if the snapshot is missing or stale (>15 min during market
hours). Snapshots taken while the market is closed carry marketOpen=false — treat their data
as stale context, not live signals. This tool is advisory and never places orders.
`.trim();

const OpportunitiesSchema = z.object({
    action: z
        .enum(['latest', 'refresh'])
        .default('latest')
        .describe("'latest' returns the cached snapshot; 'refresh' runs a new scan cycle (~30-60s)."),
    limit: z
        .number()
        .int()
        .positive()
        .max(25)
        .default(10)
        .describe('Maximum number of ranked opportunities to return. Defaults to 10.'),
});

function trim(snapshot: OpportunitySnapshot, limit: number) {
    return {
        timestamp: new Date(snapshot.timestamp).toISOString(),
        ageSeconds: Math.round((Date.now() - snapshot.timestamp) / 1000),
        phase: snapshot.phase,
        session: snapshot.sessionLabel,
        marketOpen: snapshot.marketOpen,
        scanned: snapshot.scanned,
        scored: snapshot.scored,
        opportunities: snapshot.opportunities.slice(0, limit).map((o: Opportunity, i: number) => ({
            rank: i + 1,
            symbol: o.symbol,
            name: o.longName,
            direction: o.direction,
            compositeRank: o.compositeRank,
            signalScore: o.signalScore,
            rating: o.rating,
            price: o.price,
            rvol: o.rvol,
            atr: o.atr,
            rsi: o.rsi,
            vwap: o.vwap,
            scanners: o.scanSources,
        })),
    };
}

export function createOpportunitiesTool() {
    return new DynamicStructuredTool({
        name: 'opportunities',
        description:
            'Ranked trading opportunities from the continuous market scanner. Action latest (cached) or refresh (new scan cycle, ~30-60s). Advisory only.',
        schema: OpportunitiesSchema,
        func: async (input) => {
            if (input.action === 'refresh') {
                const snapshot = await runCycleOnce();
                return formatToolResult(trim(snapshot, input.limit));
            }
            const snapshot = getLatestSnapshot();
            if (!snapshot) {
                const status = engineStatus();
                return formatToolResult({
                    error: 'No snapshot available yet.',
                    engine: status,
                    hint: status.running
                        ? 'The engine has not completed its first cycle. Retry shortly or call with action "refresh".'
                        : 'The Opportunity Engine is not running (it starts with the gateway). Call with action "refresh" to run one cycle now.',
                });
            }
            return formatToolResult(trim(snapshot, input.limit));
        },
    });
}
