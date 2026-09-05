import { describe, expect, test } from 'bun:test';
import { selectDueDeadlines, sweepDeadlinesOnce } from './lane-deadline-sweeper.js';
import type { TradeProposal } from './trade-proposals.js';

const T0 = Date.UTC(2026, 8, 11, 14, 0, 0); // 10:00 ET

function row(over: Partial<TradeProposal> = {}): TradeProposal {
    return {
        id: 'P-OVN1', createdAt: T0 - 20 * 3_600_000, expiresAt: T0 - 19 * 3_600_000, updatedAt: T0, status: 'executed', symbol: 'MU', direction: 'long',
        entryType: 'LMT', entry: 100, entryLimit: null, stop: 97, target: 106, quantity: 4, tif: 'GTC', tradeClass: 'swing', worstCaseGapPct: null, score: 66,
        rationale: 'x', source: 'cron:Pre-Close Review', orderIds: [1, 2, 3], orderPermIds: null, plannedQuantity: null, model: null, strategyFingerprint: null,
        strategyId: 'overnight', setupId: 'eod-continuation', holdingHorizon: 'next-session', exitPolicyId: 'bracket+deadline', exitDeadline: T0, deadlineClosedAt: null, detectorVersion: null, costToTargetPct: null, laneRank: null, rankerVersion: null,
        regime: null, note: null, executedAt: T0 - 20 * 3_600_000, entryFillPrice: 100.1, entryFilledAt: T0 - 19.5 * 3_600_000, exitFillPrice: null, exitReason: null,
        realizedPnl: null, commissions: null, closedAt: null, keptOvernightAt: null, mfePct: null, maePct: null, extensionAtr: null, vwapDistPct: null, dayMovePct: null,
        minutesSinceOpen: null, takePct: null, takePctSource: null, postExitMfePct: null, postExitMaePct: null, takeCounterfactual: null, dailyAtrAtCreation: 4,
        triggerRank: null, triggerBand: null, autoExecuteAt: null, spreadDeferred: false, ...over,
    };
}

describe('selectDueDeadlines (pure)', () => {
    test('executed, filled, deadline passed, never attempted — nothing else', () => {
        const rows = [
            row(),
            row({ id: 'P-LATR', exitDeadline: T0 + 60_000 }),          // not yet
            row({ id: 'P-DONE', deadlineClosedAt: T0 - 1 }),           // attempted
            row({ id: 'P-NONE', exitDeadline: null }),                 // no deadline (intraday)
            row({ id: 'P-CLSD', status: 'closed' }),
            row({ id: 'P-UNFL', entryFillPrice: null }),
        ];
        expect(selectDueDeadlines(rows, T0).map((r) => r.id)).toEqual(['P-OVN1']);
        expect(selectDueDeadlines(rows, T0 + 60_000).map((r) => r.id)).toEqual(['P-OVN1', 'P-LATR']);
    });
});

describe('sweepDeadlinesOnce (REQ-LANE-003 — one attempt, safe close path, incidents surfaced)', () => {
    test('due + open position → stamped then closed; bracket already exited → stamped without an order', async () => {
        const marks: string[] = [];
        const closes: string[] = [];
        const r = await sweepDeadlinesOnce({
            now: T0,
            listDue: async () => [row(), row({ id: 'P-FLAT', symbol: 'AMD' })],
            positions: async () => [{ symbol: 'MU', quantity: 4 }],
            close: async (symbol, reason) => { closes.push(`${symbol}|${reason}`); return { ok: true, message: 'Closed.', state: 'filled', flat: true }; },
            markClosed: async (id, _at, note) => { marks.push(`${id}:${note.split(' ').slice(0, 3).join(' ')}`); },
        });
        expect(r).toMatchObject({ due: 2, closed: 1, alreadyFlat: 1, incidents: [] });
        expect(closes).toEqual(['MU|lane deadline (overnight)']);
        expect(marks[0]).toBe('P-OVN1:lane deadline close');
        expect(marks[1]).toBe('P-FLAT:lane deadline reached');
    });

    test('a close that does not confirm flat is an incident (alert), still stamped so it is not re-fired; a throwing close is an incident too', async () => {
        const alerts: string[] = [];
        const marks: string[] = [];
        const r = await sweepDeadlinesOnce({
            now: T0,
            listDue: async () => [row(), row({ id: 'P-THRW', symbol: 'NVDA' })],
            positions: async () => [{ symbol: 'MU', quantity: 4 }, { symbol: 'NVDA', quantity: 2 }],
            close: async (symbol) => { if (symbol === 'NVDA') throw new Error('IBKR timeout'); return { ok: false, message: 'close order working, not filled' }; },
            markClosed: async (id) => { marks.push(id); },
            alert: (m) => { alerts.push(m); },
        });
        expect(r.closed).toBe(0);
        expect(r.incidents).toHaveLength(2);
        expect(alerts[0]).toContain("kill MU");
        expect(alerts[1]).toContain('IBKR timeout');
        expect(marks).toEqual(['P-OVN1', 'P-THRW']);
    });

    test('nothing due → no position fetch, no orders', async () => {
        const r = await sweepDeadlinesOnce({
            now: T0, listDue: async () => [], positions: async () => { throw new Error('must not run'); },
            close: async () => { throw new Error('must not run'); }, markClosed: async () => {},
        });
        expect(r).toEqual({ due: 0, closed: 0, alreadyFlat: 0, incidents: [] });
    });
});
