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
import { getLatestNewsPulse } from '@/services/news-pulse.js';
import { formatToolResult } from '../types.js';

export const OPPORTUNITIES_DESCRIPTION = `
Ranked trading opportunities from the continuous market scanner (Opportunity Engine).

Actions:
  **latest** (default) — return the most recent ranked snapshot. Fast; no market requests.
  **refresh** — run a fresh scan+score cycle now (takes ~30-60s; respects IBKR pacing), then return it.

Each opportunity carries: symbol, direction (long/short), signalScore (0-100 multi-factor),
compositeRank (signal + RVOL bonus + multi-scanner presence), price, RVOL, ATR, RSI, VWAP,
and which scanners surfaced it. Entries are sorted by compositeRank descending.

Pass lane "overnight" to get the overnight lane's OWN ranking (EOD continuation: significance in
ATR units, closing strength vs VWAP, liquidity, RVOL — excluded names carry their reason). Lane
scores are comparable only inside their lane; the composite is intraday's ranking.

Use 'latest' first; only 'refresh' if the snapshot is missing or stale (>15 min during market
hours). Snapshots taken while the market is closed carry marketOpen=false — treat their data
as stale context, not live signals. This tool is advisory and never places orders.
`.trim();

const OpportunitiesSchema = z.object({
    // Deliberately a free string: an unknown action (observed live: 'create',
    // trying to register a proposal here) must return a STEERING message,
    // not an opaque schema error the model reads as "tool is broken".
    action: z
        .string()
        .default('latest')
        .describe("'latest' returns the cached snapshot; 'refresh' runs a new scan cycle (~30-60s). No other actions exist — proposals are registered with the trade_proposals tool."),
    limit: z
        .coerce.number()
        .int()
        .positive()
        .max(25)
        .default(10)
        .describe('Maximum number of ranked opportunities to return. Defaults to 10.'),
    lane: z
        .enum(['overnight'])
        .optional()
        .describe("WP8: return the LANE's own ranking instead of the intraday composite — 'overnight' = the EOD-continuation ranking (significance in ATR units, closing strength vs VWAP, liquidity, RVOL; excluded names carry their reason). Use it for the pre-close overnight selection."),
});

/** REQ-DISC-002: the lane view — the same candidates, the lane's ranker. */
function laneView(snapshot: OpportunitySnapshot, lane: 'overnight', limit: number) {
    const l = snapshot.lanes?.[lane];
    if (!l) {
        return { error: `this snapshot carries no '${lane}' lane ranking (taken before WP8) — call with action "refresh"` };
    }
    const bySymbol = new Map(snapshot.opportunities.map((o) => [o.symbol, o]));
    return {
        timestamp: new Date(snapshot.timestamp).toISOString(),
        ageSeconds: Math.round((Date.now() - snapshot.timestamp) / 1000),
        phase: snapshot.phase,
        marketOpen: snapshot.marketOpen,
        lane,
        rankerVersion: l.rankerVersion,
        note: 'lane scores are comparable only inside this lane; the composite is shown for context, not for ranking',
        ranked: l.ranked.slice(0, limit).map((r, i) => {
            const o = bySymbol.get(r.symbol);
            return {
                rank: i + 1,
                symbol: r.symbol,
                direction: r.direction,
                laneScore: r.score,
                factors: r.factors,
                reasons: r.reasons,
                compositeRank: r.compositeRank,
                price: o?.price ?? null,
                dayMovePct: o?.dayMovePct ?? null,
                dailyAtrPct: o?.dailyAtrPct ?? null,
                vwap: o?.vwap ?? null,
                rvol: o?.rvol ?? null,
                dollarVolume: o?.dollarVolume ?? null,
            };
        }),
    };
}

function trim(snapshot: OpportunitySnapshot, limit: number) {
    // News-pulse annotation (visibility only — never a scoring input): a
    // fresh-enough sweep marks candidates whose news cycle is broad.
    const pulse = getLatestNewsPulse();
    const pulseFresh = pulse && Date.now() - pulse.at < 45 * 60_000 ? pulse : null;
    return {
        timestamp: new Date(snapshot.timestamp).toISOString(),
        ageSeconds: Math.round((Date.now() - snapshot.timestamp) / 1000),
        phase: snapshot.phase,
        session: snapshot.sessionLabel,
        marketOpen: snapshot.marketOpen,
        scanned: snapshot.scanned,
        scored: snapshot.scored,
        opportunities: snapshot.opportunities.slice(0, limit).map((o: Opportunity, i: number) => {
            const p = pulseFresh?.symbols[o.symbol];
            return {
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
                newsPulse: p?.hot
                    ? { hot: true, articles: p.articles, domains: p.domains, topHeadline: p.headlines[0]?.title }
                    : undefined,
            };
        }),
    };
}

export function createOpportunitiesTool() {
    return new DynamicStructuredTool({
        name: 'opportunities',
        description:
            'Ranked trading opportunities from the continuous market scanner. Action latest (cached) or refresh (new scan cycle, ~30-60s). Advisory only.',
        schema: OpportunitiesSchema,
        func: async (input) => {
            const action = input.action.trim().toLowerCase();
            if (action !== 'latest' && action !== 'refresh') {
                return formatToolResult({
                    error:
                        `opportunities is READ-ONLY (actions: 'latest', 'refresh') — '${input.action}' does not exist here. ` +
                        `To register a trade recommendation, call the trade_proposals tool with action 'create' ` +
                        `(symbol, direction, entryType, entry, stop, target, quantity, rationale).`,
                });
            }
            if (action === 'refresh') {
                const snapshot = await runCycleOnce();
                return formatToolResult(input.lane ? laneView(snapshot, input.lane, input.limit) : trim(snapshot, input.limit));
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
            return formatToolResult(input.lane ? laneView(snapshot, input.lane, input.limit) : trim(snapshot, input.limit));
        },
    });
}
