/**
 * Earnings-bet intel tool — the deterministic evidence base for the
 * 'earnings-bet' trade class. Two actions:
 *
 *   reactions    the symbol's own post-print record (verified + inferred
 *                prints, direction consistency, worst adverse move) and
 *                the evidence verdict. The worstAdverseFor…Pct value is
 *                what a bet proposal passes as worstCaseGapPct.
 *   implied_move the ATM-straddle move the options market has priced in,
 *                to compare against the historical record.
 *
 * IBKR-gated (bars and option quotes come from the Gateway).
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import {
    getEarningsReactions,
    EVIDENCE_MIN_PRINTS,
    EVIDENCE_MIN_CONSISTENCY_PCT,
} from '@/services/earnings-reactions.js';
import { getEarningsMarketSignal } from '@/services/event-risk.js';
import { fetchImpliedMove } from '@/tools/ibkr/implied-move.js';

export const EARNINGS_BET_INTEL_DESCRIPTION = `
Deterministic evidence for an EARNINGS BET (a deliberate hold through a print).

**reactions** — the symbol's own post-print record from ~${EVIDENCE_MIN_PRINTS + 2} past prints
  (Nasdaq-verified dates plus older ones inferred from quarterly gap
  structure): per-print gap and first-session move, direction consistency,
  the worst adverse move for each side, and the evidence verdict
  (meetsBarLong / meetsBarShort = ≥${EVIDENCE_MIN_PRINTS} prints and ≥${EVIDENCE_MIN_CONSISTENCY_PCT}% consistency).
  Pass worstAdverseForLongPct (long) or worstAdverseForShortPct (short) as
  worstCaseGapPct when creating the proposal — the sizer assumes the
  position gaps that far against you.

**implied_move** — the ATM straddle expiring just after the print, as a %
  of spot: what the options market has priced in. Compare with the record's
  avgAbsMovePct — an implied move far ABOVE the historical average means
  the market already expects fireworks (less edge in the bet). A null
  implied move (missing options entitlement) is a known blind spot: say so
  and weigh the remaining signals, never treat it as zero.

The verdicts here cover print count and consistency only. The third leg of
the evidence bar — at least one supporting EXTERNAL signal — is reported as
externalSignal when the symbol has an open Polymarket "beat quarterly
earnings?" market (beatProbability = the market's read on the print). A
null externalSignal means the signal is ABSENT, not negative: verify one
yourself (beat/guidance streak, news, positioning) before proposing.
`.trim();

const Schema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('reactions'),
        symbol: z.string().describe("US equity ticker, e.g. 'AAPL'."),
    }),
    z.object({
        action: z.literal('implied_move'),
        symbol: z.string().describe("US equity ticker, e.g. 'AAPL'."),
        reactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
            .describe("ET date the post-print reaction trades ('YYYY-MM-DD'). AMC print → next session; BMO print → that session. Omit for tomorrow."),
    }),
]);

export function createEarningsBetIntelTool() {
    return new DynamicStructuredTool({
        name: 'earnings_bet_intel',
        description: 'Post-print reaction record + options-implied move for an earnings-bet evaluation.',
        schema: Schema,
        func: async (input) => {
            if (input.action === 'reactions') {
                try {
                    const [stats, externalSignal] = await Promise.all([
                        getEarningsReactions(input.symbol),
                        getEarningsMarketSignal(input.symbol),
                    ]);
                    return formatToolResult({
                        ...stats,
                        externalSignal,
                        note: stats.nVerified < stats.n
                            ? `${stats.n - stats.nVerified} of ${stats.n} prints are inferred from gap structure, not a published calendar — say so when citing the record`
                            : undefined,
                    });
                } catch (err) {
                    return formatToolResult({
                        error: `${err instanceof Error ? err.message : err}`,
                        verdict: 'no evidence base — the symbol does not qualify for an earnings bet',
                    });
                }
            }
            const move = await fetchImpliedMove(input.symbol, input.reactionDate);
            return formatToolResult(move);
        },
    });
}
