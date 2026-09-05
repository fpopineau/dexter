import { describe, expect, test } from 'bun:test';
import type { TradeProposal } from '../trade-proposals.js';
import { buildEpochSample } from './sample.js';

const T0 = Date.UTC(2026, 8, 10, 14, 0, 0);
const EPOCH = { startedAt: T0, fingerprint: 'abcdef123456' };

function row(over: Partial<TradeProposal> = {}): TradeProposal {
    return {
        id: 'P-0001', createdAt: T0 + 1000, expiresAt: T0 + 2, updatedAt: T0 + 3, status: 'closed', symbol: 'MU', direction: 'long', entryType: 'LMT', entry: 100,
        entryLimit: null, stop: 97, target: 106, quantity: 10, tif: 'DAY', tradeClass: 'intraday', worstCaseGapPct: null, score: 66, rationale: 'x', source: 'trigger',
        orderIds: [1, 2, 3], orderPermIds: null, plannedQuantity: null, model: 'anthropic:claude-sonnet-5', strategyFingerprint: 'abcdef123456', regime: null, note: null,
        executedAt: T0 + 2000, entryFillPrice: 100, entryFilledAt: T0 + 3000, exitFillPrice: 106, exitReason: 'target', realizedPnl: 60, commissions: 2, closedAt: T0 + 3_600_000,
        keptOvernightAt: null, mfePct: null, maePct: null, extensionAtr: null, vwapDistPct: null, dayMovePct: null, minutesSinceOpen: null, takePct: 6, takePctSource: 'formula',
        postExitMfePct: null, postExitMaePct: null, takeCounterfactual: null, dailyAtrAtCreation: 4, triggerRank: 66, triggerBand: '60-74', autoExecuteAt: null, spreadDeferred: false,
        ...over,
    };
}

describe('buildEpochSample (REQ-SEQ-001; audit AUD-11 hardening)', () => {
    test('the pinned filter: in-epoch, production lane, closed, filled, known P&L, not cancelled, not untrustworthy; deployable vs shadow classes; open rows counted', () => {
        const s = buildEpochSample([
            row(),
            row({ id: 'P-0002', createdAt: T0 - 1 }),                     // pre-epoch
            row({ id: 'P-0003', source: 'adopted' }),                       // excluded lane
            row({ id: 'P-0004', status: 'executed' }),                      // open in cohort
            row({ id: 'P-0005', exitReason: 'cancelled', realizedPnl: 0 }), // cancelled
            row({ id: 'P-0006', note: 'NOT trustworthy: test fill' }),
            row({ id: 'P-0007', entryFillPrice: null, realizedPnl: null }), // never filled
            row({ id: 'P-0008', tradeClass: 'swing' }),
        ], EPOCH, new Set(['swing', 'earnings-bet']));
        expect(s.trades.map((t) => t.id)).toEqual(['P-0001']);
        expect(s.shadowTrades.map((t) => t.id)).toEqual(['P-0008']);
        expect(s.openInCohort).toBe(1);
        expect(s.anomalies).toEqual([]);
        expect(s.trades[0].netR).toBeCloseTo(58 / 30, 6);
        expect(s.trades[0].closedAt).toBe(T0 + 3_600_000);
        expect(s.models).toEqual(['anthropic:claude-sonnet-5']);
    });

    test('an executed trade with an UNKNOWN outcome is an anomaly, not a smaller sample', () => {
        const s = buildEpochSample([row(), row({ id: 'P-0009', realizedPnl: null, exitReason: 'unknown' })], EPOCH, new Set());
        expect(s.trades).toHaveLength(1);
        expect(s.anomalies).toHaveLength(1);
        expect(s.anomalies[0]).toContain('P-0009');
        expect(s.anomalies[0]).toContain('UNKNOWN');
    });

    test('identity: an absent or different fingerprint is an anomaly; an epoch without a fingerprint cannot be verified', () => {
        const mixed = buildEpochSample([row(), row({ id: 'P-0010', strategyFingerprint: 'ffffff000000' }), row({ id: 'P-0011', strategyFingerprint: null })], EPOCH, new Set());
        expect(mixed.trades).toHaveLength(3); // the rows still count; the look is frozen by the anomalies
        expect(mixed.anomalies.some((a) => a.includes('P-0010') && a.includes('mixed identity'))).toBe(true);
        expect(mixed.anomalies.some((a) => a.includes('P-0011') && a.includes('ABSENT'))).toBe(true);
        const noEpochFp = buildEpochSample([row()], { startedAt: T0, fingerprint: '' }, new Set());
        expect(noEpochFp.anomalies[0]).toContain('no strategy fingerprint');
    });

    test('judgment purity: two distinct models is an anomaly; a missing model stamp is reported, not an anomaly', () => {
        const two = buildEpochSample([row(), row({ id: 'P-0012', model: 'openai:gpt-5.5' })], EPOCH, new Set());
        expect(two.anomalies.some((a) => a.includes('judgment purity'))).toBe(true);
        const one = buildEpochSample([row(), row({ id: 'P-0013', model: null })], EPOCH, new Set());
        expect(one.anomalies).toEqual([]);
        expect(one.unmodelled).toBe(1);
    });

    test('a missing planned-risk basis or commissions stays an anomaly (never a zero)', () => {
        const s = buildEpochSample([row({ commissions: null })], EPOCH, new Set());
        expect(s.trades).toEqual([]);
        expect(s.anomalies[0]).toContain('R undefined');
    });
});
