import { describe, expect, test } from 'bun:test';
import { formatSettleReport, summarizeVariants, twinCalibration } from './report.js';
import type { SimTrade } from './store.js';

const DAY = 86_400_000;
const T = Date.UTC(2026, 8, 10, 14, 0, 0);

function row(overrides: Partial<SimTrade> = {}): SimTrade {
    return {
        variant: 'incumbent', sourceKind: 'proposal', sourceId: 'P-0001', symbol: 'MU', direction: 'long', tradeClass: 'intraday',
        entryType: 'LMT', entry: 100, entryLimit: null, stop: 97, target: 106, quantity: 10, tif: 'DAY', createdAt: T,
        barSource: 'archive-1m', fillAt: T + 60_000, fillPrice: 100, exitAt: T + 3_600_000, exitPrice: 106, outcome: 'target',
        commissions: 2, netUsd: 58, netR: 58 / 30, status: 'settled', biasNote: 'pessimistic', settledAt: T + DAY, horizonDays: 1, note: null,
        ...overrides,
    };
}

describe('summarizeVariants (the digest input, REQ-SIM-001/006)', () => {
    test('per variant: n settled with R, distinct days, summed and mean R, wins/losses/flats, open and unknown counted apart', () => {
        const rows = [
            row(),
            row({ sourceId: 'P-0002', outcome: 'stop', exitPrice: 97, netUsd: -32, netR: -32 / 30, createdAt: T + DAY }),
            row({ sourceId: 'P-0003', outcome: 'eod-flat', exitPrice: 100.5, netUsd: 3, netR: 0.1, createdAt: T + DAY }),
            row({ sourceId: 'P-0004', outcome: 'open', status: 'open', exitAt: null, exitPrice: null, netUsd: null, netR: null }),
            row({ sourceId: 'P-0005', outcome: 'unknown', status: 'unknown', exitAt: null, exitPrice: null, netUsd: null, netR: null }),
            row({ variant: 'exit-x2.0', sourceId: 'P-0001', outcome: 'stop', exitPrice: 97, netUsd: -32, netR: -32 / 30 }),
        ];
        const s = summarizeVariants(rows);
        const inc = s.find((v) => v.variant === 'incumbent')!;
        expect(inc.n).toBe(3);
        expect(inc.days).toBe(2);
        expect(inc.sumR).toBeCloseTo(58 / 30 - 32 / 30 + 0.1, 6);
        expect(inc.meanR).toBeCloseTo(inc.sumR / 3, 6);
        expect(inc.wins).toBe(1); expect(inc.losses).toBe(1); expect(inc.flats).toBe(1);
        expect(inc.open).toBe(1); expect(inc.unknown).toBe(1);
        expect(inc.netUsd).toBeCloseTo(29, 6);
        const x2 = s.find((v) => v.variant === 'exit-x2.0')!;
        expect(x2.n).toBe(1);
        expect(x2.meanR).toBeCloseTo(-32 / 30, 6);
    });
});

describe('twinCalibration (REQ-SIM-001 — the incumbent twin vs the actual fills)', () => {
    test('slippage in bps and outcome agreement over executed proposals with actual fills; rows without actuals are counted, not compared', () => {
        const twins = [
            row({ sourceId: 'P-0001', fillPrice: 100, outcome: 'target' }),
            row({ sourceId: 'P-0002', fillPrice: 50, outcome: 'stop' }),
            row({ sourceId: 'P-0003', fillPrice: 20, outcome: 'target' }),
        ];
        const actuals = new Map([
            ['P-0001', { entryFillPrice: 100.1, exitReason: 'target' as const }],
            ['P-0002', { entryFillPrice: 50, exitReason: 'manual' as const }],
        ]);
        const c = twinCalibration(twins, actuals);
        expect(c.compared).toBe(2);
        expect(c.missingActual).toBe(1);
        expect(c.meanEntrySlippageBps).toBeCloseTo(4.995, 2); // |100.1 − 100| / 100.1 ≈ 9.99 bps for one, 0 for the other
        expect(c.outcomeAgreement).toBeCloseTo(0.5, 6);   // target=target agrees; stop vs manual does not
    });
});

describe('formatSettleReport', () => {
    test('one compact line per variant plus the twin line; inactive variants are named', () => {
        const msg = formatSettleReport({
            date: '2026-09-10',
            summaries: summarizeVariants([row(), row({ variant: 'exit-x2.0', outcome: 'stop', exitPrice: 97, netUsd: -32, netR: -32 / 30 })]),
            twin: { compared: 1, missingActual: 0, meanEntrySlippageBps: 4.2, outcomeAgreement: 1 },
            inactive: ['weights-calibrated'],
            run: { sources: 1, evaluated: 2, settled: 2, open: 0, unknown: 0, skipped: 0, failed: 0 },
        });
        expect(msg).toContain('incumbent');
        expect(msg).toContain('exit-x2.0');
        expect(msg).toContain('twin');
        expect(msg).toContain('weights-calibrated');
        expect(msg).toContain('pessimistic');
    });
});
