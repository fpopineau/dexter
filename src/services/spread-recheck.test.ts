import { describe, expect, test } from 'bun:test';
import { runSpreadRecheckOnce, spreadRecheckDecision } from './spread-recheck.js';
import type { TradeProposal } from './trade-proposals.js';

function row(overrides: Partial<TradeProposal> = {}): TradeProposal {
    return {
        id: 'P-SPRD', createdAt: 1, expiresAt: 2, updatedAt: 1, status: 'executed', symbol: 'PL', direction: 'long',
        entryType: 'LMT', entry: 20, entryLimit: null, stop: 19, target: 22, quantity: 10, tif: 'DAY', tradeClass: 'intraday',
        worstCaseGapPct: null, score: 65, rationale: 'x', source: 'trigger', orderIds: [1, 2, 3], orderPermIds: null,
        plannedQuantity: null, model: null, strategyFingerprint: null, regime: null, note: null, executedAt: 1, entryFillPrice: null, entryFilledAt: null,
        exitFillPrice: null, exitReason: null, realizedPnl: null, commissions: null, closedAt: null, keptOvernightAt: null,
        mfePct: null, maePct: null, extensionAtr: null, vwapDistPct: null, dayMovePct: null, minutesSinceOpen: null,
        takePct: null, takePctSource: null, postExitMfePct: null, postExitMaePct: null, takeCounterfactual: null,
        dailyAtrAtCreation: null, triggerRank: 66, triggerBand: '60-74', autoExecuteAt: null, spreadDeferred: true,
        ...overrides,
    };
}

describe('spreadRecheckDecision (REQ-RISK-008 — the 09:31 ET re-check of a deferred pre-open accept)', () => {
    test('filled entry → keep (protected position, flag clears); unfilled over the cap → cancel; under → clear', () => {
        expect(spreadRecheckDecision({ filled: true, spreadPct: 2.0, capPct: 0.5 })).toBe('keep-filled');
        expect(spreadRecheckDecision({ filled: false, spreadPct: 0.7, capPct: 0.5 })).toBe('cancel');
        expect(spreadRecheckDecision({ filled: false, spreadPct: 0.5, capPct: 0.5 })).toBe('clear');
        expect(spreadRecheckDecision({ filled: false, spreadPct: 0.2, capPct: 0.5 })).toBe('clear');
    });

    test('no quote → retry later (the flag stays; nothing is cancelled on missing data)', () => {
        expect(spreadRecheckDecision({ filled: false, spreadPct: null, capPct: 0.5 })).toBe('retry');
    });
});

describe('runSpreadRecheckOnce (deps injected — cancels through the safe entry-leg primitive only)', () => {
    test('one pass: cancels the wide unfilled, clears the tight one and the filled one, retries the unquoted', async () => {
        const wide = row({ id: 'P-WIDE', symbol: 'WIDE' });
        const tight = row({ id: 'P-TGHT', symbol: 'TGHT' });
        const filled = row({ id: 'P-FILL', symbol: 'FILL', entryFillPrice: 20.01 });
        const noQuote = row({ id: 'P-NOQT', symbol: 'NOQT' });
        const cancelled: string[] = [];
        const cleared: Array<[string, boolean]> = [];
        const refusals: string[] = [];
        const result = await runSpreadRecheckOnce({
            listSpreadDeferred: async () => [wide, tight, filled, noQuote],
            fetchLiveQuote: async (sym) => sym === 'WIDE' ? { bid: 99, ask: 100, last: 99.5 }
                : sym === 'TGHT' ? { bid: 100, ask: 100.1, last: 100.05 }
                : sym === 'FILL' ? { bid: 99, ask: 100, last: 99.5 }
                : { bid: null, ask: null, last: null },
            cancelEntryLeg: async (p) => { cancelled.push(p.id); return true; },
            markSpreadDeferred: async (id, d) => { cleared.push([id, d]); },
            recordRefusal: async (r) => { refusals.push(r.reason); },
            maxSpreadPct: 0.5,
        });
        expect(cancelled).toEqual(['P-WIDE']);
        expect(cleared).toEqual([['P-WIDE', false], ['P-TGHT', false], ['P-FILL', false]]);
        expect(refusals).toHaveLength(1);
        expect(refusals[0]).toMatch(/spread-deferred-cancel/);
        expect(result).toEqual({ checked: 4, cancelled: 1, cleared: 2, retried: 1 });
    });
});
