import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RULES, type RiskRules } from '@/tools/ibkr/risk-rules.js';

const dir = mkdtempSync(join(tmpdir(), 'dexter-candidates-'));
const prev = process.env.DEXTER_DATA_DIR;
process.env.DEXTER_DATA_DIR = dir;

import {
    candidatesFromPatternScan,
    candidatesFromSnapshot,
    captureCandidatesOnce,
    cupLevels,
    disposeCandidates,
    insertCandidates,
    listCandidateDays,
    listCandidates,
    listEligibleCandidateSymbols,
    overnightEligibility,
    overnightLevels,
    updateCandidate,
    type CandidateRow,
} from './candidate-archive.js';
import type { OpportunitySnapshot } from './opportunity-engine.js';
import type { PatternScanSnapshot } from './pattern-scanner.js';

afterAll(() => {
    if (prev === undefined) delete process.env.DEXTER_DATA_DIR; else process.env.DEXTER_DATA_DIR = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* held by sqlite */ }
});

const rules: RiskRules = { ...DEFAULT_RULES, min_price: 5, stop_atr_multiplier: 1.5, take_atr_mult: 1.5, take_floor_pct: 3, take_cap_pct: 10, overnight_exit_minutes_et: 600, min_risk_reward: 2, min_stop_atr_fraction: 0.4 };
// Thursday 2026-09-10 15:35 ET = 19:35 UTC
const CAPTURED = Date.UTC(2026, 8, 10, 19, 35, 0);

function opp(over: Partial<OpportunitySnapshot['opportunities'][number]> = {}): OpportunitySnapshot['opportunities'][number] {
    return {
        symbol: 'MU', longName: 'Micron', direction: 'long', signalScore: 70, rating: 'buy', compositeRank: 78, price: 100, rvol: 2, atr: 1.2, rsi: 60,
        vwap: 99, scanSources: ['TOP_PERC_GAIN'], dayMovePct: 4.2, stale: false, dollarVolume: 5e8, dailyAtrPct: 3, ...over,
    };
}
function snapshot(opps: OpportunitySnapshot['opportunities'], phase: OpportunitySnapshot['phase'] = 'pre-close', timestamp = CAPTURED - 5 * 60_000): OpportunitySnapshot {
    return { timestamp, phase, sessionLabel: 'pre-close', marketOpen: true, scanned: 40, scored: opps.length, opportunities: opps, topN: 5 };
}

describe('overnight eligibility + levels v1 (REQ-BENCH-002/004)', () => {
    test('a fresh, priced, with-the-move, ATR-known, earnings-free candidate is eligible; unknown earnings is a note', () => {
        expect(overnightEligibility({ symbol: 'MU', direction: 'long', compositeRank: 78, price: 100, stale: false, dayMovePct: 4, dailyAtr: 3, earningsWithin2d: false }, rules))
            .toEqual({ eligible: true, reasons: [] });
        expect(overnightEligibility({ symbol: 'MU', direction: 'long', compositeRank: 78, price: 100, stale: false, dayMovePct: 4, dailyAtr: 3, earningsWithin2d: null }, rules))
            .toEqual({ eligible: true, reasons: ['note:earnings-unknown'] });
    });

    test('every deterministic reason is named', () => {
        const r = overnightEligibility({ symbol: 'X', direction: 'short', compositeRank: 60, price: 3, stale: true, dayMovePct: -2, dailyAtr: null, earningsWithin2d: true }, rules);
        expect(r.eligible).toBe(false);
        expect(r.reasons).toEqual(['stale-data', 'min-price', 'atr-missing', 'counter-move', 'earnings-within-2d']);
        expect(overnightEligibility({ symbol: 'X', direction: 'long', compositeRank: 60, price: null, stale: false, dayMovePct: null, dailyAtr: 2, earningsWithin2d: false }, rules).reasons)
            .toEqual(['price-missing', 'day-move-unknown']);
    });

    test('levels v2 (review 2026-09-06 finding 7): target at take-x (ATR% 3 → x = 4.5%), stop at take/min R:R = 2.25 (0.75 ATR, ≥ the 0.4 ATR noise floor) → R:R 2:1 as the gate requires; short mirrored; impossible geometry → null', () => {
        expect(overnightLevels({ price: 100, dailyAtr: 3, direction: 'long' }, rules)).toEqual({ entryType: 'MKT', entry: null, entryLimit: null, stop: 97.75, target: 104.5 });
        expect(overnightLevels({ price: 100, dailyAtr: 3, direction: 'short' }, rules)).toEqual({ entryType: 'MKT', entry: null, entryLimit: null, stop: 102.25, target: 95.5 });
        // a wide take band relative to the ATR keeps the 1.5-ATR stop when that is the tighter of the two (ATR% 1 → take floor 3% → 3/2 = 1.5 ≥ 1.5 ATR)
        expect(overnightLevels({ price: 100, dailyAtr: 1, direction: 'long' }, rules)).toEqual({ entryType: 'MKT', entry: null, entryLimit: null, stop: 98.5, target: 103 });
        // a stop the noise filter would refuse (take cap 10% on a $2 stock with a $3 ATR → 0.1 stop distance < 0.4 ATR) → null
        expect(overnightLevels({ price: 2, dailyAtr: 3, direction: 'long' }, rules)).toBeNull();
        // cup: STP_LMT at the trigger with a 0.5% band, 2R target
        expect(cupLevels({ suggestedEntry: 50, suggestedStop: 47 })).toEqual({ entryType: 'STP_LMT', entry: 50, entryLimit: 50.25, stop: 47, target: 56 });
        expect(cupLevels({ suggestedEntry: 50, suggestedStop: 51 })).toBeNull();
    });
});

