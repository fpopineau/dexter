/**
 * Daily digest (REQ-DIGEST-001..005, live-loop WP3) — four sections, each
 * ≤ 12 lines on WhatsApp, the full tables behind `/api/loop`:
 *   1. fills and slippage vs plan (+ the incumbent twin's fill)
 *   2. funnel counts per lane, refusal split by gate, spend-cap refusals, LLM USD
 *   3. shadow-vs-incumbent per variant + the '60-74' band line
 *   4. test status: epoch, n, R, PF, bounds, drawdown, next look, rung, stop, deciles
 * Pure builders over fetched inputs; the nightly runner supplies them.
 */

import type { SpendLedger } from '../llm-spend.js';
import type { SimTrade } from '../simulator/store.js';
import type { RefusalRecord, TradeProposal } from '../trade-proposals.js';
import type { LoopStatus } from './looks.js';

export const MAX_SECTION_LINES = 12;

export interface DigestInputs {
    today: string;
    dayStartMs: number;
    status: LoopStatus;
    proposalsToday: TradeProposal[];
    refusalsToday: RefusalRecord[];
    triggersToday: { single: number; breadth: number };
    scannedToday: number;
    spend: SpendLedger | null;
    /** incumbent twins keyed by proposal id (fill comparison). */
    twins: Map<string, SimTrade>;
}

export interface LoopDigest {
    today: string;
    sections: { fills: string[]; funnel: string[]; shadow: string[]; status: string[] };
    json: Record<string, unknown>;
}

const bps = (plan: number | null, fill: number | null): string => {
    if (plan === null || fill === null || !(plan > 0)) return '—';
    return `${(((fill - plan) / plan) * 10_000).toFixed(1)}bps`;
};
const usd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`);
const num = (n: number | null | undefined, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? (n === Number.POSITIVE_INFINITY ? '∞' : '—') : n.toFixed(d));

export function buildFillsSection(inp: DigestInputs): string[] {
    const filled = inp.proposalsToday.filter((p) => p.entryFilledAt !== null && p.entryFilledAt >= inp.dayStartMs);
    const lines: string[] = [];
    let netUsd = 0;
    for (const p of filled) {
        const twin = inp.twins.get(p.id);
        const exitPlan = p.exitReason === 'target' ? p.target : p.exitReason === 'stop' ? p.stop : null;
        const net = p.realizedPnl !== null ? p.realizedPnl - (p.commissions ?? 0) : null;
        if (net !== null) netUsd += net;
        lines.push(
            `${p.symbol} ${p.direction} ×${p.quantity}: entry ${num(p.entry)}→${num(p.entryFillPrice)} (${bps(p.entry, p.entryFillPrice)})` +
            `${p.exitFillPrice !== null ? `, exit ${exitPlan !== null ? `${num(exitPlan)}→` : ''}${num(p.exitFillPrice)} ${p.exitReason ?? ''}` : ', open'}` +
            `${p.commissions !== null ? `, comm $${p.commissions.toFixed(2)}` : ''}${net !== null ? `, net ${usd(net)}` : ''}` +
            `${twin?.fillPrice != null ? ` · twin fill ${num(twin.fillPrice)} ${twin.outcome}` : ''}`,
        );
    }
    const head = `Fills today: ${filled.length}${filled.length ? `, net ${usd(netUsd)}` : ''}` +
        `${inp.status.sample ? ` · epoch n ${inp.status.sample.n}, net ${usd(inp.status.sample.netUsd)}, ΣR ${num(inp.status.sample.sumR)}` : ''}`;
    return [head, ...lines];
}

export function buildFunnelSection(inp: DigestInputs): string[] {
    const byLane = new Map<string, { proposed: number; executed: number }>();
    for (const p of inp.proposalsToday) {
        const lane = p.source.startsWith('cron:') ? p.source : p.source;
        const e = byLane.get(lane) ?? { proposed: 0, executed: 0 };
        e.proposed++;
        if (p.executedAt !== null && p.executedAt >= inp.dayStartMs) e.executed++;
        byLane.set(lane, e);
    }
    const byGate = new Map<string, number>();
    for (const r of inp.refusalsToday) byGate.set(r.gate, (byGate.get(r.gate) ?? 0) + 1);
    const spendCapRefusals = byGate.get('spend-cap') ?? 0;
    const triggered = inp.triggersToday.single + inp.triggersToday.breadth;
    const evaluated = Math.max(0, triggered - spendCapRefusals);
    const executed = [...byLane.values()].reduce((s, e) => s + e.executed, 0);
    const lines = [
        `Funnel: scanned ${inp.scannedToday} → triggered ${triggered} (single ${inp.triggersToday.single}, breadth ${inp.triggersToday.breadth}) → evaluated ${evaluated} → proposed ${inp.proposalsToday.length} → executed ${executed}`,
        `Lanes: ${[...byLane.entries()].map(([l, e]) => `${l} ${e.proposed}/${e.executed}`).join(', ') || 'none'}`,
        `Refusals by gate: ${[...byGate.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ${n}`).join(', ') || 'none'}`,
        `LLM: ${inp.spend ? `$${inp.spend.totalUsd.toFixed(2)} today (${Object.values(inp.spend.byLane).reduce((s, l) => s + l.runs, 0)} runs)` : 'no spend recorded'}${spendCapRefusals ? ` · spend-cap refusals ${spendCapRefusals}` : ''}`,
    ];
    return lines;
}

