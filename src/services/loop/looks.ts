/**
 * Nightly looks (REQ-SEQ-002..007, REQ-EPOCH-002/003, REQ-LADDER-001,
 * live-loop WP3) — the epoch's pre-registered evaluation, run as the tail
 * of the nightly pipeline (settle → LOOKS → digest) and on demand
 * (`validation-scorecard.ts --look`).
 *
 * Each pass: rebuild the epoch sample, check integrity (constants hash,
 * planned-risk anomalies, an EOD triage stamped `failed` today), evaluate
 * every look boundary `n` has newly reached — ONCE each, recorded in the
 * epoch — apply the decision (ACCEPT recorded as the cutover evidence,
 * REJECT stops the epoch), queue the ladder step-up when eligible, and
 * compute the shadow-vs-incumbent difference bounds plus the '60-74' band
 * line. Between boundaries the numbers are INFORMATIONAL and never decide.
 */

import type { EquitySample } from '@/utils/equity-series-math.js';
import {
    bandLine,
    constantsHash,
    dailyDifferenceBounds,
    evaluateLook,
    hardStopDue,
    ladderEligibility,
    lookBoundaryReached,
    runningStats,
    SEQ_CONSTANTS,
    spearman,
    type BandLine,
    type DifferenceBounds,
    type LadderEligibility,
    type LookResult,
    type RunningStats,
} from '@/utils/sequential-test.js';
import { etDayOf } from '@/utils/equity-series-math.js';
import { readLadderState, BOTTOM_RUNG, type LadderState } from '../ladder-state.js';
import { summarizeVariants, type VariantSummary } from '../simulator/report.js';
import type { SimTrade } from '../simulator/store.js';
import { VARIANTS_V1 } from '../simulator/variants.js';
import { readEpochRecord, recordStepUpEligibility, stopEpoch, writeEpochRecord, type LoopEpochRecord } from './epoch-control.js';
import type { EpochSample } from './sample.js';

export interface ShadowLine {
    variant: string;
    status: string;
    summary: VariantSummary | null;
    diff: DifferenceBounds | null;
    candidate: boolean;
}

export interface LoopStatus {
    at: number;
    epoch: LoopEpochRecord | null;
    constantsOk: boolean;
    sample: RunningStats | null;
    shadowSample: RunningStats | null;
    openInCohort: number;
    /** Looks evaluated in THIS pass (usually none or one). */
    looksThisPass: LookResult[];
    band: BandLine | null;
    shadow: ShadowLine[];
    ladder: { state: LadderState | null; rung: number; eligibility: LadderEligibility | null };
    drawdown: { epochNetLiq: number; minNetLiq: number; pct: number; samples: number } | null;
    anomalies: string[];
    decile: { rho: number; p: number; n: number } | null;
    stoppedThisPass: string | null;
}

export interface LooksDeps {
    now: number;
    dataDir?: string;
    loadSample: (epochStartMs: number) => Promise<EpochSample>;
    listSimRows: (sinceMs: number) => Promise<SimTrade[]>;
    equitySeries: () => EquitySample[];
    /** Today's EOD triage run stamped 'failed' (an unresolved broker anomaly). */
    triageFailedToday: () => boolean;
    journal: (line: string) => void;
    alert?: (message: string) => void;
}

function dailyRByVariant(rows: SimTrade[]): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>();
    for (const r of rows) {
        if (r.status !== 'settled' || r.netR === null) continue;
        const days = out.get(r.variant) ?? new Map<string, number>();
        const day = etDayOf(r.createdAt);
        days.set(day, (days.get(day) ?? 0) + r.netR);
        out.set(r.variant, days);
    }
    return out;
}

/** REQ-SEQ-006: per-variant summaries and difference bounds vs the incumbent. */
export function shadowLines(rows: SimTrade[]): ShadowLine[] {
    const summaries = new Map(summarizeVariants(rows).map((s) => [s.variant, s]));
    const daily = dailyRByVariant(rows);
    const incumbent = daily.get('incumbent') ?? new Map<string, number>();
    return VARIANTS_V1.map((v) => {
        const summary = summaries.get(v.name) ?? null;
        const diff = v.name !== 'incumbent' && summary ? dailyDifferenceBounds(daily.get(v.name) ?? new Map(), incumbent) : null;
        const candidate = !!summary && !!diff
            && summary.n >= SEQ_CONSTANTS.promotion.minTrades
            && summary.days >= SEQ_CONSTANTS.promotion.minDays
            && diff.lcb > 0;
        return { variant: v.name, status: v.status, summary, diff, candidate };
    });
}

