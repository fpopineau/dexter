import { describe, expect, test } from 'bun:test';
import { sweepDueOnce } from './veto-window.js';
import type { TradeProposal } from './trade-proposals.js';

function due(id: string, at: number): TradeProposal {
    return {
        id, createdAt: at - 60_000, expiresAt: at + 3600_000, updatedAt: at, status: 'open', symbol: id.slice(2), direction: 'long',
        entryType: 'LMT', entry: 20, entryLimit: null, stop: 19, target: 22, quantity: 10, tif: 'DAY', tradeClass: 'intraday',
        worstCaseGapPct: null, score: 65, rationale: 'x', source: 'trigger', orderIds: null, orderPermIds: null,
        plannedQuantity: null, model: null, strategyFingerprint: null, strategyId: null, setupId: null, holdingHorizon: null, exitPolicyId: null, exitDeadline: null, deadlineClosedAt: null, deadlineAttemptedAt: null, deadlineAttempts: 0, snapshotTs: null, detectorVersion: null, costToTargetPct: null, laneRank: null, rankerVersion: null, regime: null, note: null, executedAt: null, entryFillPrice: null, entryFilledAt: null,
        exitFillPrice: null, exitReason: null, realizedPnl: null, commissions: null, closedAt: null, keptOvernightAt: null,
        mfePct: null, maePct: null, extensionAtr: null, vwapDistPct: null, dayMovePct: null, minutesSinceOpen: null,
        takePct: null, takePctSource: null, postExitMfePct: null, postExitMaePct: null, takeCounterfactual: null,
        dailyAtrAtCreation: null, triggerRank: null, triggerBand: null, autoExecuteAt: at, spreadDeferred: false,
    };
}

describe('veto-window due sweep (REQ-LIVE-002 seam — executes due rows oldest first, through the normal gates)', () => {
    test('executes each due row once in creation order and reports outcomes; an executor failure never stops the sweep', async () => {
        const executed: string[] = [];
        const result = await sweepDueOnce({
            now: 1_000_000,
            listDue: async () => [due('P-AAAA', 900_000), due('P-BBBB', 950_000)],
            execute: async (id) => {
                executed.push(id);
                if (id === 'P-BBBB') throw new Error('boom');
                return { ok: true, message: 'placed' };
            },
        });
        expect(executed).toEqual(['P-AAAA', 'P-BBBB']);
        expect(result.attempted).toBe(2);
        expect(result.executed).toBe(1);
        expect(result.failed).toBe(1);
    });

    test('REQ-LIVE-007: a refused row (claimed or vetoed meanwhile) is counted failed and the next row still runs', async () => {
        const executed: string[] = [];
        const result = await sweepDueOnce({
            now: 1_000_000,
            listDue: async () => [due('P-AAAA', 900_000), due('P-BBBB', 950_000), due('P-CCCC', 990_000)],
            execute: async (id) => {
                executed.push(id);
                if (id === 'P-AAAA') return { ok: false, message: 'proposal is executing (claimed)' };
                if (id === 'P-BBBB') return { ok: false, message: 'proposal is rejected' };
                return { ok: true, message: 'placed' };
            },
        });
        expect(executed).toEqual(['P-AAAA', 'P-BBBB', 'P-CCCC']);
        expect(result).toEqual({ attempted: 3, executed: 1, failed: 2 });
    });

    test('nothing due → nothing executed', async () => {
        const result = await sweepDueOnce({ now: 1, listDue: async () => [], execute: async () => { throw new Error('must not run'); } });
        expect(result).toEqual({ attempted: 0, executed: 0, failed: 0 });
    });
});
