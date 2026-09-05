/**
 * Sequential test — the pre-registered evaluator of a live-loop epoch
 * (REQ-SEQ-001..007, REQ-LADDER-001/002, live-loop WP3).
 *
 * This module IS the protocol's machine-readable form. Its constants are
 * hashed into every epoch record at epoch start (`constantsHash`); a look
 * whose running constants differ from the epoch's refuses to decide
 * (NOT-EVALUABLE) — "editing the evaluator mid-sample ends the window"
 * survives the fingerprint narrowing that excluded this path.
 *
 *   unit        R per trade = (realized − commissions) / (|fill − stop| × qty)
 *   looks       n = 25 / 50 / 75 / 100 closed in-epoch trades, evaluated once
 *               each on the PREFIX of the first `lookN` trades in close
 *               order (audit 2026-09-05, AUD-12: a boundary crossed by
 *               several closes on one day, or two boundaries crossed between
 *               two nightly runs, must reproduce the same look);
 *               one-sided LCB confidence 99 / 97.5 / 96 / 95 %
 *   ACCEPT      LCB > 0 AND net R > 0 AND profit factor ≥ 1.3
 *   REJECT      the 95 % one-sided UPPER bound of mean R < 0
 *   CONTINUE    otherwise; NOT-EVALUABLE under 5 entry days
 *   hard stop   marked NetLiq ≤ 95 % of the epoch NetLiq, any sample
 *   ladder      0.25 → 0.5 → 0.75 → 1.0 % at n ≥ 25 / 50 / 100 with net R > 0
 *               and no active stop (queued for the operator), never above the
 *               ratified per-trade CEILING (a rung the ceiling makes inert is
 *               not offered — audit AUD-09); automatic step-down at −5 % from
 *               the last step-up mark
 *   promotion   a variant is a candidate at ≥ 30 sim trades over ≥ 10 days
 *               when the LCB of its daily R difference vs the incumbent > 0
 *   band        the '60-74' class must read net ≥ 0 once it has 20 trades
 *
 * Bootstrap: day-block by ENTRY day, 10,000 replicates (the 1 % tail rests
 * on 100 draws, not 10 — AUD-12c), seed 42, ≥ 5 days, moving session
 * blocks of `blockDays` consecutive days (`dayBlockBootstrapLcb`); the
 * upper bound is the same bootstrap on the negated values
 * (UCB(x) = −LCB(−x)). Informational alongside every look: the net USD
 * with variable costs (commissions) doubled — a result that survives
 * doubled costs is the one worth believing.
 *
 * Error rate (audit 2026-09-05, AUD-12): the four look alphas sum to 12.5 %
 * — the Bonferroni BOUND on the familywise false-ACCEPT rate, not the
 * realised rate, which depends on the looks' dependence and the PF and
 * net-R conditions. The realised rate is MEASURED, not asserted:
 * `bun run scripts/calibrate-sequential-test.ts` simulates the whole
 * procedure under a zero-mean null with day clustering (and under an
 * alternative for power) and prints the rates; the numbers are recorded in
 * SPEC.md § "Audit 2026-09-05 response". Changing any constant below
 * changes `constantsHash()` and therefore needs a new epoch.
 */

import { createHash } from 'node:crypto';
import { dayBlockBootstrapLcb } from './day-bootstrap.js';

export const SEQ_CONSTANTS = {
    looks: [25, 50, 75, 100],
    lookConfidences: [0.99, 0.975, 0.96, 0.95],
    rejectConfidence: 0.95,
    minProfitFactor: 1.3,
    hardStopDrawdown: 0.05,
    bootstrap: { replicates: 10_000, seed: 42, minDays: 5, blockDays: 1 },
    ladder: { rungs: [0.25, 0.5, 0.75, 1.0], stepUpAt: [25, 50, 100], stepDownDrawdown: 0.05 },
    promotion: { minTrades: 30, minDays: 10 },
    band: { name: '60-74', minTrades: 20 },
} as const;

