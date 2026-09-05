/**
 * Overnight benchmark (REQ-BENCH-004/005, WP7; audit AUD-13).
 *
 * Every eligible overnight candidate archived before the close gets a
 * MECHANICAL twin under the lane contract — MKT at the next bar ("buy
 * before the close"), stop at `stop_atr_multiplier` × daily ATR, target at
 * take-x, flat at the 10:00 ET deadline — replayed with the simulator's
 * pessimistic fill model against the next session's bars. The report is
 * the common perimeter the judgment must beat: the whole universe, the
 * top-5 by rank, the rows it proposed, the rows it refused, the rows it
 * never admitted — with the gap dimension the intraday benchmark treats as
 * uncapturable.
 *
 * Observability only: reads the candidate archive and the ledgers, writes
 * the candidate rows' outcome columns. Never feeds a look (REQ-BENCH-006).
 */

import type { RiskRules } from '@/tools/ibkr/risk-rules.js';
import { logger } from '@/utils';
import {
    CANDIDATE_REPLAY_HORIZON_DAYS,
    disposeCandidates,
    etDayIso,
    type CandidatePatch,
    type CandidateRow,
    type DispositionLedger,
} from './candidate-archive.js';
import { nextTradingDayStartMs } from './lane-contract.js';
import { etFrameMs } from './outcome-tracker.js';
import { classRiskPct } from './position-sizer.js';
import type { SimBarSource } from './simulator/bars.js';
import { commissionsFor, simulateBracket, type CommissionConfig, type SimBar, type SimSpec } from './simulator/fill-model.js';
import { sizeAtRung } from './simulator/variants.js';

const DAY_MS = 86_400_000;
/** The MKT entry must fill on the capture day; an hour is generous. */
const ENTRY_WINDOW_MS = 60 * 60_000;

export interface OvernightBenchDeps {
    /** Epoch ms. */
    now: number;
    rules: RiskRules;
    rungPct: number;
    netLiq: number;
    commissions: CommissionConfig;
    listPending(): Promise<CandidateRow[]>;
    /** Every row of the given capture days (for the report's tallies). */
    listDays(days: string[]): Promise<CandidateRow[]>;
    update(id: number, patch: CandidatePatch): Promise<void>;
    loadBars(symbol: string, fromT: number, toT: number, opts: { rth: boolean; halfDay: boolean }): Promise<{ bars: SimBar[]; source: SimBarSource } | null>;
    isHalfDay(dateIso: string): boolean;
    ledgerSince(sinceMs: number): Promise<DispositionLedger>;
}

export interface OvernightBenchCounts {
    due: number;
    settled: number;
    unknown: number;
    expired: number;
    notDue: number;
    failed: number;
    days: string[];
}

/** Pure: the twin's bracket for an archived overnight row. */
export function twinSpec(row: CandidateRow): SimSpec | null {
    if (row.stop === null || row.target === null || row.exitDeadline === null) return null;
    const created = etFrameMs(row.capturedAt);
    return {
        direction: row.direction,
        entryType: 'MKT',
        entry: null,
        entryLimit: null,
        stop: row.stop,
        target: row.target,
        createdAt: created,
        entryDeadline: created + ENTRY_WINDOW_MS,
        flatAt: etFrameMs(row.exitDeadline),
    };
}

/** Pure: the next session's first-bar open vs the capture price, % signed toward the direction. */
export function gapPctOf(row: CandidateRow, bars: SimBar[]): number | null {
    const nextOpenFrame = etFrameMs(nextTradingDayStartMs(row.capturedAt)) + (9 * 60 + 30) * 60_000;
    const first = [...bars].sort((a, b) => a.t - b.t).find((b) => b.t >= nextOpenFrame);
    if (!first || !(row.price > 0)) return null;
    const raw = ((first.open - row.price) / row.price) * 100;
    return Math.round((row.direction === 'long' ? raw : -raw) * 100) / 100;
}

