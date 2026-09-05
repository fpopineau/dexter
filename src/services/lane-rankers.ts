/**
 * Lane rankers (REQ-DISC-001..003, WP8; audit AUD-08).
 *
 * One generic composite ranked every candidate for every consumer: the
 * Pre-Close Review picked overnight holds off a list built for intraday
 * momentum, and "score" meant different things in different lanes. A
 * score is comparable only inside its cohort, so each lane gets its own
 * VERSIONED, PURE ranker whose factors and weights live here, in code:
 *
 *   intraday        the engine's composite, unchanged, named `composite-v1`
 *                   (weight provenance: the scorer's `weightsSource`); the
 *                   trigger rank IS the intraday lane rank.
 *   overnight       `eod-continuation-v1` — significance of the day move in
 *                   daily-ATR units, closing strength vs VWAP toward the
 *                   direction, liquidity (dollar volume), RVOL; deterministic
 *                   exclusions with reasons (the WP7 eligibility rules).
 *   cup-and-handle  the detector's score, `detector-v1`.
 *   swing / earnings-bet   no lane rank (null).
 *
 * Nothing here is a probability. `laneRankFor` is what the proposals tool
 * stamps SERVER-SIDE on a proposal (the model never passes a rank); the
 * chronological harness (`scripts/validate-lane-ranker.ts`) is the
 * pre-registered pass any reweighting must clear.
 */

import type { StrategyId } from './lane-contract.js';

export const RANKER_VERSIONS = {
    intraday: 'composite-v1',
    overnight: 'eod-continuation-v1',
    'cup-and-handle': 'detector-v1',
} as const;

/** The candidate fields the rankers read (structural — no engine import, the engine imports this module). */
export interface RankableOpportunity {
    symbol: string;
    direction: 'long' | 'short';
    compositeRank: number;
    price: number | null;
    vwap: number | null;
    rvol: number | null;
    /** Signed toward `direction` (positive = with the move). */
    dayMovePct: number | null;
    /** Daily ATR as % of price (the engine's significance denominator). */
    dailyAtrPct: number | null;
    dollarVolume: number | null;
    stale: boolean;
}

export interface OvernightFactors {
    /** 0–40: |day move| / daily ATR %, linear to 3× ATR. */
    significance: number;
    /** 0–20: price vs VWAP toward the direction, linear to +2 %. */
    closingStrength: number;
    /** 0–20: log10 dollar volume, $1M → 0, $100M → 20. */
    liquidity: number;
    /** 0–20: RVOL, linear to 3×. */
    rvol: number;
}

