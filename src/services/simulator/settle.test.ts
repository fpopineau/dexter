import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES } from '@/tools/ibkr/risk-rules.js';
import { etFrameMs } from '../outcome-tracker.js';
import type { RefusalRecord, TradeProposal } from '../trade-proposals.js';
import type { SimBar } from './fill-model.js';
import { flatAtFrameFor, runSettleOnce, sourceFromProposal, sourceFromRefusal, type SettleDeps } from './settle.js';
import type { SimTrade } from './store.js';

const M = 60_000;
// 2026-09-10 (Thu) 14:00 UTC = 10:00 ET
const CREATED = Date.UTC(2026, 8, 10, 14, 0, 0);
const NOW = Date.UTC(2026, 8, 10, 21, 30, 0); // 17:30 ET the same day

function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
    return {
        id: 'P-0001', createdAt: CREATED, expiresAt: CREATED + 120 * M, updatedAt: CREATED, status: 'closed', symbol: 'MU', direction: 'long',
        entryType: 'LMT', entry: 100, entryLimit: null, stop: 97, target: 106, quantity: 7, tif: 'DAY', tradeClass: 'intraday',
        worstCaseGapPct: null, score: 66, rationale: 'x', source: 'trigger', orderIds: [1, 2, 3], orderPermIds: null,
        plannedQuantity: null, model: null, strategyFingerprint: null, strategyId: null, setupId: null, holdingHorizon: null, exitPolicyId: null, exitDeadline: null, deadlineClosedAt: null, detectorVersion: null, costToTargetPct: null, regime: null, note: null, executedAt: CREATED, entryFillPrice: 100.05, entryFilledAt: CREATED + M,
        exitFillPrice: 106, exitReason: 'target', realizedPnl: 41.65, commissions: 2, closedAt: CREATED + 60 * M, keptOvernightAt: null,
        mfePct: null, maePct: null, extensionAtr: null, vwapDistPct: null, dayMovePct: null, minutesSinceOpen: null,
        takePct: 6, takePctSource: 'formula', postExitMfePct: null, postExitMaePct: null, takeCounterfactual: null,
        dailyAtrAtCreation: 4, triggerRank: 66, triggerBand: '60-74', autoExecuteAt: null, spreadDeferred: false,
        ...overrides,
    };
}

function refusal(overrides: Partial<RefusalRecord> = {}): RefusalRecord {
    return {
        id: 77, createdAt: CREATED, symbol: 'AMBA', direction: 'short', entryType: 'LMT', entry: 60, entryLimit: null, stop: 62.5, target: 54.09,
        quantity: 24, score: 65, reason: '[microstructure-gate] spread 0.64% of mid exceeds max_spread_pct 0.5%', gate: 'other',
        outcome: 'stop', outcomeNote: null, mfePct: null, maePct: null, proposalAgeSec: null, livePrice: null, triggerRank: 65,
        ...overrides,
    };
}

/** A day of 1-minute bars (ET frame) that fills a long at 100 and runs to the target. */
function winningBars(entry = 100): SimBar[] {
    const start = etFrameMs(CREATED);
    const out: SimBar[] = [];
    for (let i = 1; i <= 120; i++) {
        const t = start + i * M;
        if (i === 1) out.push({ t, open: entry + 0.5, high: entry + 0.6, low: entry - 0.2, close: entry + 0.1 }); // trades through the limit
        else if (i < 60) out.push({ t, open: entry + 0.5, high: entry + 1, low: entry + 0.3, close: entry + 0.8 });
        else out.push({ t, open: entry + 6.5, high: entry + 7, low: entry + 6.2, close: entry + 6.8 }); // through the target
    }
    return out;
}

class FakeStore {
    rows = new Map<string, SimTrade>();
    key = (v: string, k: string, id: string) => `${v}|${k}|${id}`;
    find = async (v: string, k: 'proposal' | 'refusal', id: string) => this.rows.get(this.key(v, k, id)) ?? null;
    upsert = async (r: SimTrade) => { this.rows.set(this.key(r.variant, r.sourceKind, r.sourceId), r); };
    listOpen = async () => [...this.rows.values()].filter((r) => r.status === 'open');
}