async function replayOne(row: CandidateRow, deps: OvernightBenchDeps, counts: OvernightBenchCounts): Promise<void> {
    const spec = twinSpec(row);
    if (!spec || row.id === undefined) { counts.failed++; return; }
    const halfDay = deps.isHalfDay(row.day);
    const loaded = await deps.loadBars(row.symbol, spec.createdAt, spec.flatAt!, { rth: true, halfDay });
    const base: CandidatePatch = { replayedAt: deps.now, barSource: loaded?.source ?? null };
    if (!loaded) {
        counts.unknown++;
        await deps.update(row.id, { ...base, replayStatus: 'unknown', outcome: 'unknown', note: 'no covered bar source (stream/archive/IBKR) for the window' });
        return;
    }
    const r = simulateBracket(loaded.bars, spec);
    const gapPct = gapPctOf(row, loaded.bars);
    if (r.outcome === 'open' || r.outcome === 'unknown') {
        counts.unknown++;
        await deps.update(row.id, {
            ...base, replayStatus: 'unknown', outcome: 'unknown', gapPct, fillAt: r.fillAt, fillPrice: r.fillPrice, mfePct: r.mfePct, maePct: r.maePct,
            note: r.outcome === 'open' ? 'bars ended before the deadline bar' : r.note ?? null,
        });
        return;
    }
    // Size at the OVERNIGHT lane's effective budget (min(rung, overnight_risk_pct)
    // — the budget the real row would get), for the informational USD/net R.
    const budgetPct = classRiskPct('swing', deps.rules, deps.rungPct, 'overnight');
    const quantity = row.stop !== null ? sizeAtRung({ entry: row.price, stop: row.stop, rungPct: budgetPct, netLiq: deps.netLiq }) : 0;
    if (r.outcome === 'unfilled' || r.fillPrice === null) {
        counts.settled++;
        await deps.update(row.id, { ...base, replayStatus: 'settled', outcome: r.outcome, gapPct, quantity, commissions: 0, netUsd: 0, netR: null, grossR: null, note: 'MKT entry found no bar inside the entry window' });
        return;
    }
    const sides = r.exitPrice !== null ? 2 : 1;
    const commissions = quantity > 0 ? commissionsFor(quantity, sides, deps.commissions) : 0;
    const sign = row.direction === 'long' ? 1 : -1;
    const gross = r.exitPrice !== null ? (r.exitPrice - r.fillPrice) * quantity * sign : 0;
    const netUsd = Math.round((gross - commissions) * 100) / 100;
    const riskPerShare = row.stop !== null ? Math.abs(row.price - row.stop) : 0;
    const riskUsd = riskPerShare * quantity;
    // Review 2026-09-06 (finding 9): the size-invariant label — R before
    // costs per unit of planned risk; netR at the budget is informational.
    const grossR = r.exitPrice !== null && riskPerShare > 0 ? Math.round((((r.exitPrice - r.fillPrice) * sign) / riskPerShare) * 1e4) / 1e4 : null;
    counts.settled++;
    await deps.update(row.id, {
        ...base, replayStatus: 'settled', outcome: r.outcome, gapPct, fillAt: r.fillAt, fillPrice: r.fillPrice, exitAt: r.exitAt, exitPrice: r.exitPrice,
        mfePct: r.mfePct, maePct: r.maePct, quantity, commissions, netUsd, netR: riskUsd > 0 ? Math.round((netUsd / riskUsd) * 1e4) / 1e4 : null, grossR,
        note: quantity <= 0 ? 'unaffordable at the budget (0 shares) — net R undefined, gross R kept' : null,
    });
}

/** One nightly pass: replay every due row once, join dispositions, report. */
export async function runOvernightBenchmarkOnce(deps: OvernightBenchDeps): Promise<{ counts: OvernightBenchCounts; reports: string[] }> {
    const counts: OvernightBenchCounts = { due: 0, settled: 0, unknown: 0, expired: 0, notDue: 0, failed: 0, days: [] };
    const pending = await deps.listPending();
    const days = new Set<string>();
    for (const row of pending) {
        if (row.id === undefined) continue;
        if (deps.now - row.capturedAt > CANDIDATE_REPLAY_HORIZON_DAYS * DAY_MS) {
            counts.expired++;
            await deps.update(row.id, { replayStatus: 'unknown', outcome: 'unknown', replayedAt: deps.now, note: `expired: still pending after ${CANDIDATE_REPLAY_HORIZON_DAYS} days` });
            days.add(row.day);
            continue;
        }
        if (row.exitDeadline === null || row.exitDeadline > deps.now) { counts.notDue++; continue; }
        counts.due++;
        days.add(row.day);
        try {
            await replayOne(row, deps, counts);
        } catch (err) {
            counts.failed++;
            logger.warn(`[overnight-benchmark] ${row.symbol} ${row.day}: replay failed — ${err instanceof Error ? err.message : err}`);
        }
    }
    counts.days = [...days].sort();
    const reports: string[] = [];
    if (counts.days.length > 0) {
        const rows = await deps.listDays(counts.days);
        // REQ-BENCH-003: the disposition join for the days replayed tonight.
        const earliest = Math.min(...rows.map((r) => r.capturedAt));
        const ledger = await deps.ledgerSince(earliest - 12 * 3_600_000);
        const disposed = disposeCandidates(rows, ledger);
        for (const d of disposed) {
            const orig = rows.find((r) => r.id === d.id);
            if (d.id !== undefined && orig && (orig.disposition !== d.disposition || orig.dispositionRef !== d.dispositionRef)) {
                await deps.update(d.id, { disposition: d.disposition, dispositionRef: d.dispositionRef });
            }
        }
        for (const day of counts.days) {
            reports.push(formatOvernightReport(day, disposed.filter((r) => r.day === day && r.lane === 'overnight'), deps.rules));
        }
    }
    return { counts, reports };
}