export interface OvernightRanked {
    symbol: string;
    direction: 'long' | 'short';
    /** 0–100; null when excluded (see `reasons`). */
    score: number | null;
    factors: OvernightFactors | null;
    /** Exclusion reasons, or `note:` entries for missing optional inputs. */
    reasons: string[];
    /** The intraday composite, for context only. */
    compositeRank: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const r1 = (n: number) => Math.round(n * 10) / 10;

/** REQ-DISC-001: the EOD-continuation ranker, pure and versioned. */
export function scoreOvernight(o: RankableOpportunity): OvernightRanked {
    const reasons: string[] = [];
    if (o.stale) reasons.push('stale-data');
    if (o.price === null || !(o.price > 0)) reasons.push('price-missing');
    if (o.dailyAtrPct === null || !(o.dailyAtrPct > 0)) reasons.push('atr-missing');
    if (o.dayMovePct === null) reasons.push('day-move-unknown');
    else if (o.dayMovePct <= 0) reasons.push('counter-move');
    if (reasons.length > 0) {
        return { symbol: o.symbol, direction: o.direction, score: null, factors: null, reasons, compositeRank: o.compositeRank };
    }
    const price = o.price as number;
    const significance = 40 * clamp01(((o.dayMovePct as number) / (o.dailyAtrPct as number)) / 3);
    let closingStrength = 0;
    if (o.vwap !== null && o.vwap > 0) {
        const strengthPct = ((price - o.vwap) / o.vwap) * 100 * (o.direction === 'long' ? 1 : -1);
        closingStrength = 20 * clamp01(strengthPct / 2);
    } else reasons.push('note:vwap-missing');
    let liquidity = 0;
    if (o.dollarVolume !== null && o.dollarVolume > 0) liquidity = 20 * clamp01((Math.log10(o.dollarVolume) - 6) / 2);
    else reasons.push('note:dollar-volume-missing');
    let rvol = 0;
    if (o.rvol !== null && o.rvol > 0) rvol = 20 * clamp01(o.rvol / 3);
    else reasons.push('note:rvol-missing');
    const factors: OvernightFactors = { significance: r1(significance), closingStrength: r1(closingStrength), liquidity: r1(liquidity), rvol: r1(rvol) };
    const score = Math.round(factors.significance + factors.closingStrength + factors.liquidity + factors.rvol);
    return { symbol: o.symbol, direction: o.direction, score, factors, reasons, compositeRank: o.compositeRank };
}

/** Ranked overnight universe: scored rows by score desc, excluded rows last (by composite). */
export function rankOvernight(opps: RankableOpportunity[]): OvernightRanked[] {
    return opps.map(scoreOvernight).sort((a, b) => {
        if (a.score === null && b.score === null) return b.compositeRank - a.compositeRank;
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return (b.score - a.score) || (b.compositeRank - a.compositeRank);
    });
}

export interface SnapshotLanes {
    overnight: { rankerVersion: string; ranked: OvernightRanked[] };
}

/** REQ-DISC-002: the per-lane rankings a snapshot carries (additive). */
export function buildSnapshotLanes(opps: RankableOpportunity[]): SnapshotLanes {
    return { overnight: { rankerVersion: RANKER_VERSIONS.overnight, ranked: rankOvernight(opps) } };
}

export interface LaneRankSources {
    /** The firing rank of a trigger-lane run (null off the trigger lane). */
    triggerRank: number | null;
    snapshot: { opportunities: Array<{ symbol: string; compositeRank: number }>; lanes?: SnapshotLanes } | null;
    patternScan: { candidates: Array<{ symbol: string; matches: Array<{ pattern: string; score: number }> }> } | null;
}

export interface LaneRankProvenance {
    laneRank: number | null;
    rankerVersion: string | null;
}

/** REQ-DISC-003: the lane rank and its provenance for a proposal, resolved
 *  server-side from the run context, the latest snapshot and the pattern
 *  scan — never from the model. A symbol the ranker never saw gets a null
 *  rank with the version that would have applied (recorded, not guessed). */
export function laneRankFor(strategyId: StrategyId, symbol: string, sources: LaneRankSources): LaneRankProvenance {
    const sym = symbol.toUpperCase();
    switch (strategyId) {
        case 'intraday': {
            const fromSnapshot = sources.snapshot?.opportunities.find((o) => o.symbol.toUpperCase() === sym)?.compositeRank ?? null;
            return { laneRank: sources.triggerRank ?? fromSnapshot, rankerVersion: RANKER_VERSIONS.intraday };
        }
        case 'overnight': {
            const lane = sources.snapshot?.lanes?.overnight;
            const row = lane?.ranked.find((r) => r.symbol.toUpperCase() === sym);
            return { laneRank: row?.score ?? null, rankerVersion: lane?.rankerVersion ?? RANKER_VERSIONS.overnight };
        }
        case 'cup-and-handle': {
            const c = sources.patternScan?.candidates.find((x) => x.symbol.toUpperCase() === sym);
            const cup = c?.matches.find((m) => m.pattern === 'cup-and-handle');
            return { laneRank: cup?.score ?? null, rankerVersion: RANKER_VERSIONS['cup-and-handle'] };
        }
        case 'swing':
        case 'earnings-bet':
            return { laneRank: null, rankerVersion: null };
        default: {
            const _exhaustive: never = strategyId;
            throw new Error(`unhandled lane ${String(_exhaustive)}`);
        }
    }
}
