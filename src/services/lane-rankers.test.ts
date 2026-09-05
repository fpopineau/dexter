import { describe, expect, test } from 'bun:test';
import { buildSnapshotLanes, laneRankFor, RANKER_VERSIONS, rankOvernight, scoreOvernight, type RankableOpportunity } from './lane-rankers.js';

function opp(over: Partial<RankableOpportunity> = {}): RankableOpportunity {
    return { symbol: 'MU', direction: 'long', compositeRank: 78, price: 100, vwap: 99, rvol: 2, dayMovePct: 6, dailyAtrPct: 3, dollarVolume: 1e8, stale: false, ...over };
}

describe('scoreOvernight (REQ-DISC-001 — eod-continuation-v1 factor pins)', () => {
    test('a strong continuation: 2× ATR move (26.7), +1.01% above VWAP (10.1), $100M (20), RVOL 2 (13.3) → 70', () => {
        const r = scoreOvernight(opp());
        expect(r.factors).toEqual({ significance: 26.7, closingStrength: 10.1, liquidity: 20, rvol: 13.3 });
        expect(r.score).toBe(70);
        expect(r.reasons).toEqual([]);
    });

    test('caps: 3× ATR, +2% vs VWAP, $100M+, RVOL 3+ → 100; a short is mirrored (below VWAP is strength)', () => {
        expect(scoreOvernight(opp({ dayMovePct: 12, dailyAtrPct: 3, vwap: 98, dollarVolume: 5e9, rvol: 4 })).score).toBe(100);
        const s = scoreOvernight(opp({ direction: 'short', price: 100, vwap: 101, dayMovePct: 6 }));
        expect(s.factors?.closingStrength).toBe(9.9); // 0.99% below VWAP toward the short
        expect(scoreOvernight(opp({ direction: 'short', price: 100, vwap: 99 })).factors?.closingStrength).toBe(0); // above VWAP: no strength for a short
    });

    test('exclusions carry their reason and no score; missing optional inputs score zero with a note', () => {
        expect(scoreOvernight(opp({ stale: true })).reasons).toEqual(['stale-data']);
        expect(scoreOvernight(opp({ price: null, dailyAtrPct: null })).reasons).toEqual(['price-missing', 'atr-missing']);
        expect(scoreOvernight(opp({ dayMovePct: null })).reasons).toEqual(['day-move-unknown']);
        const counter = scoreOvernight(opp({ dayMovePct: -1 }));
        expect(counter).toMatchObject({ score: null, factors: null, reasons: ['counter-move'] });
        const thin = scoreOvernight(opp({ vwap: null, dollarVolume: null, rvol: null }));
        expect(thin.score).toBe(27);
        expect(thin.reasons).toEqual(['note:vwap-missing', 'note:dollar-volume-missing', 'note:rvol-missing']);
    });
});

describe('rankOvernight + buildSnapshotLanes (REQ-DISC-002)', () => {
    test('scored rows by score desc, excluded rows last by composite; the snapshot lane carries the version', () => {
        const ranked = rankOvernight([
            opp({ symbol: 'A', dayMovePct: 3 }),                 // sig 13.3 → 56
            opp({ symbol: 'B' }),                                  // 70
            opp({ symbol: 'C', dayMovePct: -2, compositeRank: 90 }),
            opp({ symbol: 'D', stale: true, compositeRank: 95 }),
        ]);
        expect(ranked.map((r) => [r.symbol, r.score])).toEqual([['B', 70], ['A', 57], ['D', null], ['C', null]]);
        const lanes = buildSnapshotLanes([opp()]);
        expect(lanes.overnight.rankerVersion).toBe(RANKER_VERSIONS.overnight);
        expect(lanes.overnight.ranked[0].score).toBe(70);
    });
});