export async function runNightlyLooks(deps: LooksDeps): Promise<LoopStatus> {
    const rec = readEpochRecord(deps.dataDir);
    const ladderState = readLadderState(deps.dataDir);
    const base: LoopStatus = {
        at: deps.now, epoch: rec, constantsOk: true, sample: null, shadowSample: null, openInCohort: 0, looksThisPass: [],
        band: null, shadow: [], ladder: { state: ladderState, rung: ladderState?.rung ?? BOTTOM_RUNG, eligibility: null },
        drawdown: null, anomalies: [], decile: null, stoppedThisPass: null,
    };
    if (!rec) {
        base.anomalies.push('no epoch started — `epoch new` opens epoch 1 (the looks evaluate nothing until then)');
        return base;
    }

    const sample = await deps.loadSample(rec.startedAt);
    const anomalies = [...sample.anomalies];
    const constantsOk = rec.constantsHash === constantsHash();
    if (!constantsOk) anomalies.push(`sequential-test constants changed since the epoch started (${rec.constantsHash} → ${constantsHash()}) — looks NOT EVALUABLE until a new epoch`);
    const triageFailed = deps.triageFailedToday();
    if (triageFailed) anomalies.push("EOD triage stamped 'failed' today — unresolved broker anomaly");

    // Drawdown from the epoch NetLiq over the marked series.
    let drawdown: LoopStatus['drawdown'] = null;
    if (rec.netLiq !== null) {
        const win = deps.equitySeries().filter((s) => s.ts >= rec.startedAt && s.ts <= deps.now);
        if (win.length > 0) {
            const minNetLiq = Math.min(...win.map((s) => s.netLiq));
            drawdown = { epochNetLiq: rec.netLiq, minNetLiq, pct: (minNetLiq / rec.netLiq - 1) * 100, samples: win.length };
        }
    }

    let stoppedThisPass: string | null = null;
    let current = rec;
    const stop = (reason: string) => {
        const s = stopEpoch({ now: deps.now, dataDir: deps.dataDir, reason, journal: deps.journal, alert: deps.alert });
        if (s) { current = s; stoppedThisPass = reason; }
    };

    if (current.status === 'running') {
        if (triageFailed) stop("unresolved broker anomaly: today's EOD triage stamped 'failed'");
        else if (drawdown && rec.netLiq !== null && hardStopDue(drawdown.minNetLiq, rec.netLiq)) {
            stop(`-5% hard stop (nightly re-check): marked NetLiq $${drawdown.minNetLiq.toFixed(2)} ≤ 95% of the epoch NetLiq $${rec.netLiq.toFixed(2)}`);
        }
    }

    const stats = runningStats(sample.trades);
    const band = bandLine(sample.trades);
    const looksThisPass: LookResult[] = [];
    if (current.status === 'running' && constantsOk && sample.anomalies.length === 0) {
        for (const boundary of lookBoundaryReached(stats.n, current.looksDone)) {
            let look = evaluateLook(sample.trades, boundary);
            // REQ-SEQ-007: the admitted band must not read negative at n ≥ 20
            // for an ACCEPT to stand.
            if (look.decision === 'ACCEPT' && band.barMet === false) {
                look = { ...look, decision: 'CONTINUE', reasons: [...look.reasons, `'${band.band}' band reads net $${band.netUsd.toFixed(0)} over ${band.n} trades — ACCEPT withheld (REQ-SEQ-007)`] };
            }
            looksThisPass.push(look);
            const next: LoopEpochRecord = {
                ...current,
                looksDone: [...current.looksDone, boundary],
                looks: [...current.looks, { n: look.n, at: deps.now, decision: look.decision, lcb: look.lcb, ucb95: look.ucb95, sumR: look.sumR, profitFactor: look.profitFactor }],
                ...(look.decision === 'ACCEPT' && current.firstAcceptAt === undefined ? { firstAcceptAt: deps.now } : {}),
            };
            writeEpochRecord(next, deps.dataDir);
            current = next;
            deps.journal(`${current.id} LOOK n=${boundary}: ${look.decision} — LCB ${look.lcb?.toFixed(3) ?? '—'} @${look.lookConfidence * 100}%, UCB95 ${look.ucb95?.toFixed(3) ?? '—'}, net R ${look.sumR.toFixed(2)}, PF ${Number.isFinite(look.profitFactor) ? look.profitFactor.toFixed(2) : '∞'}`);
            if (look.decision === 'ACCEPT' && next.firstAcceptAt === deps.now) {
                deps.alert?.(`✅ ${current.id} look n=${boundary} ACCEPT — the pre-registered cutover evidence is in hand (${look.reasons.join('; ')}). 'live on' is your call.`);
            }
            if (look.decision === 'REJECT') {
                stop(`REJECT look at n=${boundary}: ${look.reasons.join('; ')}`);
                break;
            }
        }
    }

    // Ladder eligibility (queued; the operator applies it).
    const eligibility = ladderEligibility({ n: stats.n, sumR: stats.sumR, rung: ladderState?.rung ?? BOTTOM_RUNG, stopActive: current.status === 'stopped' });
    recordStepUpEligibility(eligibility, deps.now, deps.dataDir);

    const simRows = await deps.listSimRows(rec.startedAt);
    const decilePairs = sample.trades.filter((t) => t.score != null).map((t) => [t.score as number, t.netR] as [number, number]);

    return {
        ...base,
        epoch: readEpochRecord(deps.dataDir) ?? current,
        constantsOk,
        sample: stats,
        shadowSample: sample.shadowTrades.length ? runningStats(sample.shadowTrades) : null,
        openInCohort: sample.openInCohort,
        looksThisPass,
        band,
        shadow: shadowLines(simRows),
        ladder: { state: readLadderState(deps.dataDir), rung: ladderState?.rung ?? BOTTOM_RUNG, eligibility },
        drawdown,
        anomalies,
        decile: spearman(decilePairs),
        stoppedThisPass,
    };
}