/** The subset of constants the look evaluator reads — injectable so the
 *  calibration script can measure ALTERNATIVE confidence schedules against
 *  the same procedure. Production always evaluates with SEQ_CONSTANTS. */
export interface LookConstants {
    looks: readonly number[];
    lookConfidences: readonly number[];
    rejectConfidence: number;
    minProfitFactor: number;
    bootstrap: { replicates: number; seed: number; minDays: number; blockDays: number };
}

function stableJson(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
    if (v !== null && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(v) ?? 'null';
}

/** 12-hex digest of the pre-registered constants (stored per epoch). */
export function constantsHash(): string {
    return createHash('sha256').update(stableJson(SEQ_CONSTANTS)).digest('hex').slice(0, 12);
}

export interface RTrade {
    id: string;
    /** ET calendar day of the entry fill (bootstrap cluster). */
    entryDay: string;
    /** Close time (epoch ms) — the look prefix is ordered by it. */
    closedAt: number;
    netR: number;
    netUsd: number;
    /** Commissions paid (USD) — the "variable costs doubled" check. */
    commissionsUsd?: number | null;
    band: '60-74' | '75+' | null;
    tradeClass: 'intraday' | 'swing' | 'earnings-bet';
    /** Four-lane contract (REQ-LANE-006): the lane; 'legacy' for rows
     *  created before the contract existed. */
    strategyId: 'intraday' | 'overnight' | 'swing' | 'cup-and-handle' | 'earnings-bet' | 'legacy';
    score?: number | null;
}

/** REQ-SEQ-001: net USD over the planned risk at entry. Null = the basis is
 *  missing (an integrity anomaly for the caller, never a zero). */
export function netRForRow(row: {
    realizedPnl: number;
    commissions: number | null;
    entryFillPrice: number | null;
    stop: number;
    quantity: number;
}): number | null {
    if (row.commissions === null || !Number.isFinite(row.commissions)) return null;
    if (row.entryFillPrice === null || !(row.entryFillPrice > 0)) return null;
    if (!(row.quantity > 0)) return null;
    const risk = Math.abs(row.entryFillPrice - row.stop) * row.quantity;
    if (!(risk > 0)) return null;
    return (row.realizedPnl - row.commissions) / risk;
}

/** REQ-SEQ-002: the look boundaries `n` has reached that are not yet done. */
export function lookBoundaryReached(n: number, done: readonly number[]): number[] {
    return SEQ_CONSTANTS.looks.filter((l) => n >= l && !done.includes(l));
}

/** Deterministic close order: by close time, ties by id. */
export function inCloseOrder(trades: readonly RTrade[]): RTrade[] {
    return [...trades].sort((a, b) => a.closedAt - b.closedAt || a.id.localeCompare(b.id));
}

function byDay(trades: readonly RTrade[]): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (const t of trades) {
        const arr = m.get(t.entryDay) ?? [];
        arr.push(t.netR);
        m.set(t.entryDay, arr);
    }
    return m;
}

function profitFactor(trades: readonly RTrade[]): number {
    let wins = 0, losses = 0;
    for (const t of trades) {
        if (t.netR > 0) wins += t.netR; else losses += -t.netR;
    }
    return losses > 0 ? wins / losses : (wins > 0 ? Number.POSITIVE_INFINITY : 0);
}

export type LookDecision = 'ACCEPT' | 'REJECT' | 'CONTINUE' | 'NOT-EVALUABLE';

export interface LookResult {
    lookN: number;
    /** Trades actually evaluated (the prefix; = lookN once reached). */
    n: number;
    days: number;
    lookConfidence: number;
    sumR: number;
    meanR: number;
    profitFactor: number;
    /** One-sided lower bound of mean R at `lookConfidence`; null = not evaluable. */
    lcb: number | null;
    /** One-sided 95 % upper bound of mean R (the REJECT rule). */
    ucb95: number | null;
    median: number | null;
    decision: LookDecision;
    reasons: string[];
}

/** REQ-SEQ-002/003: evaluate one look boundary on the first `lookN` trades
 *  in close order. Passing fewer than `lookN` trades evaluates what there is
 *  (callers only invoke at a reached boundary). */