describe('candidatesFromSnapshot / candidatesFromPatternScan (REQ-BENCH-001)', () => {
    test('one row per symbol (higher rank wins), levels and the 10:00-next-session deadline on eligible rows, reasons on the rest', () => {
        const rows = candidatesFromSnapshot(
            snapshot([opp(), opp({ compositeRank: 70, price: 99 }), opp({ symbol: 'AMD', dayMovePct: -1 }), opp({ symbol: 'NVDA', stale: true })]),
            { capturedAt: CAPTURED, rules, dailyAtr: new Map([['MU', 3], ['AMD', 4], ['NVDA', 5]]), earnings: new Map([['MU', false], ['AMD', false], ['NVDA', false]]) },
        );
        expect(rows.map((r) => [r.symbol, r.eligible, r.rank])).toEqual([['MU', true, 78], ['AMD', false, 78], ['NVDA', false, 78]]);
        const mu = rows[0];
        expect(mu.day).toBe('2026-09-10');
        expect(mu.lane).toBe('overnight');
        expect(mu.source).toMatch(/^opportunity-snapshot:pre-close@/);
        expect(mu.price).toBe(100);
        expect(mu.rankerVersion).toBe('composite-v1'); // a snapshot without lane rankings keeps the composite, labelled
        expect(mu.levelsVersion).toBe('v2');
        expect(mu.stop).toBe(97.75); expect(mu.target).toBe(104.5);
        expect(mu.replayStatus).toBe('pending');
        // deadline: Friday 2026-09-11 10:00 ET = 14:00 UTC
        expect(mu.exitDeadline).toBe(Date.UTC(2026, 8, 11, 14, 0, 0));
        expect(rows[1].reasons).toEqual(['counter-move']);
        expect(rows[1].replayStatus).toBe('skipped');
        expect(rows[1].stop).toBeNull();
    });

    test('REQ-DISC-003: with the WP8 lane ranking on the snapshot, the overnight row takes the lane score and its ranker version; an excluded row keeps the composite', async () => {
        const { buildSnapshotLanes } = await import('./lane-rankers.js');
        const opps = [opp(), opp({ symbol: 'AMD', dayMovePct: -1, compositeRank: 70 })];
        const snap = { ...snapshot(opps), lanes: buildSnapshotLanes(opps) };
        const rows = candidatesFromSnapshot(snap, { capturedAt: CAPTURED, rules, dailyAtr: new Map([['MU', 3], ['AMD', 4]]), earnings: new Map() });
        const mu = rows.find((r) => r.symbol === 'MU')!;
        expect(mu.rankerVersion).toBe('eod-continuation-v1');
        expect(mu.rank).toBe(snap.lanes.overnight.ranked.find((r) => r.symbol === 'MU')!.score);
        expect(mu.rank).not.toBe(78);
        const amd = rows.find((r) => r.symbol === 'AMD')!;
        expect(amd).toMatchObject({ rank: 70, rankerVersion: 'composite-v1', eligible: false });
    });

    test('cup lane: only cup matches, detector version + state kept, archived but not replayed; a stale scan is ineligible', () => {
        const scan: PatternScanSnapshot = {
            ranAt: CAPTURED - 20 * 3_600_000, scanned: 500, eligible: 400, detectorVersion: 'v1',
            candidates: [
                { symbol: 'CUP1', close: 50, dailyAtr: 1.5, lastBar: '20260909', pattern: 'cup-and-handle', detectorVersion: 'v1', state: 'pivot-ready', score: 72, pivot: 49.5, suggestedEntry: 50, suggestedStop: 47, note: 'x',
                  matches: [{ pattern: 'cup-and-handle', detectorVersion: 'v1', state: 'pivot-ready', score: 72, pivot: 49.5, suggestedEntry: 50, suggestedStop: 47, note: 'x' }] },
                { symbol: 'FLAT', close: 20, dailyAtr: 0.5, lastBar: '20260909', pattern: 'flat-base', detectorVersion: 'v1', state: 'pivot-ready', score: 80, pivot: 20, suggestedEntry: 20.2, suggestedStop: 19, note: 'y',
                  matches: [{ pattern: 'flat-base', detectorVersion: 'v1', state: 'pivot-ready', score: 80, pivot: 20, suggestedEntry: 20.2, suggestedStop: 19, note: 'y' }] },
            ],
        };
        const rows = candidatesFromPatternScan(scan, { capturedAt: CAPTURED, rules, dailyAtr: new Map(), earnings: new Map() });
        expect(rows.map((r) => r.symbol)).toEqual(['CUP1']);
        expect(rows[0]).toMatchObject({ lane: 'cup-and-handle', eligible: true, detectorVersion: 'v1', state: 'pivot-ready', entryType: 'STP_LMT', entry: 50, stop: 47, target: 56, replayStatus: 'skipped', rankerVersion: 'detector-v1' });
        expect(rows[0].exitDeadline).not.toBeNull();
        const stale = candidatesFromPatternScan({ ...scan, ranAt: CAPTURED - 40 * 3_600_000 }, { capturedAt: CAPTURED, rules, dailyAtr: new Map(), earnings: new Map() });
        expect(stale[0].eligible).toBe(false);
        expect(stale[0].reasons).toEqual(['stale-scan']);
    });
});

