/**
 * Earnings calendar tool — keyless (Nasdaq public data), registered always.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
    etDatePlus,
    findUpcomingEarnings,
    getEarningsForDate,
} from '@/services/earnings-calendar.js';
import { formatToolResult } from '../types.js';

export const EARNINGS_CALENDAR_DESCRIPTION = `
US earnings calendar (free Nasdaq data, cached).

**day** — who reports on an ET date (default today): symbol, pre-market/
  after-hours timing, consensus EPS forecast, market cap.
**check** — do any of the given symbols report within the next N days
  (default 2)? THE overnight-risk question: holding through a report is a
  deliberate decision, never an accident. Days whose data could not be
  fetched are listed in unknownDays — treat those as "could not verify",
  NEVER as "no earnings".

Use it in every pre-market brief (today + tomorrow: expect gap catalysts)
and before proposing or keeping any overnight/GTC position.
`.trim();

const Schema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('day'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
            .describe("ET date 'YYYY-MM-DD'. Omit for today."),
    }),
    z.object({
        action: z.literal('check'),
        symbols: z.union([z.array(z.string()), z.string()])
            .describe("Symbols to check, array or comma-separated string."),
        withinDays: z.coerce.number().int().min(0).max(14).default(2)
            .describe('Look-ahead window in ET days (default 2).'),
    }),
]);

export function createEarningsCalendarTool() {
    return new DynamicStructuredTool({
        name: 'earnings_calendar',
        description: 'US earnings calendar: who reports on a date, and whether given symbols report within N days.',
        schema: Schema,
        func: async (input) => {
            if (input.action === 'day') {
                const date = input.date ?? etDatePlus(0);
                const entries = await getEarningsForDate(date);
                if (entries === null) {
                    return formatToolResult({ date, error: 'calendar data unavailable for this date — could not verify, do not assume no earnings' });
                }
                // Big reporters first — the ones that move the tape.
                const sorted = [...entries].sort((a, b) =>
                    (b.marketCap?.length ?? 0) - (a.marketCap?.length ?? 0) ||
                    String(b.marketCap).localeCompare(String(a.marketCap)));
                return formatToolResult({ date, count: entries.length, reporters: sorted.slice(0, 40) });
            }
            const symbols = Array.isArray(input.symbols)
                ? input.symbols
                : input.symbols.split(',').map((s) => s.trim());
            const result = await findUpcomingEarnings(symbols, input.withinDays);
            return formatToolResult({
                checked: symbols.map((s) => s.toUpperCase()),
                withinDays: input.withinDays,
                ...result,
                note: result.hits.length === 0 && result.unknownDays.length === 0
                    ? 'none of these symbols report in the window'
                    : undefined,
            });
        },
    });
}