export function evaluateLook(trades: readonly RTrade[], lookN: number, consts: LookConstants = SEQ_CONSTANTS): LookResult {
    const idx = consts.looks.indexOf(lookN);
    const lookConfidence = idx >= 0 ? consts.lookConfidences[idx] : consts.rejectConfidence;
    const prefix = inCloseOrder(trades).slice(0, lookN);
    const n = prefix.length;
    const sumR = prefix.reduce((s, t) => s + t.netR, 0);
    const meanR = n > 0 ? sumR / n : 0;
    const pf = profitFactor(prefix);
    const days = byDay(prefix);
    const b = consts.bootstrap;
    const low = dayBlockBootstrapLcb(days, { replicates: b.replicates, seed: b.seed, minDays: b.minDays, blockDays: b.blockDays, alpha: 1 - lookConfidence });
    const negated = new Map([...days.entries()].map(([d, rs]) => [d, rs.map((r) => -r)]));
    const upNeg = dayBlockBootstrapLcb(negated, { replicates: b.replicates, seed: b.seed, minDays: b.minDays, blockDays: b.blockDays, alpha: 1 - consts.rejectConfidence });
    const reasons: string[] = [];
    if (!low || !upNeg) {
        return {
            lookN, n, days: days.size, lookConfidence, sumR, meanR, profitFactor: pf, lcb: null, ucb95: null, median: null,
            decision: 'NOT-EVALUABLE', reasons: [`fewer than ${b.minDays} entry days (${days.size}) — a bound over so few days is theater`],
        };
    }
    const lcb = low.lcb;
    const ucb95 = -upNeg.lcb;
    let decision: LookDecision;
    if (lcb > 0 && sumR > 0 && pf >= consts.minProfitFactor) {
        decision = 'ACCEPT';
        reasons.push(`LCB ${lcb.toFixed(3)} > 0 at ${lookConfidence * 100}%`, `net R ${sumR.toFixed(2)} > 0`, `PF ${pf.toFixed(2)} ≥ ${consts.minProfitFactor}`);
    } else if (ucb95 < 0) {
        decision = 'REJECT';
        reasons.push(`95% upper bound ${ucb95.toFixed(3)} < 0`);
    } else {
        decision = 'CONTINUE';
        if (!(lcb > 0)) reasons.push(`LCB ${lcb.toFixed(3)} ≤ 0 at ${lookConfidence * 100}%`);
        if (!(sumR > 0)) reasons.push(`net R ${sumR.toFixed(2)} ≤ 0`);
        if (pf < consts.minProfitFactor) reasons.push(`PF ${pf.toFixed(2)} < ${consts.minProfitFactor}`);
        reasons.push(`95% upper bound ${ucb95.toFixed(3)} ≥ 0 — not rejected`);
    }
    return { lookN, n, days: days.size, lookConfidence, sumR, meanR, profitFactor: pf, lcb, ucb95, median: low.median, decision, reasons };
}

export interface RunningStats {
    n: number;
    days: number;
    sumR: number;
    meanR: number | null;
    profitFactor: number;
    netUsd: number;
    /** Net USD if every trade's commissions were doubled (spread/slippage
     *  proxy); null when a trade lacks its commissions. Informational. */
    netUsdCostsDoubled: number | null;
    nextLook: number | null;
    informational: true;
}

/** Between looks: running numbers, never a decision. */
export function runningStats(trades: readonly RTrade[]): RunningStats {
    const n = trades.length;
    const sumR = trades.reduce((s, t) => s + t.netR, 0);
    const commissionsKnown = trades.every((t) => typeof t.commissionsUsd === 'number' && Number.isFinite(t.commissionsUsd));
    const netUsd = trades.reduce((s, t) => s + t.netUsd, 0);
    return {
        n,
        days: byDay(trades).size,
        sumR,
        meanR: n > 0 ? sumR / n : null,
        profitFactor: profitFactor(trades),
        netUsd,
        netUsdCostsDoubled: n > 0 && commissionsKnown ? netUsd - trades.reduce((s, t) => s + (t.commissionsUsd ?? 0), 0) : null,
        nextLook: SEQ_CONSTANTS.looks.find((l) => l > n) ?? null,
        informational: true,
    };
}