describe('disposeCandidates (REQ-BENCH-003)', () => {
    const row = (symbol: string): CandidateRow => candidatesFromSnapshot(snapshot([opp({ symbol })]), { capturedAt: CAPTURED, rules, dailyAtr: new Map([[symbol, 3]]), earnings: new Map() })[0];
    test('proposed by the lane that day / refused in the pre-close window / not admitted', () => {
        const out = disposeCandidates([row('MU'), row('AMD'), row('NVDA'), row('SOXL')], {
            proposals: [
                { id: 'P-0101', symbol: 'MU', direction: 'long', strategyId: 'overnight', createdAt: CAPTURED + 5 * 60_000 },
                { id: 'P-0102', symbol: 'SOXL', direction: 'long', strategyId: 'intraday', createdAt: CAPTURED - 3 * 3_600_000 }, // another lane: does not count
            ],
            refusals: [
                { symbol: 'AMD', direction: 'long', createdAt: CAPTURED + 2 * 60_000, gate: 'noise-stop' },
                { symbol: 'NVDA', direction: 'long', createdAt: Date.UTC(2026, 8, 10, 14, 0, 0), gate: 'chase' }, // 10:00 ET — morning refusal, not the pre-close window
            ],
        });
        expect(out.map((r) => [r.symbol, r.disposition, r.dispositionRef])).toEqual([
            ['MU', 'proposed', 'P-0101'], ['AMD', 'refused', 'noise-stop'], ['NVDA', 'not-admitted', null], ['SOXL', 'not-admitted', null],
        ]);
    });

    test('review 2026-09-06 second pass, finding 4: a late SHORT is not attributed to the long candidate; a proposal decided against an EARLIER snapshot than the row\'s first sighting is not a pick from this universe', () => {
        const snapTs = CAPTURED - 5 * 60_000; // the row's source snapshot (see snapshot(): timestamp = CAPTURED − 5 min)
        const out = disposeCandidates([row('MU'), row('AMD'), row('NVDA')], {
            proposals: [
                { id: 'P-S', symbol: 'MU', direction: 'short', strategyId: 'overnight', createdAt: CAPTURED + 10 * 60_000, snapshotTs: snapTs },          // wrong direction
                { id: 'P-E', symbol: 'AMD', direction: 'long', strategyId: 'overnight', createdAt: CAPTURED + 60_000, snapshotTs: snapTs - 10 * 60_000 }, // earlier universe
                { id: 'P-OK', symbol: 'NVDA', direction: 'long', strategyId: 'overnight', createdAt: CAPTURED + 60_000, snapshotTs: snapTs },           // same snapshot: attributable
            ],
            refusals: [{ symbol: 'MU', direction: 'short', createdAt: CAPTURED + 2 * 60_000, gate: 'noise-stop' }], // wrong direction too
        });
        expect(out.map((r) => [r.symbol, r.disposition, r.dispositionRef])).toEqual([
            ['MU', 'not-admitted', null], ['AMD', 'not-admitted', null], ['NVDA', 'proposed', 'P-OK'],
        ]);
    });
});

