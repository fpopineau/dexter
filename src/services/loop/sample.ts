/**
 * Epoch sample (REQ-SEQ-001, live-loop WP3; hardened after the audit of
 * 2026-09-05, AUD-11) — the pinned filter the looks evaluate, mirrored from
 * the scorecard's SAMPLE_WHERE: closed, proposed inside the epoch, entry
 * filled, realized P&L known, not cancelled, a production lane (never
 * adopted/test/smoke), not flagged untrustworthy. Deployable classes only
 * (the classes enabled in the live config); shadow-only classes are
 * reported apart.
 *
 * Integrity (every one of these FREEZES the look — recorded, never a zero,
 * never a silent drop):
 *   - a closed, entry-filled row whose realized P&L is unknown (outside
 *     'cancelled') — the cohort is incomplete until reconciled;
 *   - a row missing its planned-risk basis or its commissions;
 *   - a row whose strategy fingerprint is absent or differs from the
 *     epoch's — the cohort mixes identities;
 *   - more than one distinct judgment model across the sample.
 */

import { liveDisabledClasses } from '@/tools/ibkr/risk-rules.js';
import { etDayOf } from '@/utils/equity-series-math.js';
import { netRForRow, type RTrade } from '@/utils/sequential-test.js';
import { listProposals, type TradeProposal } from '../trade-proposals.js';

const UNTRUSTWORTHY = /NOT trustworthy/i;
const EXCLUDED_SOURCES = new Set(['adopted', 'test', 'smoke']);

export interface EpochIdentity {
    startedAt: number;
    /** The epoch's fingerprint; '' when the epoch recorded none. */
    fingerprint: string;
}

export interface EpochSample {
    /** Deployable-lane trades with an R value. */
    trades: RTrade[];
    /** Shadow-only classes (reported apart, never in the verdict). */
    shadowTrades: RTrade[];
    /** Integrity anomalies (REQ-SEQ-001): each one freezes the look. */
    anomalies: string[];
    /** In-cohort rows still working (right-censoring information). */
    openInCohort: number;
    /** Distinct non-null judgment models across the sample rows. */
    models: string[];
    /** Sample rows without a model stamp (reported, not an anomaly). */
    unmodelled: number;
}

/** Pure: build the sample from proposal rows. */
export function buildEpochSample(proposals: TradeProposal[], epoch: EpochIdentity, shadowClasses: Set<string>): EpochSample {
    const trades: RTrade[] = [];
    const shadowTrades: RTrade[] = [];
    const anomalies: string[] = [];
    const models = new Set<string>();
    let unmodelled = 0;
    let openInCohort = 0;
    if (!epoch.fingerprint) anomalies.push('the epoch recorded no strategy fingerprint — identity homogeneity cannot be verified');
    for (const p of proposals) {
        if (p.createdAt < epoch.startedAt) continue;
        if (EXCLUDED_SOURCES.has(p.source)) continue;
        if (p.status === 'executed' || p.status === 'executing') { openInCohort++; continue; }
        if (p.status !== 'closed') continue;
        if (p.entryFillPrice === null) continue; // never filled: no trade happened
        if (p.exitReason === 'cancelled') continue;
        if (p.note && UNTRUSTWORTHY.test(p.note)) continue;
        if (p.realizedPnl === null) {
            // AUD-11: an executed trade with an unknown outcome is missing from
            // the denominator — the cohort is incomplete, not smaller.
            anomalies.push(`${p.id} ${p.symbol}: closed with entry filled but realized P&L UNKNOWN — cohort incomplete until reconciled`);
            continue;
        }
        if (p.strategyFingerprint === null) {
            anomalies.push(`${p.id} ${p.symbol}: strategy fingerprint ABSENT (identity unresolved at creation) — cohort identity unverifiable`);
        } else if (epoch.fingerprint && p.strategyFingerprint !== epoch.fingerprint) {
            anomalies.push(`${p.id} ${p.symbol}: fingerprint ${p.strategyFingerprint} ≠ epoch ${epoch.fingerprint} — mixed identity in the cohort`);
        }
        if (p.model) models.add(p.model); else unmodelled++;
        const netR = netRForRow({ realizedPnl: p.realizedPnl, commissions: p.commissions, entryFillPrice: p.entryFillPrice, stop: p.stop, quantity: p.quantity });
        if (netR === null) {
            anomalies.push(`${p.id} ${p.symbol}: planned-risk basis or commissions missing — R undefined`);
            continue;
        }
        const t: RTrade = {
            id: p.id,
            entryDay: etDayOf(p.entryFilledAt ?? p.closedAt ?? p.createdAt),
            closedAt: p.closedAt ?? p.updatedAt,
            netR,
            netUsd: p.realizedPnl - (p.commissions ?? 0),
            commissionsUsd: p.commissions,
            band: p.triggerBand,
            tradeClass: p.tradeClass,
            // REQ-LANE-006/007: the lane, or 'legacy' for a pre-contract row.
            strategyId: p.strategyId ?? 'legacy',
            score: p.score,
        };
        // Deployable = the classes enabled in the live config; a legacy row
        // (no lane) is never part of a lane cohort and is reported apart.
        if (shadowClasses.has(p.tradeClass) || t.strategyId === 'legacy') shadowTrades.push(t); else trades.push(t);
    }
    if (models.size > 1) anomalies.push(`judgment purity: ${models.size} distinct models in the cohort (${[...models].join(', ')}) — one model per epoch`);
    return { trades, shadowTrades, anomalies, openInCohort, models: [...models], unmodelled };
}

/** Live loader over the proposals store. */
export async function loadEpochSample(epochStartMs: number, epochFingerprint: string): Promise<EpochSample> {
    const rows = (await listProposals(undefined, 5000)).filter((p) => p.createdAt >= epochStartMs);
    return buildEpochSample(rows, { startedAt: epochStartMs, fingerprint: epochFingerprint }, new Set(liveDisabledClasses()));
}