export interface DifferenceBounds {
    days: number;
    lcb: number;
    median: number;
    meanDiff: number;
}

/** REQ-SEQ-006: the variant's DAILY summed R minus the incumbent's, over the
 *  incumbent's days (a variant day without rows contributes 0 — variants
 *  are subsets or re-geometries of the same sources); bootstrap by day.
 *  Null when the variant has rows on fewer than the bootstrap minimum days. */
export function dailyDifferenceBounds(variantDailyR: Map<string, number>, incumbentDailyR: Map<string, number>): DifferenceBounds | null {
    if (variantDailyR.size < SEQ_CONSTANTS.bootstrap.minDays) return null;
    const diffs = new Map<string, number[]>();
    for (const [day, inc] of incumbentDailyR) diffs.set(day, [(variantDailyR.get(day) ?? 0) - inc]);
    const b = SEQ_CONSTANTS.bootstrap;
    const r = dayBlockBootstrapLcb(diffs, { replicates: b.replicates, seed: b.seed, minDays: b.minDays, blockDays: b.blockDays, alpha: 0.05 });
    if (!r) return null;
    const all = [...diffs.values()].map((d) => d[0]);
    return { days: diffs.size, lcb: r.lcb, median: r.median, meanDiff: all.reduce((s, x) => s + x, 0) / all.length };
}

export interface LadderEligibility {
    eligible: boolean;
    nextRung: number | null;
    milestone: number | null;
    reason: string;
}

/** REQ-LADDER-001: may the ladder step up from `rung` at this evidence?
 *  `ceilingPct` (the ratified per-trade cap, `max_risk_per_trade_pct` of the
 *  live profile) refuses a rung the sizer would clamp anyway — effective
 *  risk is min(rung, ceiling), so such a step has no effect and is not
 *  offered (audit 2026-09-05, AUD-09). */
export function ladderEligibility(input: { n: number; sumR: number; rung: number; stopActive: boolean; ceilingPct?: number }): LadderEligibility {
    const rungs = SEQ_CONSTANTS.ladder.rungs as readonly number[];
    const idx = rungs.indexOf(input.rung);
    if (idx < 0) return { eligible: false, nextRung: null, milestone: null, reason: `rung ${input.rung} is not on the ladder` };
    if (idx === rungs.length - 1) return { eligible: false, nextRung: null, milestone: null, reason: 'top rung' };
    const nextRung = rungs[idx + 1];
    const milestone = SEQ_CONSTANTS.ladder.stepUpAt[idx];
    if (input.ceilingPct !== undefined && nextRung > input.ceilingPct + 1e-9) {
        return {
            eligible: false, nextRung, milestone,
            reason: `rung ${nextRung}% exceeds the ${input.ceilingPct}% per-trade ceiling (risk-rules.live.yaml) — effective risk stays min(rung, ceiling); a higher ceiling is a separate ratification`,
        };
    }
    if (input.n < milestone) return { eligible: false, nextRung, milestone, reason: `n ${input.n} < ${milestone}` };
    if (!(input.sumR > 0)) return { eligible: false, nextRung, milestone, reason: `net R ${input.sumR.toFixed(2)} not positive` };
    if (input.stopActive) return { eligible: false, nextRung, milestone, reason: 'an epoch stop is active' };
    return { eligible: true, nextRung, milestone, reason: `n ${input.n} ≥ ${milestone}, net R ${input.sumR >= 0 ? '+' : ''}${input.sumR.toFixed(2)}, no active stop` };
}

/** Effective per-trade risk under the ceiling policy (REQ-RISK-009/011). */
export function effectiveRiskPct(rung: number, ceilingPct: number): number {
    return Math.min(rung, ceilingPct);
}