function deps(overrides: Partial<SettleDeps> = {}): SettleDeps & { store: FakeStore } {
    const store = new FakeStore();
    return {
        now: NOW,
        lookbackMs: 3 * 86_400_000,
        listProposalsSince: async () => [proposal()],
        listRefusalsSince: async () => [refusal()],
        loadBars: async () => ({ bars: winningBars(), source: 'archive-1m' as const }),
        store,
        rules: { ...DEFAULT_RULES, take_atr_mult: 1.5, take_floor_pct: 3, take_cap_pct: 10 },
        rungPct: 0.25,
        netLiq: 12_000,
        commissions: { perShareUsd: 0.005, minUsd: 1 },
        isHalfDay: () => false,
        ...overrides,
    } as SettleDeps & { store: FakeStore };
}

describe('source normalisation', () => {
    test('a proposal becomes a SimSource in the ET frame with its band, lane, x and ATR; adopted/test rows are excluded', () => {
        const s = sourceFromProposal(proposal())!;
        expect(s.kind).toBe('proposal');
        expect(s.createdAt).toBe(etFrameMs(CREATED));
        expect(s.expiresAt).toBe(etFrameMs(CREATED + 120 * M));
        expect(s.takePct).toBe(6); expect(s.dailyAtr).toBe(4); expect(s.triggerBand).toBe('60-74'); expect(s.lane).toBe('trigger');
        expect(sourceFromProposal(proposal({ source: 'adopted' }))).toBeNull();
        expect(sourceFromProposal(proposal({ source: 'test' }))).toBeNull();
    });

    test('a refusal with levels becomes a refusal source with its gate (microstructure recognised from the reason); EVAL declines are skipped', () => {
        const s = sourceFromRefusal(refusal())!;
        expect(s.kind).toBe('refusal'); expect(s.id).toBe('R-77'); expect(s.gate).toBe('microstructure'); expect(s.tif).toBe('DAY');
        expect(sourceFromRefusal(refusal({ entryType: 'EVAL', stop: null, target: null }))).toBeNull();
        expect(sourceFromRefusal(refusal({ gate: 'noise-stop', reason: 'stop inside intraday noise' }))!.gate).toBe('noise-stop');
    });

    test('flatAtFrameFor: 15:52 ET of the row day (12:52 on a half day)', () => {
        const f = flatAtFrameFor(etFrameMs(CREATED), false);
        expect(new Date(f).toISOString()).toBe('2026-09-10T15:52:00.000Z'); // ET-frame wall clock
        expect(new Date(flatAtFrameFor(etFrameMs(CREATED), true)).toISOString()).toBe('2026-09-10T12:52:00.000Z');
    });
});

