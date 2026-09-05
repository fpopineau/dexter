/**
 * Deferred-spread re-check (REQ-RISK-008, live-loop WP1).
 *
 * A pre-open accept of a DAY entry is quoted on the pre-market book, whose
 * spread does not price the fill that happens at the open (2026-09-04:
 * P-0EED PL refused at 0.69% vs the 0.5% cap at 08:35 ET, expiring before
 * the open — the exact dawn placement REQ-RISK-004 had just enabled). The
 * accept path now DEFERS a spread over the cap but under the hard multiple
 * (`checkMicrostructure` with preOpenDay) and flags the row; this module
 * runs the re-check at 09:31 ET on the live regular-session quote:
 *
 *   filled entry     → keep (the position is protected); clear the flag
 *   unfilled, spread ≤ cap  → clear the flag, the entry rests on
 *   unfilled, spread > cap  → cancel the ENTRY LEG through the only safe
 *                             cancel primitive (parent only, complete book,
 *                             broker-confirmed); ledger the refusal
 *   no quote         → retry on the next pass (never cancel on missing data)
 *
 * Recorded trade-off (operator, 2026-09-05): a fill on the opening cross
 * before 09:31 pays the true spread once — accepted over refusing every
 * dawn accept.
 */

import { Cron } from 'croner';
import { logger } from '@/utils';
import { getRiskRules } from '@/tools/ibkr/risk-rules.js';
import { fetchLiveQuote, type LiveQuote } from './proposal-executor.js';
import { cancelEntryLeg } from './stale-entry-sweeper.js';
import { listSpreadDeferred, markSpreadDeferred, recordRefusal, type TradeProposal } from './trade-proposals.js';

const ET = 'America/New_York';
/** One minute after the open: the opening cross has printed, the book is
 *  the regular-session book. */
const RECHECK_CRON = '31 9 * * 1-5';

export type SpreadRecheckDecision = 'keep-filled' | 'cancel' | 'clear' | 'retry';

/** Pure: what the re-check does with one deferred row. */
export function spreadRecheckDecision(input: { filled: boolean; spreadPct: number | null; capPct: number }): SpreadRecheckDecision {
    if (input.filled) return 'keep-filled';
    if (input.spreadPct === null || !Number.isFinite(input.spreadPct)) return 'retry';
    return input.spreadPct > input.capPct ? 'cancel' : 'clear';
}

export function spreadPctOf(q: LiveQuote): number | null {
    if (q.bid === null || q.ask === null || !(q.bid > 0) || !(q.ask >= q.bid)) return null;
    const mid = (q.bid + q.ask) / 2;
    return ((q.ask - q.bid) / mid) * 100;
}

export interface SpreadRecheckDeps {
    listSpreadDeferred: () => Promise<TradeProposal[]>;
    fetchLiveQuote: (symbol: string) => Promise<LiveQuote>;
    cancelEntryLeg: (p: TradeProposal, why: string) => Promise<boolean>;
    markSpreadDeferred: (id: string, deferred: boolean) => Promise<void>;
    recordRefusal: (r: { symbol: string; direction: 'long' | 'short'; entryType: string; entry: number | null; stop: number; target: number; quantity: number; score: number | null; reason: string; livePrice: number | null; triggerRank: number | null }) => Promise<void>;
    maxSpreadPct: number;
}

export interface SpreadRecheckResult {
    checked: number;
    cancelled: number;
    cleared: number;
    retried: number;
}

export async function runSpreadRecheckOnce(deps: SpreadRecheckDeps): Promise<SpreadRecheckResult> {
    const rows = await deps.listSpreadDeferred();
    const result: SpreadRecheckResult = { checked: rows.length, cancelled: 0, cleared: 0, retried: 0 };
    for (const p of rows) {
        try {
            const filled = p.entryFillPrice != null;
            const quote = filled ? null : await deps.fetchLiveQuote(p.symbol);
            const spreadPct = quote ? spreadPctOf(quote) : null;
            const decision = spreadRecheckDecision({ filled, spreadPct, capPct: deps.maxSpreadPct });
            switch (decision) {
                case 'keep-filled':
                    await deps.markSpreadDeferred(p.id, false);
                    result.cleared++;
                    logger.info(`[spread-recheck] ${p.id} ${p.symbol}: entry filled before the re-check — position protected, flag cleared`);
                    break;
                case 'clear':
                    await deps.markSpreadDeferred(p.id, false);
                    result.cleared++;
                    logger.info(`[spread-recheck] ${p.id} ${p.symbol}: regular-session spread ${spreadPct?.toFixed(2)}% inside the ${deps.maxSpreadPct}% cap — entry rests on`);
                    break;
                case 'cancel': {
                    const why = `spread-deferred-cancel: regular-session spread ${spreadPct?.toFixed(2)}% exceeds max_spread_pct ${deps.maxSpreadPct}% (pre-open accept deferred the check)`;
                    const cancelled = await deps.cancelEntryLeg(p, why);
                    await deps.markSpreadDeferred(p.id, false);
                    await deps.recordRefusal({
                        symbol: p.symbol, direction: p.direction, entryType: p.entryType, entry: p.entry, stop: p.stop, target: p.target,
                        quantity: p.quantity, score: p.score, reason: why, livePrice: quote?.last ?? null, triggerRank: p.triggerRank,
                    }).catch(() => { /* ledger is best-effort */ });
                    if (cancelled) result.cancelled++;
                    else result.cleared++; // filled/gone during the cancel — the tracker owns it; nothing left to defer
                    logger.warn(`[spread-recheck] ${p.id} ${p.symbol}: ${why} — entry cancel ${cancelled ? 'confirmed' : 'not applicable (filled or gone)'}`);
                    break;
                }
                case 'retry':
                    result.retried++;
                    logger.warn(`[spread-recheck] ${p.id} ${p.symbol}: no live quote — re-check deferred to the next pass`);
                    break;
                default: {
                    const _exhaustive: never = decision;
                    throw new Error(`unhandled decision ${String(_exhaustive)}`);
                }
            }
        } catch (err) {
            logger.warn(`[spread-recheck] ${p.id} ${p.symbol}: re-check failed — ${err instanceof Error ? err.message : err}`);
            result.retried++;
        }
    }
    return result;
}

const liveDeps = (): SpreadRecheckDeps => ({
    listSpreadDeferred,
    fetchLiveQuote,
    cancelEntryLeg,
    markSpreadDeferred,
    recordRefusal: (r) => recordRefusal(r),
    maxSpreadPct: getRiskRules().max_spread_pct,
});

let job: Cron | null = null;
/** Review-35 lifecycle pattern: a generation counter so a run queued
 *  before stop never acts after it. */
let generation = 0;

export function startSpreadRecheck(): void {
    if (job) return;
    const gen = ++generation;
    job = new Cron(RECHECK_CRON, { timezone: ET }, () => {
        if (gen !== generation) return;
        runSpreadRecheckOnce(liveDeps())
            .then((r) => { if (r.checked > 0) logger.info(`[spread-recheck] 09:31 ET pass: ${JSON.stringify(r)}`); })
            .catch((err) => logger.warn(`[spread-recheck] pass failed: ${err}`));
    });
    logger.info(`[spread-recheck] started: deferred pre-open spread checks re-run at 09:31 ET (${RECHECK_CRON})`);
}

export function stopSpreadRecheck(): void {
    generation++;
    if (job) { job.stop(); job = null; }
}