export function buildShadowSection(inp: DigestInputs): string[] {
    const lines: string[] = [];
    for (const s of inp.status.shadow) {
        if (s.status !== 'active') { lines.push(`${s.variant}: ${s.status}`); continue; }
        if (!s.summary) { lines.push(`${s.variant}: no rows yet`); continue; }
        lines.push(
            `${s.variant}: n ${s.summary.n} (${s.summary.days}d) ΣR ${num(s.summary.sumR)} meanR ${num(s.summary.meanR)}` +
            `${s.diff ? ` · vs incumbent daily ΔR LCB ${num(s.diff.lcb, 3)} med ${num(s.diff.median, 3)}` : ''}` +
            `${s.candidate ? ' · PROMOTION CANDIDATE' : ''}`,
        );
    }
    if (inp.status.band) {
        const b = inp.status.band;
        lines.push(`band '${b.band}': n ${b.n}, net ${usd(b.netUsd)}, ΣR ${num(b.sumR)}, PF ${num(b.profitFactor)} — bar ${b.barMet === null ? `not yet judged (n < 20)` : b.barMet ? 'MET (net ≥ 0)' : 'NOT MET (net < 0)'}`);
    }
    return lines;
}

export function buildStatusSection(inp: DigestInputs): string[] {
    const st = inp.status;
    const lines: string[] = [];
    if (!st.epoch) return ["No epoch started — reply 'epoch new' to open epoch 1."];
    const e = st.epoch;
    lines.push(`${e.id} ${e.status.toUpperCase()}${e.stopReason ? ` — ${e.stopReason}` : ''} · fp ${e.fingerprint || '?'} · constants ${st.constantsOk ? 'ok' : 'CHANGED'}${e.firstAcceptAt ? ` · ACCEPT recorded ${new Date(e.firstAcceptAt).toISOString().slice(0, 10)}` : ''}`);
    if (st.sample) {
        lines.push(`Deployable: n ${st.sample.n} (${st.sample.days}d), ΣR ${num(st.sample.sumR)}, meanR ${num(st.sample.meanR)}, PF ${num(st.sample.profitFactor)}, net ${usd(st.sample.netUsd)}, open in cohort ${st.openInCohort}${st.sample.nextLook ? ` · next look at n=${st.sample.nextLook} (INFORMATIONAL until then)` : ' · all looks done'}`);
    }
    for (const l of st.looksThisPass) {
        lines.push(`LOOK n=${l.lookN}: ${l.decision} — LCB ${num(l.lcb, 3)} @${l.lookConfidence * 100}%, UCB95 ${num(l.ucb95, 3)}; ${l.reasons.join('; ')}`);
    }
    if (st.looksThisPass.length === 0 && e.looks.length) {
        const last = e.looks[e.looks.length - 1];
        lines.push(`Last look n=${last.n}: ${last.decision} (LCB ${num(last.lcb, 3)}, UCB95 ${num(last.ucb95, 3)})`);
    }
    if (st.drawdown) lines.push(`Drawdown from epoch: ${st.drawdown.pct.toFixed(2)}% (min $${st.drawdown.minNetLiq.toFixed(0)} vs $${st.drawdown.epochNetLiq.toFixed(0)}, ${st.drawdown.samples} samples; hard stop at −5%)`);
    lines.push(`Ladder: rung ${st.ladder.rung}% · effective risk ${st.ladder.effectivePct}% (ceiling ${st.ladder.ceilingPct}%)${st.ladder.state?.lastStepUpNetLiq ? ` · step-down mark $${st.ladder.state.lastStepUpNetLiq.toFixed(0)}` : ''}${st.ladder.eligibility ? ` · ${st.ladder.eligibility.eligible ? `STEP-UP to ${st.ladder.eligibility.nextRung}% ELIGIBLE — 'ladder up'` : st.ladder.eligibility.reason.includes('ceiling') ? `at the ceiling — no further rung has effect` : `next ${st.ladder.eligibility.nextRung ?? '—'}% at n ≥ ${st.ladder.eligibility.milestone ?? '—'}`}` : ''}`);
    if (st.shadowSample) lines.push(`Shadow-only classes (apart): n ${st.shadowSample.n}, ΣR ${num(st.shadowSample.sumR)}, net ${usd(st.shadowSample.netUsd)}`);
    // REQ-LANE-006: one line per lane with rows (the verdict stays on the deployable sample).
    if (st.lanes.length) lines.push(`Lanes: ${st.lanes.map((l) => `${l.strategyId} n ${l.stats.n} ΣR ${num(l.stats.sumR)} PF ${num(l.stats.profitFactor)}`).join(' · ')}`);
    if (st.models.length) lines.push(`Judgment: ${st.models.join(', ')}`);
    lines.push(`Score deciles: ${st.decile ? `Spearman rho ${st.decile.rho.toFixed(2)} (p ${st.decile.p.toFixed(3)}, n ${st.decile.n})` : 'n/a'}`);
    if (e.promotionPending) lines.push(`Promotion pending: ${e.promotionPending.variant} — apply the change, restart, 'epoch new'`);
    for (const a of st.anomalies) lines.push(`⚠ ${a}`);
    return lines;
}

