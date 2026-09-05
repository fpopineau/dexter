import { describe, expect, test } from 'bun:test';
import { buildDigest, formatDigestWhatsApp, truncateSection, type DigestInputs } from './digest.js';
import type { LoopStatus } from './looks.js';
import type { TradeProposal } from '../trade-proposals.js';

const T0 = Date.UTC(2026, 8, 10, 14, 0, 0);

function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
    return {
        id: 'P-0001', createdAt: T0, expiresAt: T0 + 1, updatedAt: T0, status: 'closed', symbol: 'MU', direction: 'long', entryType: 'LMT', entry: 100,
        entryLimit: null, stop: 97, target: 106, quantity: 10, tif: 'DAY', tradeClass: 'intraday', worstCaseGapPct: null, score: 66, rationale: 'x', source: 'trigger',
        orderIds: [1, 2, 3], orderPermIds: null, plannedQuantity: null, model: null, strategyFingerprint: null, regime: null, note: null, executedAt: T0, entryFillPrice: 100.05, entryFilledAt: T0 + 60_000,
        exitFillPrice: 106, exitReason: 'target', realizedPnl: 59.5, commissions: 2, closedAt: T0 + 3_600_000, keptOvernightAt: null, mfePct: null, maePct: null,
        extensionAtr: null, vwapDistPct: null, dayMovePct: null, minutesSinceOpen: null, takePct: 6, takePctSource: 'formula', postExitMfePct: null, postExitMaePct: null,
        takeCounterfactual: null, dailyAtrAtCreation: 4, triggerRank: 66, triggerBand: '60-74', autoExecuteAt: null, spreadDeferred: false, ...overrides,
    };
}

const status: LoopStatus = {
    at: T0, constantsOk: true, openInCohort: 1, looksThisPass: [], anomalies: [], stoppedThisPass: null, shadowSample: null,
    epoch: { id: 'epoch-1', startedAt: T0 - 86_400_000, fingerprint: 'abcdef123456', status: 'running', constantsHash: 'c', netLiq: 12_000, looksDone: [], looks: [], stepUpEligible: null, promotionPending: null },
    sample: { n: 7, days: 4, sumR: 2.1, meanR: 0.3, profitFactor: 1.6, netUsd: 63, nextLook: 25, informational: true },
    band: { band: '60-74', n: 4, netUsd: 12, sumR: 0.4, profitFactor: 1.2, barMet: null },
    shadow: [
        { variant: 'incumbent', status: 'active', summary: { variant: 'incumbent', n: 7, days: 4, sumR: 2.1, meanR: 0.3, netUsd: 63, wins: 4, losses: 3, flats: 0, open: 0, unknown: 1, unfilled: 2 }, diff: null, candidate: false },
        { variant: 'exit-x2.0', status: 'active', summary: { variant: 'exit-x2.0', n: 7, days: 4, sumR: 2.9, meanR: 0.41, netUsd: 87, wins: 4, losses: 3, flats: 0, open: 0, unknown: 1, unfilled: 2 }, diff: { days: 4, lcb: -0.2, median: 0.1, meanDiff: 0.11 }, candidate: false },
        { variant: 'weights-calibrated', status: 'inactive: awaiting calibrated weights (WP3)', summary: null, diff: null, candidate: false },
    ],
    ladder: { state: { rung: 0.25 }, rung: 0.25, ceilingPct: 0.5, effectivePct: 0.25, eligibility: { eligible: false, nextRung: 0.5, milestone: 25, reason: 'n 7 < 25' } },
    models: ['anthropic:claude-sonnet-5'],
    drawdown: { epochNetLiq: 12_000, minNetLiq: 11_880, pct: -1, samples: 300 },
    decile: { rho: 0.12, p: 0.4, n: 7 },
};

