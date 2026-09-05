/**
 * Simulator report (REQ-SIM-001/006, live-loop WP2) — pure summaries over
 * sim rows. WP3's digest reads these; WP2 prints one compact settle report
 * per night so the operator sees the variants accrue from day one.
 */

import { etDayOf } from '@/utils/equity-series-math.js';
import type { SimTrade } from './store.js';

export interface VariantSummary {
    variant: string;
    /** Settled rows with an R value. */
    n: number;
    /** Distinct ET days of source creation among the settled rows. */
    days: number;
    sumR: number;
    meanR: number | null;
    netUsd: number;
    wins: number;
    losses: number;
    flats: number;
    open: number;
    unknown: number;
    unfilled: number;
}

export function summarizeVariants(rows: SimTrade[]): VariantSummary[] {
    const by = new Map<string, VariantSummary & { dayset: Set<string> }>();
    for (const r of rows) {
        const s = by.get(r.variant) ?? {
            variant: r.variant, n: 0, days: 0, sumR: 0, meanR: null, netUsd: 0, wins: 0, losses: 0, flats: 0, open: 0, unknown: 0, unfilled: 0, dayset: new Set<string>(),
        };
        if (r.status === 'open') s.open++;
        else if (r.status === 'unknown' || r.outcome === 'unknown') s.unknown++;
        else if (r.outcome === 'unfilled') s.unfilled++;
        else if (r.netR !== null) {
            s.n++;
            s.sumR += r.netR;
            s.netUsd += r.netUsd ?? 0;
            s.dayset.add(etDayOf(r.createdAt));
            if (r.outcome === 'eod-flat') s.flats++;
            else if ((r.netUsd ?? 0) > 0) s.wins++;
            else s.losses++;
        }
        by.set(r.variant, s);
    }
    return [...by.values()]
        .map(({ dayset, ...s }) => ({ ...s, days: dayset.size, meanR: s.n > 0 ? s.sumR / s.n : null }))
        .sort((a, b) => (a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0));
}

export interface TwinCalibration {
    compared: number;
    missingActual: number;
    /** Mean |sim fill − actual fill| / actual, in basis points. */
    meanEntrySlippageBps: number | null;
    /** Fraction of compared rows whose sim outcome class equals the actual exit reason. */
    outcomeAgreement: number | null;
}

/** REQ-SIM-001: the incumbent twin against the actual executed row. */
export function twinCalibration(
    twins: SimTrade[],
    actuals: Map<string, { entryFillPrice: number | null; exitReason: 'target' | 'stop' | 'cancelled' | 'manual' | 'unknown' | null }>,
): TwinCalibration {
    let compared = 0;
    let missing = 0;
    let slipSum = 0;
    let slipN = 0;
    let agree = 0;
    for (const t of twins) {
        if (t.variant !== 'incumbent' || t.sourceKind !== 'proposal') continue;
        const a = actuals.get(t.sourceId);
        if (!a || a.entryFillPrice === null || !(a.entryFillPrice > 0)) { missing++; continue; }
        compared++;
        if (t.fillPrice !== null) {
            slipSum += (Math.abs(t.fillPrice - a.entryFillPrice) / a.entryFillPrice) * 10_000;
            slipN++;
        }
        if (a.exitReason !== null && t.outcome === a.exitReason) agree++;
    }
    return {
        compared,
        missingActual: missing,
        meanEntrySlippageBps: slipN > 0 ? slipSum / slipN : null,
        outcomeAgreement: compared > 0 ? agree / compared : null,
    };
}

export interface SettleRunCounts {
    sources: number;
    evaluated: number;
    settled: number;
    open: number;
    unknown: number;
    skipped: number;
    failed: number;
}

export function formatSettleReport(input: {
    date: string;
    summaries: VariantSummary[];
    twin: TwinCalibration;
    inactive: string[];
    run: SettleRunCounts;
}): string {
    const fmt = (x: number | null, d = 2) => (x === null ? '—' : x.toFixed(d));
    const lines = input.summaries.map((s) =>
        `• ${s.variant}: n ${s.n} (${s.days}d) ΣR ${fmt(s.sumR)} meanR ${fmt(s.meanR)} $${fmt(s.netUsd, 0)} W${s.wins}/L${s.losses}/F${s.flats}` +
        `${s.open ? ` open ${s.open}` : ''}${s.unknown ? ` unk ${s.unknown}` : ''}${s.unfilled ? ` unfilled ${s.unfilled}` : ''}`);
    return [
        `🧪 Simulator settle ${input.date} — ${input.run.evaluated} evaluations over ${input.run.sources} sources ` +
        `(settled ${input.run.settled}, open ${input.run.open}, unknown ${input.run.unknown}, skipped ${input.run.skipped}` +
        `${input.run.failed ? `, FAILED ${input.run.failed}` : ''}); fills pessimistic (trade-through, stop-first ties, gap-aware stops).`,
        ...lines,
        `• twin vs actual: ${input.twin.compared} compared, entry slippage ${fmt(input.twin.meanEntrySlippageBps, 1)} bps, ` +
        `outcome agreement ${input.twin.outcomeAgreement === null ? '—' : `${Math.round(input.twin.outcomeAgreement * 100)}%`}` +
        `${input.twin.missingActual ? ` (${input.twin.missingActual} without an actual fill)` : ''}`,
        ...(input.inactive.length ? [`• inactive: ${input.inactive.join(', ')}`] : []),
    ].join('\n');
}
