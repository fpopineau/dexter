/**
 * Swing pattern tool — agent-facing access to the nightly pattern scan
 * (pullback-in-uptrend, flat-base, cup-and-handle over the universe-sweep
 * daily history).
 *
 * `latest` reads the persisted snapshot (free); `refresh` re-runs the scan
 * over the local archive (seconds, no IBKR requests).
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getLatestPatternScan, runPatternScan } from '@/services/pattern-scanner.js';
import { formatToolResult } from '../types.js';

export const SWING_PATTERNS_DESCRIPTION = `
Swing setups detected over the midcap universe's daily history (nightly scan
after the universe sweep): pullback-in-uptrend, flat-base, cup-and-handle.

**latest** — the most recent scan snapshot (ranAt, candidates ranked by score).
**refresh** — re-run the scan on the local archive now (fast, no market data
  requests). Useful when the nightly sweep just added history.

Each candidate carries the measured evidence (note), the pattern pivot, a
suggested STP_LMT trigger just above it, a structure stop, and the daily ATR
for sizing. These are MULTI-DAY setups: propose them as tif GTC with
entryType STP_LMT (trigger = suggestedEntry, entryLimit slightly above), a
structure stop near suggestedStop (respect the 0.4× ATR floor), and a target
at a real objective. They complement — never replace — catalyst verification:
check news before proposing, and skip candidates with earnings inside the
holding window.
`.trim();

const Schema = z.object({
    action: z.enum(['latest', 'refresh']).default('latest'),
});

export function createSwingPatternsTool() {
    return new DynamicStructuredTool({
        name: 'swing_patterns',
        description: 'Nightly swing-pattern scan (pullback/flat-base/cup-and-handle) over the midcap universe daily bars.',
        schema: Schema,
        func: async (input) => {
            const snapshot = input.action === 'refresh' ? await runPatternScan() : getLatestPatternScan();
            if (!snapshot) {
                return formatToolResult({
                    error: 'No pattern scan has run yet — the nightly universe sweep (18:00 ET) produces one; ' +
                        "or run action 'refresh' to scan the current archive now.",
                });
            }
            return formatToolResult({
                ranAt: new Date(snapshot.ranAt).toISOString(),
                scannedSymbols: snapshot.scanned,
                freshSymbols: snapshot.eligible,
                candidates: snapshot.candidates,
                guidance: snapshot.candidates.length === 0
                    ? 'No qualifying setups — an honest empty result, do not force trades from it.'
                    : 'Multi-day setups: verify a catalyst/news first, then propose as GTC STP_LMT above the pivot with the structure stop.',
            });
        },
    });
}