/** Keep a WhatsApp section to the cap, saying how many lines were cut. */
export function truncateSection(lines: string[], max = MAX_SECTION_LINES): string[] {
    if (lines.length <= max) return lines;
    return [...lines.slice(0, max - 1), `… ${lines.length - (max - 1)} more line(s) on the dashboard /api/loop`];
}

export function buildDigest(inp: DigestInputs): LoopDigest {
    const fills = buildFillsSection(inp);
    const funnel = buildFunnelSection(inp);
    const shadow = buildShadowSection(inp);
    const status = buildStatusSection(inp);
    return {
        today: inp.today,
        sections: { fills, funnel, shadow, status },
        json: {
            today: inp.today,
            status: inp.status,
            fills: fills,
            funnel: funnel,
            shadow: shadow,
            statusLines: status,
        },
    };
}

export function formatDigestWhatsApp(d: LoopDigest): string {
    const sec = (title: string, lines: string[]) => [`*${title}*`, ...truncateSection(lines).map((l) => `• ${l}`)].join('\n');
    return [
        `📋 Loop digest ${d.today}`,
        sec('Fills & slippage', d.sections.fills),
        sec('Funnel', d.sections.funnel),
        sec('Shadow vs incumbent', d.sections.shadow),
        sec('Test status', d.sections.status),
    ].join('\n\n');
}
