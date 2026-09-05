import { describe, expect, test } from 'bun:test';
import { vetoDecision, vetoProposalWith } from './loop-control.js';
import type { TradeProposal } from './trade-proposals.js';

function p(overrides: Partial<TradeProposal>): TradeProposal {
    return {
        id: 'P-VETO', createdAt: 1, expiresAt: 2, updatedAt: 1, status: 'open', symbol: 'VT', direction: 'long',
        entryType: 'LMT', entry: 20, entryLimit: null, stop: 19, target: 22, quantity: 10, tif: 'DAY', tradeClass: 'intraday',
        worstCaseGapPct: null, score: 65, rationale: 'x', source: 'trigger', orderIds: null, orderPermIds: null,
        plannedQuantity: null, model: null, strategyFingerprint: null, strategyId: null, setupId: null, holdingHorizon: null, exitPolicyId: null, exitDeadline: null, deadlineClosedAt: null, detectorVersion: null, costToTargetPct: null, laneRank: null, rankerVersion: null, regime: null, note: null, executedAt: null, entryFillPrice: null, entryFilledAt: null,
        exitFillPrice: null, exitReason: null, realizedPnl: null, commissions: null, closedAt: null, keptOvernightAt: null,
        mfePct: null, maePct: null, extensionAtr: null, vwapDistPct: null, dayMovePct: null, minutesSinceOpen: null,
        takePct: null, takePctSource: null, postExitMfePct: null, postExitMaePct: null, takeCounterfactual: null,
        dailyAtrAtCreation: null, triggerRank: null, triggerBand: null, autoExecuteAt: null, spreadDeferred: false,
        ...overrides,
    };
}

describe('vetoDecision (REQ-LIVE-003 — veto = cancel the UNFILLED entry, never strip a filled position)', () => {
    test('open → reject; executed & unfilled → cancel the bracket; filled → refuse with the kill hint; other states → refuse', () => {
        expect(vetoDecision(p({ status: 'open' }))).toBe('reject');
        expect(vetoDecision(p({ status: 'executed', orderIds: [1, 2, 3] }))).toBe('cancel-bracket');
        expect(vetoDecision(p({ status: 'executed', orderIds: [1, 2, 3], entryFillPrice: 20.02 }))).toBe('refuse-filled');
        expect(vetoDecision(p({ status: 'executing' }))).toBe('refuse-claimed'); // REQ-LIVE-007
        expect(vetoDecision(p({ status: 'closed' }))).toBe('refuse-status');
        expect(vetoDecision(p({ status: 'rejected' }))).toBe('refuse-status');
    });
});

describe('vetoProposalWith (deps injected — routes to the existing reject / cancel primitives)', () => {
    test('open row → reject called; executed unfilled → cancelBracket called; filled → neither, message names kill', async () => {
        const calls: string[] = [];
        const deps = {
            getProposal: async (id: string) => id === 'P-OPEN' ? p({ id, status: 'open' })
                : id === 'P-EXEC' ? p({ id, status: 'executed', orderIds: [1, 2, 3] })
                : id === 'P-FILL' ? p({ id, status: 'executed', orderIds: [1, 2, 3], entryFillPrice: 20.02, symbol: 'FILL' })
                : id === 'P-CLMD' ? p({ id, status: 'executing', symbol: 'CLMD' })
                : null,
            rejectProposal: async (id: string) => { calls.push(`reject:${id}`); return { ok: true, message: 'rejected' }; },
            cancelProposalBracket: async (id: string) => { calls.push(`cancel:${id}`); return { ok: true, message: 'cancel requested' }; },
        };
        expect((await vetoProposalWith('P-OPEN', deps)).ok).toBe(true);
        expect((await vetoProposalWith('P-EXEC', deps)).ok).toBe(true);
        const filled = await vetoProposalWith('P-FILL', deps);
        expect(filled.ok).toBe(false);
        expect(filled.message).toContain('kill FILL');
        const missing = await vetoProposalWith('P-NONE', deps);
        expect(missing.ok).toBe(false);
        // REQ-LIVE-007: a claimed row is refused by the claim, naming what applies after placement.
        const claimed = await vetoProposalWith('P-CLMD', deps);
        expect(claimed.ok).toBe(false);
        expect(claimed.message).toContain('CLAIMED');
        expect(claimed.message).toContain('cancel P-CLMD');
        expect(claimed.message).toContain('kill CLMD');
        expect(calls).toEqual(['reject:P-OPEN', 'cancel:P-EXEC']);
    });
});
