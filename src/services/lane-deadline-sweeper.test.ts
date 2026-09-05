import { describe, expect, test } from 'bun:test';
import { DEADLINE_MAX_ATTEMPTS, DEADLINE_RETRY_COOLDOWN_MS, selectDueDeadlines, sweepDeadlinesOnce } from './lane-deadline-sweeper.js';
import type { TradeProposal } from './trade-proposals.js';

const T0 = Date.UTC(2026, 8, 11, 14, 0, 0); // 10:00 ET

function row(over: Partial<TradeProposal> = {}): TradeProposal {
    return {
        id: 'P-OVN1', createdAt: T0 - 20 * 3_600_000, expiresAt: T0 - 19 * 3_600_000, updatedAt: T0, status: 'executed', symbol: 'MU', direction: 'long',
        entryType: 'LMT', entry: 100, entryLimit: null, stop: 97, target: 106, quantity: 4, tif: 'GTC', tradeClass: 'swing', worstCaseGapPct: null, score: 66,
        rationale: 'x', source: 'cron:Pre-Close Review', orderIds: [1, 2, 3], orderPermIds: null, plannedQuantity: null, model: null, strategyFingerprint: null,
        strategyId: 'overnight', setupId: 'eod-continuation', holdingHorizon: 'next-session', exitPolicyId: 'bracket+deadline', exitDeadline: T0, deadlineClosedAt: null,
        deadlineAttemptedAt: null, deadlineAttempts: 0, snapshotTs: null, detectorVersion: null, costToTargetPct: null, laneRank: null, rankerVersion: null,
        regime: null, note: null, executedAt: T0 - 20 * 3_600_000, entryFillPrice: 100.1, entryFilledAt: T0 - 19.5 * 3_600_000, exitFillPrice: null, exitReason: null,
        realizedPnl: null, commissions: null, closedAt: null, keptOvernightAt: null, mfePct: null, maePct: null, extensionAtr: null, vwapDistPct: null, dayMovePct: null,
        minutesSinceOpen: null, takePct: null, takePctSource: null, postExitMfePct: null, postExitMaePct: null, takeCounterfactual: null, dailyAtrAtCreation: 4,
        triggerRank: null, triggerBand: null, autoExecuteAt: null, spreadDeferred: false, ...over,
    };
}

describe('selectDueDeadlines (pure — review 2026-09-06 finding 3: an attempt is not a close)', () => {
    test('executed, filled, deadline passed, not confirmed closed, cooldown elapsed, attempts left — nothing else', () => {
        const rows = [
            row(),
            row({ id: 'P-LATR', exitDeadline: T0 + 60_000 }),                                   // not yet
            row({ id: 'P-DONE', deadlineClosedAt: T0 - 1 }),                                    // confirmed closed
            row({ id: 'P-NONE', exitDeadline: null }),                                          // no deadline (intraday)
            row({ id: 'P-CLSD', status: 'closed' }),
            row({ id: 'P-UNFL', entryFillPrice: null }),
            row({ id: 'P-COOL', deadlineAttemptedAt: T0 - 60_000, deadlineAttempts: 1 }),       // attempted a minute ago: cooling down
            row({ id: 'P-RTRY', deadlineAttemptedAt: T0 - DEADLINE_RETRY_COOLDOWN_MS, deadlineAttempts: 1 }), // cooldown elapsed: retry
            row({ id: 'P-EXHS', deadlineAttemptedAt: T0 - 3_600_000, deadlineAttempts: DEADLINE_MAX_ATTEMPTS }), // exhausted: operator's
        ];
        expect(selectDueDeadlines(rows, T0).map((r) => r.id)).toEqual(['P-OVN1', 'P-RTRY']);
        expect(selectDueDeadlines(rows, T0 + 60_000).map((r) => r.id)).toEqual(['P-OVN1', 'P-LATR', 'P-RTRY']);
    });
});

describe('sweepDeadlinesOnce (REQ-LANE-003 — attempt before the order, closed only when confirmed flat)', () => {
    test('due + open position → attempt recorded, close confirmed → closed stamped; bracket already exited → closed without an order', async () => {
        const attempts: string[] = [];
        const closedMarks: string[] = [];
        const closes: string[] = [];
        const r = await sweepDeadlinesOnce({
            now: T0,
            listDue: async () => [row(), row({ id: 'P-FLAT', symbol: 'AMD' })],
            positions: async () => [{ symbol: 'MU', quantity: 4 }],
            close: async (symbol, reason) => { closes.push(`${symbol}|${reason}`); return { ok: true, message: 'Closed.', state: 'filled', flat: true }; },
            markAttempt: async (id, _at, note) => { attempts.push(`${id}:${note}`); },
            markClosed: async (id, _at, note) => { closedMarks.push(`${id}:${note.split(' ').slice(0, 4).join(' ')}`); },
        });
        expect(r).toMatchObject({ due: 2, closed: 1, alreadyFlat: 1, incidents: [] });
        expect(closes).toEqual(['MU|lane deadline (overnight)']);
        expect(attempts).toEqual(['P-OVN1:lane deadline close attempt 1/3 (overnight)']);
        expect(closedMarks).toEqual(['P-OVN1:lane deadline close confirmed', 'P-FLAT:lane deadline reached with']);
    });

    test('a close that does not confirm flat is an incident and stays OPEN for a retry (attempt recorded, close mark absent); the last attempt hands the row to the operator', async () => {
        const alerts: string[] = [];
        const attempts: string[] = [];
        const closedMarks: string[] = [];
        const r = await sweepDeadlinesOnce({
            now: T0,
            listDue: async () => [row(), row({ id: 'P-THRW', symbol: 'NVDA', deadlineAttempts: DEADLINE_MAX_ATTEMPTS - 1, deadlineAttemptedAt: T0 - 3_600_000 })],
            positions: async () => [{ symbol: 'MU', quantity: 4 }, { symbol: 'NVDA', quantity: 2 }],
            close: async (symbol) => { if (symbol === 'NVDA') throw new Error('IBKR timeout'); return { ok: false, message: 'close order working, not filled' }; },
            markAttempt: async (id) => { attempts.push(id); },
            markClosed: async (id) => { closedMarks.push(id); },
            alert: (m) => { alerts.push(m); },
        });
        expect(r.closed).toBe(0);
        expect(r.incidents).toHaveLength(2);
        expect(attempts).toEqual(['P-OVN1', 'P-THRW']);
        expect(closedMarks).toEqual([]); // neither is closed — both remain due after the cooldown / for the operator
        expect(alerts[0]).toContain('attempt 1/3');
        expect(alerts[0]).toContain('Retry in 5 min');
        expect(alerts[1]).toContain('Retries exhausted');
        expect(alerts[1]).toContain("kill NVDA");
        expect(alerts[1]).toContain('IBKR timeout');
    });

    test('nothing due → no position fetch, no orders', async () => {
        const r = await sweepDeadlinesOnce({
            now: T0, listDue: async () => [], positions: async () => { throw new Error('must not run'); },
            close: async () => { throw new Error('must not run'); }, markAttempt: async () => {}, markClosed: async () => {},
        });
        expect(r).toEqual({ due: 0, closed: 0, alreadyFlat: 0, incidents: [] });
    });
});
