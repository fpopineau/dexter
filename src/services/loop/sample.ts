/**
 * Epoch sample (REQ-SEQ-001, live-loop WP3) — the pinned filter the looks
 * evaluate, mirrored from the scorecard's SAMPLE_WHERE: closed, proposed
 * inside the epoch, entry filled, realized P&L known, not cancelled, a
 * production lane (never adopted/test/smoke), not flagged untrustworthy.
 * Deployable classes only (the classes enabled in the live config);
 * shadow-only classes are reported apart. A row missing its planned-risk
 * basis or its commissions is an INTEGRITY ANOMALY — it freezes the look,
 * it is never a zero.
 */

import { liveDisabledClasses } from '@/tools/ibkr/risk-rules.js';
import { etDayOf } from '@/utils/equity-series-math.js';
import { netRForRow, type RTrade } from '@/utils/sequential-test.js';
import { listProposals, type TradeProposal } from '../trade-proposals.js';

const UNTRUSTWORTHY = /NOT trustworthy/i;
const EXCLUDED_SOURCES = new Set(['adopted', 'test', 'smoke']);

export interface EpochSample {
    /** Deployable-lane trades with an R value. */
    trades: RTrade[];
    /** Shadow-only classes (reported apart, never in the verdict). */
    shadowTrades: RTrade[];
    /** Integrity anomalies (REQ-SEQ-001): missing basis / commissions. */
    anomalies: string[];
    /** In-cohort rows still working (right-censoring information). */
    openInCohort: number;
}

/** Pure: build the sample from proposal rows. */
export function buildEpochSample(proposals: TradeProposal[], epochStartMs: number, shadowClasses: Set<string>): EpochSample {
    const trades: RTrade[] = [];
    const shadowTrades: RTrade[] = [];
    const anomalies: string[] = [];
    let openInCohort = 0;
    for (const p of proposals) {
        if (p.createdAt < epochStartMs) continue;
        if (EXCLUDED_SOURCES.has(p.source)) continue;
        if (p.status === 'executed' || p.status === 'executing') { openInCohort++; continue; }
        if (p.status !== 'closed') continue;
        if (p.entryFillPrice === null || p.realizedPnl === null) continue;
        if (p.exitReason === 'cancelled') continue;
        if (p.note && UNTRUSTWORTHY.test(p.note)) continue;
        const netR = netRForRow({ realizedPnl: p.realizedPnl, commissions: p.commissions, entryFillPrice: p.entryFillPrice, stop: p.stop, quantity: p.quantity });
        if (netR === null) {
            anomalies.push(`${p.id} ${p.symbol}: planned-risk basis or commissions missing — R undefined`);
            continue;
        }
        const t: RTrade = {
            id: p.id,
            entryDay: etDayOf(p.entryFilledAt ?? p.closedAt ?? p.createdAt),
            netR,
            netUsd: p.realizedPnl - (p.commissions ?? 0),
            band: p.triggerBand,
            tradeClass: p.tradeClass,
            score: p.score,
        };
        if (shadowClasses.has(p.tradeClass)) shadowTrades.push(t); else trades.push(t);
    }
    return { trades, shadowTrades, anomalies, openInCohort };
}

/** Live loader over the proposals store. */
export async function loadEpochSample(epochStartMs: number): Promise<EpochSample> {
    const rows = (await listProposals(undefined, 5000)).filter((p) => p.createdAt >= epochStartMs);
    return buildEpochSample(rows, epochStartMs, new Set(liveDisabledClasses()));
}
