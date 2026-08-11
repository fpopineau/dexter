/**
 * News-pulse tool — the latest batched GDELT sweep over the book, the
 * earnings-reactor watchlist, and the engine's candidates. Visibility for
 * the judgment layer; deliberately NOT a scoring input (research memo
 * 2026-08-05: GDELT stays out of live scoring until an IC test passes).
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { getLatestNewsPulse, isNewsPulseEnabled } from '@/services/news-pulse.js';

export const NEWS_PULSE_DESCRIPTION = `
News breadth for the symbols the desk is already watching (GDELT, keyless,
swept every ~20 min during 07:00-16:00 ET).

Per symbol: unique headlines and distinct publishing domains inside the
sweep window, the top headlines, and a **hot** flag (articles AND domains
above their floors — the story is broad, not one syndicated wire piece).

Use it to answer "is there NEWS behind this move?" before proposing, and in
the pre-market brief to surface which reactors and gappers carry a real
news cycle. Articles lag ~15-35 min — confirmation, not a race. A missing
or stale snapshot means the pulse could not be measured; it never means
"no news". Attribution is name-in-headline: absence of a pulse is weak
evidence, presence is strong.
`.trim();

const Schema = z.object({
    symbol: z.string().optional().describe('Optional ticker filter; omit for the full sweep.'),
});

export function createNewsPulseTool() {
    return new DynamicStructuredTool({
        name: 'news_pulse',
        description: 'Latest news-breadth sweep (GDELT) over book + reactors + candidates; per-symbol headline counts and hot flags.',
        schema: Schema,
        func: async (input) => {
            const snapshot = getLatestNewsPulse();
            if (!snapshot) {
                return formatToolResult({
                    error: isNewsPulseEnabled()
                        ? 'no news-pulse snapshot yet — the sweep runs every ~20 min during market hours (gateway only)'
                        : 'news pulse is disabled (NEWS_PULSE=false)',
                });
            }
            const ageMinutes = Math.round((Date.now() - snapshot.at) / 60_000);
            const base = {
                at: new Date(snapshot.at).toISOString(),
                ageMinutes,
                windowMin: snapshot.windowMin,
                watched: snapshot.watched,
                stale: ageMinutes > 45 ? 'snapshot is stale — treat as context, not current pulse' : undefined,
            };
            if (input.symbol) {
                const sym = input.symbol.trim().toUpperCase();
                const pulse = snapshot.symbols[sym];
                return formatToolResult({
                    ...base,
                    symbol: sym,
                    pulse: pulse ?? null,
                    note: pulse ? undefined : 'symbol was not in the last sweep — pulse unmeasured, not zero',
                });
            }
            // Hot names first, then by article count; quiet names compressed.
            const entries = Object.entries(snapshot.symbols)
                .sort(([, a], [, b]) => Number(b.hot) - Number(a.hot) || b.articles - a.articles);
            return formatToolResult({
                ...base,
                hot: entries.filter(([, p]) => p.hot).map(([s, p]) => ({ symbol: s, ...p })),
                quiet: entries.filter(([, p]) => !p.hot).map(([s, p]) => `${s}:${p.articles}a/${p.domains}d`),
            });
        },
    });
}