const inputs: DigestInputs = {
    today: '2026-09-10', dayStartMs: T0 - 10 * 3_600_000, status,
    proposalsToday: [proposal(), proposal({ id: 'P-0002', symbol: 'AMD', source: 'cron:Midday Check', status: 'executed', entryFillPrice: null, entryFilledAt: null, exitFillPrice: null, exitReason: null, realizedPnl: null, commissions: null, closedAt: null })],
    refusalsToday: [
        { id: 1, createdAt: T0, symbol: 'X', direction: 'long', entryType: 'LMT', entry: 1, entryLimit: null, stop: 1, target: 1, quantity: 1, score: 60, reason: 'r', gate: 'noise-stop', outcome: null, outcomeNote: null, mfePct: null, maePct: null, proposalAgeSec: null, livePrice: null, triggerRank: 62 },
        { id: 2, createdAt: T0, symbol: 'Y', direction: 'long', entryType: 'EVAL', entry: null, entryLimit: null, stop: null, target: null, quantity: null, score: null, reason: 'spend cap: …', gate: 'spend-cap', outcome: null, outcomeNote: null, mfePct: null, maePct: null, proposalAgeSec: null, livePrice: null, triggerRank: 61 },
    ],
    triggersToday: { single: 9, breadth: 1 },
    scannedToday: 143,
    spend: { date: '2026-09-10', totalUsd: 4.2, byLane: { trigger: { runs: 9, inputTokens: 1, outputTokens: 1, usd: 4.2 } } },
    twins: new Map([['P-0001', { variant: 'incumbent', sourceKind: 'proposal', sourceId: 'P-0001', symbol: 'MU', direction: 'long', tradeClass: 'intraday', entryType: 'LMT', entry: 100, entryLimit: null, stop: 97, target: 106, quantity: 10, tif: 'DAY', createdAt: T0, barSource: 'archive-1m', fillAt: 1, fillPrice: 100, exitAt: 2, exitPrice: 106, outcome: 'target', commissions: 2, netUsd: 58, netR: 58 / 30, status: 'settled', biasNote: 'p', settledAt: 3, horizonDays: 1, note: null }]]),
};

describe('loop digest (REQ-DIGEST-001..005)', () => {
    test('fills: planned vs actual with bps, commissions, net, the twin fill; epoch totals in the head line', () => {
        const d = buildDigest(inputs);
        expect(d.sections.fills[0]).toContain('Fills today: 1');
        expect(d.sections.fills[0]).toContain('epoch n 7');
        expect(d.sections.fills[1]).toContain('MU long ×10');
        expect(d.sections.fills[1]).toContain('5.0bps');
        expect(d.sections.fills[1]).toContain('twin fill 100.00 target');
    });

    test('funnel: scanned → triggered → evaluated (minus spend-cap refusals) → proposed → executed, lanes, gates, LLM USD', () => {
        const f = buildDigest(inputs).sections.funnel;
        expect(f[0]).toBe('Funnel: scanned 143 → triggered 10 (single 9, breadth 1) → evaluated 9 → proposed 2 → executed 2');
        expect(f[1]).toContain('trigger 1/1');
        expect(f[1]).toContain('cron:Midday Check 1/1');
        expect(f[2]).toContain('noise-stop 1');
        expect(f[3]).toContain('$4.20 today');
        expect(f[3]).toContain('spend-cap refusals 1');
    });

    test('shadow: per-variant line with the difference bounds; inactive named; the band line with its bar state', () => {
        const s = buildDigest(inputs).sections.shadow;
        expect(s.find((l) => l.startsWith('exit-x2.0'))).toContain('ΔR LCB -0.200');
        expect(s.find((l) => l.startsWith('weights-calibrated'))).toContain('inactive');
        expect(s[s.length - 1]).toContain("band '60-74'");
        expect(s[s.length - 1]).toContain('not yet judged');
    });

    test('status: epoch line, deployable stats with the next look, drawdown, ladder, deciles', () => {
        const st = buildDigest(inputs).sections.status;
        expect(st[0]).toContain('epoch-1 RUNNING');
        expect(st[1]).toContain('n 7');
        expect(st[1]).toContain('next look at n=25');
        expect(st.some((l) => l.includes('Drawdown from epoch: -1.00%'))).toBe(true);
        expect(st.some((l) => l.includes('Ladder: rung 0.25%') && l.includes('effective risk 0.25% (ceiling 0.5%)') && l.includes('n ≥ 25'))).toBe(true);
        expect(st.some((l) => l.startsWith('Judgment: anthropic:claude-sonnet-5'))).toBe(true);
        expect(st.some((l) => l.includes('Spearman rho 0.12'))).toBe(true);
    });

    test('WhatsApp format caps each section at 12 lines and points to the dashboard for the rest', () => {
        const many = Array.from({ length: 30 }, (_, i) => `line ${i}`);
        const t = truncateSection(many);
        expect(t).toHaveLength(12);
        expect(t[11]).toContain('19 more');
        const msg = formatDigestWhatsApp(buildDigest(inputs));
        expect(msg).toContain('Loop digest 2026-09-10');
        expect(msg).toContain('*Test status*');
    });
});