describe('laneRankFor (REQ-DISC-003 — server-side provenance, same symbol and direction only)', () => {
    const snapshot = { opportunities: [{ symbol: 'MU', direction: 'long' as const, compositeRank: 78 }], lanes: buildSnapshotLanes([opp()]) };
    const patternScan = { candidates: [{ symbol: 'CUP1', matches: [{ pattern: 'flat-base', score: 80 }, { pattern: 'cup-and-handle', score: 72 }] }] };
    const none = { triggerRank: null, triggerSymbol: null, triggerDirection: null };
    test('intraday: the trigger rank for the trigger symbol, else the composite; overnight: the lane score; cup: the detector score; swing/bet: none', () => {
        expect(laneRankFor('intraday', 'MU', 'long', { triggerRank: 66, triggerSymbol: 'MU', triggerDirection: 'long', snapshot, patternScan })).toEqual({ laneRank: 66, rankerVersion: 'composite-v1' });
        expect(laneRankFor('intraday', 'mu', 'long', { ...none, snapshot, patternScan })).toEqual({ laneRank: 78, rankerVersion: 'composite-v1' });
        expect(laneRankFor('overnight', 'MU', 'long', { ...none, snapshot, patternScan })).toEqual({ laneRank: 70, rankerVersion: 'eod-continuation-v1' });
        expect(laneRankFor('cup-and-handle', 'CUP1', 'long', { ...none, snapshot, patternScan })).toEqual({ laneRank: 72, rankerVersion: 'detector-v1' });
        expect(laneRankFor('swing', 'MU', 'long', { triggerRank: 66, triggerSymbol: 'MU', triggerDirection: 'long', snapshot, patternScan })).toEqual({ laneRank: null, rankerVersion: null });
        expect(laneRankFor('earnings-bet', 'MU', 'long', { ...none, snapshot, patternScan })).toEqual({ laneRank: null, rankerVersion: null });
    });

    test('review 2026-09-06 finding 10: another symbol in the trigger run does NOT inherit the trigger rank; a short on a long-ranked symbol gets no rank', () => {
        // MSFT proposed inside the MU trigger run (rank 95): MSFT takes its own composite (absent → null), never 95
        expect(laneRankFor('intraday', 'MSFT', 'long', { triggerRank: 95, triggerSymbol: 'MU', triggerDirection: 'long', snapshot, patternScan })).toEqual({ laneRank: null, rankerVersion: 'composite-v1' });
        // a trigger rank without a symbol cannot be attributed
        expect(laneRankFor('intraday', 'MU', 'long', { triggerRank: 95, triggerSymbol: null, triggerDirection: 'long', snapshot, patternScan })).toEqual({ laneRank: 78, rankerVersion: 'composite-v1' });
        // second pass, finding 6: a SHORT proposal on the symbol whose LONG trigger fired (rank 95) inherits nothing — not the trigger rank, not the long composite
        expect(laneRankFor('intraday', 'MU', 'short', { triggerRank: 95, triggerSymbol: 'MU', triggerDirection: 'long', snapshot, patternScan })).toEqual({ laneRank: null, rankerVersion: 'composite-v1' });
        // a trigger without a recorded direction cannot be attributed either
        expect(laneRankFor('intraday', 'MU', 'long', { triggerRank: 95, triggerSymbol: 'MU', triggerDirection: null, snapshot, patternScan })).toEqual({ laneRank: 78, rankerVersion: 'composite-v1' });
        // direction: the snapshot ranked MU long; a short proposal takes no rank from it
        expect(laneRankFor('intraday', 'MU', 'short', { ...none, snapshot, patternScan })).toEqual({ laneRank: null, rankerVersion: 'composite-v1' });
        expect(laneRankFor('overnight', 'MU', 'short', { ...none, snapshot, patternScan })).toEqual({ laneRank: null, rankerVersion: 'eod-continuation-v1' });
    });

    test('a symbol the ranker never saw: null rank, the version recorded', () => {
        expect(laneRankFor('overnight', 'XYZ', 'long', { ...none, snapshot, patternScan })).toEqual({ laneRank: null, rankerVersion: 'eod-continuation-v1' });
        expect(laneRankFor('overnight', 'MU', 'long', { ...none, snapshot: null, patternScan: null })).toEqual({ laneRank: null, rankerVersion: 'eod-continuation-v1' });
        expect(laneRankFor('intraday', 'XYZ', 'long', { ...none, snapshot, patternScan })).toEqual({ laneRank: null, rankerVersion: 'composite-v1' });
    });
});
