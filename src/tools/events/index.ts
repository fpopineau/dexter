/**
 * Event-risk tool — dated macro binary events and per-symbol earnings
 * markets from Polymarket (keyless). The "prediction-markets as episodic
 * context" tool from the 2026-08-05 research memo: probabilities are
 * consumed by the judgment layer around event windows, never by the scorer.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { getEarningsMarketSignal, getMacroEventsWithin } from '@/services/event-risk.js';

export const EVENT_RISK_DESCRIPTION = `
Dated event risk from prediction markets (Polymarket, keyless).

**macro** — scheduled macro binaries (CPI, FOMC, jobs, GDP, central banks)
  resolving within N days, each with the market's top-probability outcome
  and an uncertainty grade (low = consensus priced; high = genuinely open).
  Use before any overnight keep or GTC proposal: a high-uncertainty CPI or
  FOMC print tomorrow is gap risk no stop can protect against — say so in
  the proposal's overnight rationale, or prefer exiting into the close.
  The EOD triage report carries the same warning automatically.

**earnings_market** — the symbol's open "beat quarterly earnings?" market,
  when one exists (coverage skews to liquid, newsy names). A live market
  with real volume is a valid EXTERNAL SIGNAL for the earnings-bet evidence
  bar, and its beatProbability is the market's read on the print. Null means
  no market — the signal is absent, not negative; verify externally instead.

Empty macro list = verified quiet horizon. Null = data unavailable — treat
as "could not verify", never as "no events".
`.trim();

const Schema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('macro'),
        withinDays: z.number().int().min(0).max(30).optional()
            .describe('Horizon in days (default 3): 0 = today only, 1 = through tomorrow.'),
    }),
    z.object({
        action: z.literal('earnings_market'),
        symbol: z.string().describe("US equity ticker, e.g. 'AAPL'."),
    }),
]);

export function createEventRiskTool() {
    return new DynamicStructuredTool({
        name: 'event_risk',
        description: 'Macro event calendar with market-implied probabilities; per-symbol earnings markets.',
        schema: Schema,
        func: async (input) => {
            if (input.action === 'macro') {
                const events = await getMacroEventsWithin(input.withinDays ?? 3);
                if (events === null) {
                    return formatToolResult({
                        error: 'prediction-market data unavailable — macro event risk could NOT be verified',
                    });
                }
                return formatToolResult({
                    events,
                    note: events.length === 0 ? 'no dated macro binaries inside the horizon' : undefined,
                });
            }
            const signal = await getEarningsMarketSignal(input.symbol);
            return formatToolResult(
                signal ?? {
                    symbol: input.symbol.toUpperCase(),
                    market: null,
                    note: 'no open Polymarket earnings market for this symbol — external signal absent (not negative)',
                },
            );
        },
    });
}