describe('runSettleOnce (REQ-SIM-001/005/006)', () => {
    test('writes one row per applicable variant, sized at the rung, with commissions and R; the refusal feeds its gate-off variant', async () => {
        const d = deps();
        const r = await runSettleOnce(d);
        const rows = [...d.store.rows.values()];
        const variants = rows.filter((x) => x.sourceId === 'P-0001').map((x) => x.variant).sort();
        expect(variants).toEqual(['exit-fixed-3', 'exit-ratchet', 'exit-x2.0', 'incumbent', 'stop-x/3']);
        const inc = rows.find((x) => x.variant === 'incumbent' && x.sourceId === 'P-0001')!;
        expect(inc.quantity).toBe(10);                 // 0.25% × 12,000 / $3
        expect(inc.outcome).toBe('target');
        expect(inc.fillPrice).toBe(100);
        expect(inc.commissions).toBe(2);
        expect(inc.netUsd).toBeCloseTo(58, 6);          // 6 × 10 − 2
        expect(inc.netR).toBeCloseTo(58 / 30, 6);
        expect(inc.status).toBe('settled');
        expect(inc.barSource).toBe('archive-1m');
        const gateOff = rows.find((x) => x.variant === 'gate-off:microstructure')!;
        expect(gateOff.sourceKind).toBe('refusal');
        expect(gateOff.sourceId).toBe('R-77');
        expect(r.failed).toBe(0);
        expect(r.evaluated).toBe(6);
    });

    test('a settled row is not re-simulated; an open GTC row is; missing bars → unknown; a DAY row whose flat bar is in the future waits', async () => {
        const d = deps({
            listProposalsSince: async () => [
                proposal(),
                proposal({ id: 'P-GTC1', tif: 'GTC', tradeClass: 'swing', symbol: 'SWG', expiresAt: CREATED + 3 * 86_400_000 }),
                proposal({ id: 'P-NOBR', symbol: 'NOBR' }),
                // Created after the day's flat bar (post-cutoff): no window to replay.
                proposal({ id: 'P-LATE', symbol: 'LATE', createdAt: NOW - 30 * M, expiresAt: NOW + 90 * M }),
            ],
            listRefusalsSince: async () => [],
            loadBars: async (symbol) => symbol === 'NOBR' ? null
                : symbol === 'SWG' ? { bars: winningBars().slice(0, 30), source: 'stream-5s' as const } // fills, never exits → open
                : { bars: winningBars(), source: 'archive-1m' as const },
        });
        // Pre-existing settled twin: must be left alone.
        await d.store.upsert({
            variant: 'incumbent', sourceKind: 'proposal', sourceId: 'P-0001', symbol: 'MU', direction: 'long', tradeClass: 'intraday',
            entryType: 'LMT', entry: 100, entryLimit: null, stop: 97, target: 106, quantity: 1, tif: 'DAY', createdAt: CREATED,
            barSource: 'archive-1m', fillAt: 1, fillPrice: 100, exitAt: 2, exitPrice: 97, outcome: 'stop', commissions: 2, netUsd: -5, netR: -1,
            status: 'settled', biasNote: 'pessimistic', settledAt: 1, horizonDays: 1, note: 'pre-existing',
        });
        const r = await runSettleOnce(d);
        expect((await d.store.find('incumbent', 'proposal', 'P-0001'))?.note).toBe('pre-existing');
        const gtc = (await d.store.find('class-swing', 'proposal', 'P-GTC1'))!;
        expect(gtc.status).toBe('open');
        expect(gtc.outcome).toBe('open');
        const nobr = (await d.store.find('incumbent', 'proposal', 'P-NOBR'))!;
        expect(nobr.status).toBe('unknown');
        expect(nobr.outcome).toBe('unknown');
        expect(nobr.note).toMatch(/no covered bar source/);
        expect(await d.store.find('incumbent', 'proposal', 'P-LATE')).toBeNull(); // created after the flat bar — nothing to replay
        expect(r.skipped).toBeGreaterThan(0);
        // Second pass: the open GTC row is re-evaluated (still open — same bars), nothing else changes.
        const r2 = await runSettleOnce(d);
        expect(r2.open).toBeGreaterThanOrEqual(1);

        // A DAY row whose flat bar is still in the FUTURE waits for tomorrow's settle.
        const early = deps({
            now: CREATED + 30 * M, // 10:30 ET, the flat bar is 15:52 ET
            listProposalsSince: async () => [proposal({ id: 'P-TODAY', symbol: 'TDAY' })],
            listRefusalsSince: async () => [],
        });
        const r3 = await runSettleOnce(early);
        expect(await early.store.find('incumbent', 'proposal', 'P-TODAY')).toBeNull();
        expect(r3.skipped).toBeGreaterThan(0);
        expect(r3.evaluated).toBe(0);
    });

    test('a per-source failure is isolated and counted; the run still completes', async () => {
        const d = deps({
            listProposalsSince: async () => [proposal(), proposal({ id: 'P-BOOM', symbol: 'BOOM' })],
            listRefusalsSince: async () => [],
            loadBars: async (symbol) => { if (symbol === 'BOOM') throw new Error('bars exploded'); return { bars: winningBars(), source: 'archive-1m' as const }; },
        });
        const r = await runSettleOnce(d);
        expect(r.failed).toBeGreaterThan(0);
        expect(await d.store.find('incumbent', 'proposal', 'P-0001')).not.toBeNull();
    });
});