/** REQ-LADDER-002: −5 % of marked NetLiq from the last step-up mark. */
export function stepDownDue(markedNetLiq: number, lastStepUpNetLiq: number | null): boolean {
    if (lastStepUpNetLiq === null || !(lastStepUpNetLiq > 0)) return false;
    return markedNetLiq <= lastStepUpNetLiq * (1 - SEQ_CONSTANTS.ladder.stepDownDrawdown);
}

/** REQ-SEQ-004: −5 % of marked NetLiq from the epoch NetLiq. */
export function hardStopDue(markedNetLiq: number, epochNetLiq: number): boolean {
    if (!(epochNetLiq > 0)) return false;
    return markedNetLiq <= epochNetLiq * (1 - SEQ_CONSTANTS.hardStopDrawdown);
}

export interface BandLine {
    band: string;
    n: number;
    netUsd: number;
    sumR: number;
    profitFactor: number;
    /** null = not yet judged (n below the pre-registered minimum). */
    barMet: boolean | null;
}

/** REQ-SEQ-007: the class the lowered bar admitted, judged apart. */
export function bandLine(trades: RTrade[], band: string = SEQ_CONSTANTS.band.name): BandLine {
    const rows = trades.filter((t) => t.band === band);
    const netUsd = rows.reduce((s, t) => s + t.netUsd, 0);
    const n = rows.length;
    return {
        band,
        n,
        netUsd,
        sumR: rows.reduce((s, t) => s + t.netR, 0),
        profitFactor: profitFactor(rows),
        barMet: n >= SEQ_CONSTANTS.band.minTrades ? netUsd >= 0 : null,
    };
}

// --- Spearman rank correlation with a t-approximation p-value -------------

function ranks(xs: number[]): number[] {
    const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const out = new Array<number>(xs.length);
    let i = 0;
    while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        const r = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) out[idx[k][1]] = r;
        i = j + 1;
    }
    return out;
}

function lgamma(z: number): number {
    const g = 7;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
        12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function incompleteBeta(a: number, b: number, x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    const cf = (aa: number, bb: number, xx: number): number => {
        let c = 1, d = 1 - (aa + bb) * xx / (aa + 1);
        if (Math.abs(d) < 1e-30) d = 1e-30;
        d = 1 / d;
        let h = d;
        for (let m = 1; m <= 200; m++) {
            const m2 = 2 * m;
            let an = m * (bb - m) * xx / ((aa + m2 - 1) * (aa + m2));
            d = 1 + an * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + an / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; h *= d * c;
            an = -(aa + m) * (aa + bb + m) * xx / ((aa + m2) * (aa + m2 + 1));
            d = 1 + an * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + an / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d;
            const del = d * c; h *= del;
            if (Math.abs(del - 1) < 3e-12) break;
        }
        return h;
    };
    return x < (a + 1) / (a + b + 2) ? bt * cf(a, b, x) / a : 1 - bt * cf(b, a, 1 - x) / b;
}

function studentTCdf(t: number, df: number): number {
    const x = df / (df + t * t);
    const p = 0.5 * incompleteBeta(df / 2, 0.5, x);
    return t >= 0 ? 1 - p : p;
}

/** Spearman rho over (score, outcome) pairs with a two-sided t-approx p. */
export function spearman(pairs: Array<[number, number]>): { rho: number; p: number; n: number } | null {
    const n = pairs.length;
    if (n < 3) return null;
    const rx = ranks(pairs.map((p) => p[0]));
    const ry = ranks(pairs.map((p) => p[1]));
    const mx = rx.reduce((s, v) => s + v, 0) / n;
    const my = ry.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
        sxy += (rx[i] - mx) * (ry[i] - my);
        sxx += (rx[i] - mx) ** 2;
        syy += (ry[i] - my) ** 2;
    }
    if (sxx === 0 || syy === 0) return { rho: 0, p: 1, n };
    const rho = sxy / Math.sqrt(sxx * syy);
    if (Math.abs(rho) >= 1) return { rho, p: 0, n };
    const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
    const p = 2 * (1 - studentTCdf(Math.abs(t), n - 2));
    return { rho, p: Math.max(0, Math.min(1, p)), n };
}