// ---------------------------------------------------------------------------
// Report (pure)
// ---------------------------------------------------------------------------

function stats(rows: CandidateRow[]): { n: number; meanR: number | null; sumR: number; w: number; l: number; f: number } {
    const scored = rows.filter((r) => r.replayStatus === 'settled' && r.netR !== null);
    const sumR = scored.reduce((s, r) => s + (r.netR ?? 0), 0);
    return {
        n: scored.length,
        meanR: scored.length ? sumR / scored.length : null,
        sumR,
        w: scored.filter((r) => (r.netR ?? 0) > 0).length,
        l: scored.filter((r) => (r.netR ?? 0) < 0).length,
        f: scored.filter((r) => r.netR === 0).length,
    };
}

function median(xs: number[]): number | null {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const fmtR = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}`);
const fmtPct = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);

/** REQ-BENCH-005: one block per capture day. */
export function formatOvernightReport(day: string, rows: CandidateRow[], rules: Pick<RiskRules, 'overnight_gap_stress_pct'>): string {
    const eligible = rows.filter((r) => r.eligible);
    const ineligible = rows.filter((r) => !r.eligible);
    const tally = new Map<string, number>();
    for (const r of ineligible) for (const reason of r.reasons.filter((x) => !x.startsWith('note:'))) tally.set(reason, (tally.get(reason) ?? 0) + 1);
    const tallyLine = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
    const universe = stats(eligible);
    const gaps = eligible.map((r) => r.gapPct).filter((g): g is number => g !== null);
    const adverse = gaps.filter((g) => g <= -rules.overnight_gap_stress_pct).length;
    const top5 = stats([...eligible].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)).slice(0, 5));
    const proposed = eligible.filter((r) => r.disposition === 'proposed');
    const refused = eligible.filter((r) => r.disposition === 'refused');
    const notAdmitted = stats(eligible.filter((r) => r.disposition === 'not-admitted'));
    const unknown = eligible.filter((r) => r.replayStatus === 'unknown').length;
    const lines = [
        `🌙 Overnight benchmark — universe captured ${day} 15:35 ET: ${eligible.length} eligible / ${rows.length} seen` +
        (ineligible.length ? ` (ineligible: ${tallyLine})` : ''),
        `• universe (mechanical twin: MKT@close, take-x, stop at the gate's min R:R, flat 10:00 — eligible ≠ admissible): n ${universe.n} meanR ${fmtR(universe.meanR)} ΣR ${fmtR(universe.sumR)} W${universe.w}/L${universe.l}/F${universe.f}` +
        ` · gap median ${fmtPct(median(gaps))}, adverse ≥${rules.overnight_gap_stress_pct}%: ${adverse}`,
        `• top-5 by rank: n ${top5.n} meanR ${fmtR(top5.meanR)}`,
        `• judgment proposed ${proposed.length}${proposed.length ? ` (${proposed.map((r) => `${r.dispositionRef} ${r.symbol} ${fmtR(r.netR)}R`).join(', ')})` : ''}` +
        ` · refused ${refused.length}${refused.length ? ` (${refused.map((r) => `${r.symbol}:${r.dispositionRef}`).join(', ')})` : ''}` +
        ` · not admitted n ${notAdmitted.n} meanR ${fmtR(notAdmitted.meanR)}`,
    ];
    if (unknown) lines.push(`• unknown ${unknown} (no covered bars)`);
    return lines.join('\n');
}