describe('store + capture (REQ-BENCH-001 — the first capture of a day stands)', () => {
    test('insert ignores a second capture of the same (day, lane, symbol); lists, days, eligible symbols and patches work', async () => {
        const ctx = { capturedAt: CAPTURED, rules, dailyAtr: new Map([['MU', 3], ['AMD', 4]]), earnings: new Map<string, boolean | null>() };
        const first = candidatesFromSnapshot(snapshot([opp(), opp({ symbol: 'AMD', compositeRank: 70, dayMovePct: -1 })]), ctx);
        expect(await insertCandidates(first)).toBe(2);
        const again = candidatesFromSnapshot(snapshot([opp({ price: 101, compositeRank: 90 })]), { ...ctx, capturedAt: CAPTURED + 10 * 60_000 });
        expect(await insertCandidates(again)).toBe(0);
        const rows = await listCandidates({ day: '2026-09-10', lane: 'overnight' });
        expect(rows.map((r) => [r.symbol, r.price, r.rank])).toEqual([['MU', 100, 78], ['AMD', 100, 70]]); // the first capture's price and rank, rank order
        expect(await listCandidateDays('overnight')).toEqual(['2026-09-10']);
        expect(await listEligibleCandidateSymbols('2026-09-10', 'overnight')).toEqual(['MU']);
        expect((await listCandidates({ lane: 'overnight', replayStatus: 'pending' })).map((r) => r.symbol)).toEqual(['MU']);
        await updateCandidate(rows[0].id!, { replayStatus: 'settled', outcome: 'target', netR: 1.4, disposition: 'proposed', dispositionRef: 'P-0101' });
        const after = (await listCandidates({ day: '2026-09-10' })).find((r) => r.symbol === 'MU')!;
        expect(after).toMatchObject({ replayStatus: 'settled', outcome: 'target', netR: 1.4, disposition: 'proposed', dispositionRef: 'P-0101', price: 100 });
    });

    test('captureCandidatesOnce: today\'s pre-close snapshot + the scan are archived; a stale or non-pre-close snapshot yields no overnight universe', async () => {
        const inserted: CandidateRow[][] = [];
        const deps = {
            now: CAPTURED, rules,
            latestSnapshot: () => snapshot([opp({ symbol: 'NVDA' }), opp({ symbol: 'TSLA', stale: true })]),
            latestPatternScan: () => null,
            dailyAtrFor: async (s: string) => (s === 'NVDA' ? 6 : null),
            earningsWithin2d: async (symbols: string[]) => new Map(symbols.map((s) => [s, false] as [string, boolean | null])),
            insert: async (rows: CandidateRow[]) => { inserted.push(rows); return rows.length; },
        };
        const c = await captureCandidatesOnce(deps);
        expect(c).toEqual({ day: '2026-09-10', overnight: { seen: 2, eligible: 1, inserted: 2, skipped: null }, cup: { seen: 0, eligible: 0, inserted: 0, skipped: 'no pattern scan snapshot' } });
        expect(inserted[0].map((r) => [r.symbol, r.eligible])).toEqual([['NVDA', true], ['TSLA', false]]);
        const midday = await captureCandidatesOnce({ ...deps, latestSnapshot: () => snapshot([opp()], 'midday') });
        expect(midday.overnight.skipped).toContain("'midday'");
        const yesterday = await captureCandidatesOnce({ ...deps, latestSnapshot: () => snapshot([opp()], 'pre-close', CAPTURED - 86_400_000) });
        expect(yesterday.overnight.skipped).toContain('2026-09-09');
    });
});
