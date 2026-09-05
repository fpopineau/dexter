import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES, type RiskRules } from '@/tools/ibkr/risk-rules.js';
import type { CandidatePatch, CandidateRow } from './candidate-archive.js';
import { etFrameMs } from './outcome-tracker.js';
import { formatOvernightReport, gapPctOf, runOvernightBenchmarkOnce, twinSpec, type OvernightBenchDeps } from './overnight-benchmark.js';
import type { SimBar } from './simulator/fill-model.js';

const M = 60_000;
const rules: RiskRules = { ...DEFAULT_RULES, overnight_gap_stress_pct: 20 };
// Thursday 2026-09-10 15:35 ET; deadline Friday 10:00 ET
const CAPTURED = Date.UTC(2026, 8, 10, 19, 35, 0);
const DEADLINE = Date.UTC(2026, 8, 11, 14, 0, 0);
const NOW = Date.UTC(2026, 8, 11, 21, 15, 0); // Friday 17:15 ET

function row(over: Partial<CandidateRow> = {}): CandidateRow {
    return {
        id: 1, day: '2026-09-10', lane: 'overnight', symbol: 'MU', direction: 'long', capturedAt: CAPTURED, source: 'opportunity-snapshot:pre-close@1', rank: 78, rankerVersion: 'eod-continuation-v1',
        price: 100, dailyAtr: 3, dayMovePct: 4, eligible: true, reasons: [], levelsVersion: 'v1', entryType: 'MKT', entry: null, entryLimit: null, stop: 95.5, target: 104.5,
        exitDeadline: DEADLINE, detectorVersion: null, state: null, disposition: 'pending', dispositionRef: null, replayStatus: 'pending', barSource: null,
        fillAt: null, fillPrice: null, exitAt: null, exitPrice: null, outcome: null, gapPct: null, quantity: null, commissions: null, netUsd: null, netR: null, grossR: null,
        mfePct: null, maePct: null, replayedAt: null, note: null, ...over,
    };
}

/** RTH bars: capture day 15:36 → 16:00 flat around 100.2, next day 09:30 → 10:00 opening at `open` and drifting to `drift`. */
function bars(open: number, drift: number): SimBar[] {
    const out: SimBar[] = [];
    const t0 = etFrameMs(CAPTURED);
    for (let i = 1; i <= 25; i++) out.push({ t: t0 + i * M, open: 100.2, high: 100.4, low: 100.0, close: 100.2 });
    const d1 = etFrameMs(Date.UTC(2026, 8, 11, 13, 30, 0)); // 09:30 ET Friday
    for (let i = 0; i <= 30; i++) {
        const px = open + ((drift - open) * i) / 30;
        out.push({ t: d1 + i * M, open: px, high: px + 0.3, low: px - 0.3, close: px });
    }
    return out;
}

function deps(rows: CandidateRow[], barsBySymbol: Record<string, SimBar[] | null>, ledger: OvernightBenchDeps['ledgerSince'] = async () => ({ proposals: [], refusals: [] })) {
    const patches = new Map<number, CandidatePatch>();
    const d: OvernightBenchDeps = {
        now: NOW, rules, rungPct: 0.5, netLiq: 11_700, commissions: { perShareUsd: 0.005, minUsd: 1 },
        listPending: async () => rows.filter((r) => r.replayStatus === 'pending'),
        listDays: async (days) => rows.filter((r) => days.includes(r.day)).map((r) => ({ ...r, ...(patches.get(r.id!) ?? {}) })),
        update: async (id, patch) => { patches.set(id, { ...(patches.get(id) ?? {}), ...patch }); },
        loadBars: async (symbol) => { const b = barsBySymbol[symbol]; return b ? { bars: b, source: 'archive-1m' as const } : null; },
        isHalfDay: () => false,
        ledgerSince: ledger,
    };
    return { d, patches };
}

describe('twinSpec + gapPctOf (REQ-BENCH-004)', () => {
    test('the twin is MKT at the next bar, flat at the deadline; the gap is the next session\'s first open vs the capture price, signed', () => {
        const s = twinSpec(row())!;
        expect(s).toMatchObject({ entryType: 'MKT', stop: 95.5, target: 104.5, createdAt: etFrameMs(CAPTURED), flatAt: etFrameMs(DEADLINE) });
        expect(s.entryDeadline).toBe(etFrameMs(CAPTURED) + 60 * M);
        expect(gapPctOf(row(), bars(102, 103))).toBe(2);
        expect(gapPctOf(row({ direction: 'short' }), bars(102, 103))).toBe(-2);
        expect(gapPctOf(row(), bars(102, 103).slice(0, 25))).toBeNull(); // no next-session bar
        expect(twinSpec(row({ stop: null }))).toBeNull();
    });
});

describe('runOvernightBenchmarkOnce (REQ-BENCH-004/005)', () => {
    test('due rows replay once with the pessimistic model: flat at 10:00 (eod-flat), gap recorded, R at the rung; a stop through the open fills at the open', async () => {
        const rows = [row(), row({ id: 2, symbol: 'AMD', rank: 70 }), row({ id: 3, symbol: 'NOBR', rank: 65 }), row({ id: 4, symbol: 'LATE', exitDeadline: NOW + 3_600_000 })];
        const { d, patches } = deps(rows, { MU: bars(102, 103), AMD: bars(94, 93), NOBR: null });
        const { counts, reports } = await runOvernightBenchmarkOnce(d);
        expect(counts).toMatchObject({ due: 3, settled: 2, unknown: 1, expired: 0, notDue: 1, failed: 0, days: ['2026-09-10'] });
        const mu = patches.get(1)!;
        // fill at the first bar after capture (100.2), flat at the 10:00 bar close (103) → +2.8/share; qty = 0.5%×11,700 / 4.5 = 13 → gross 36.4 − $2 = 34.4; R vs 4.5×13 = 58.5
        expect(mu).toMatchObject({ replayStatus: 'settled', outcome: 'eod-flat', fillPrice: 100.2, quantity: 13, commissions: 2, gapPct: 2 });
        expect(mu.netUsd).toBeCloseTo(34.4, 2);
        expect(mu.netR).toBeCloseTo(34.4 / 58.5, 3);
        expect(mu.grossR).toBeCloseTo(2.8 / 4.5, 3); // size-invariant label: (103 − 100.2) / |100 − 95.5|
        const amd = patches.get(2)!;
        expect(amd.outcome).toBe('stop');
        expect(amd.exitPrice).toBe(94); // opened through the 95.5 stop → filled at the open
        expect(amd.gapPct).toBe(-6);
        expect(patches.get(3)).toMatchObject({ replayStatus: 'unknown', outcome: 'unknown' });
        // not due: no replay; the disposition join still runs over the day's rows
        expect(patches.get(4)?.replayStatus).toBeUndefined();
        expect(patches.get(4)?.disposition).toBe('not-admitted');
        expect(reports).toHaveLength(1);
        expect(reports[0]).toContain('4 eligible / 4 seen'); // LATE is eligible, just not due yet
        expect(reports[0]).toContain('unknown 1');
    });

    test('a row pending past the horizon expires as unknown; dispositions are joined and reported', async () => {
        const rows = [row(), row({ id: 5, symbol: 'OLD', capturedAt: NOW - 6 * 86_400_000, day: '2026-09-05' })];
        const { d, patches } = deps(rows, { MU: bars(101, 102) }, async () => ({
            proposals: [{ id: 'P-0200', symbol: 'MU', direction: 'long', strategyId: 'overnight', createdAt: CAPTURED + 60_000 }],
            refusals: [],
        }));
        const { counts, reports } = await runOvernightBenchmarkOnce(d);
        expect(counts.expired).toBe(1);
        expect(patches.get(5)).toMatchObject({ replayStatus: 'unknown', note: expect.stringContaining('expired') });
        expect(patches.get(1)).toMatchObject({ disposition: 'proposed', dispositionRef: 'P-0200' });
        expect(reports.some((r) => r.includes('judgment proposed 1 (P-0200 MU'))).toBe(true);
    });

    test('nothing pending → no reports, no updates', async () => {
        const { d, patches } = deps([row({ replayStatus: 'settled' })], {});
        const r = await runOvernightBenchmarkOnce(d);
        expect(r.counts.due).toBe(0);
        expect(r.reports).toEqual([]);
        expect(patches.size).toBe(0);
    });
});

describe('formatOvernightReport (REQ-BENCH-005 — the common perimeter)', () => {
    test('tallies ineligibility, universe / top-5 / judgment / not-admitted, gap median and adverse gaps', () => {
        // R in the report = GROSS R (size-invariant); net USD is shown for information
        const rows: CandidateRow[] = [
            row({ id: 1, symbol: 'A', rank: 90, replayStatus: 'settled', grossR: 1.0, netR: 0.9, netUsd: 50, gapPct: 1.5, disposition: 'proposed', dispositionRef: 'P-1' }),
            row({ id: 2, symbol: 'B', rank: 80, replayStatus: 'settled', grossR: -1.0, netR: -1.1, netUsd: -60, gapPct: -22, disposition: 'refused', dispositionRef: 'noise-stop' }),
            row({ id: 3, symbol: 'C', rank: 70, replayStatus: 'settled', grossR: 0.5, netR: 0.4, netUsd: 20, gapPct: 0.5, disposition: 'not-admitted' }),
            row({ id: 4, symbol: 'D', rank: 60, eligible: false, reasons: ['counter-move'], replayStatus: 'skipped' }),
            row({ id: 5, symbol: 'E', rank: 55, eligible: false, reasons: ['counter-move', 'earnings-within-2d'], replayStatus: 'skipped' }),
        ];
        const s = formatOvernightReport('2026-09-10', rows, rules);
        expect(s).toContain('3 eligible / 5 seen (ineligible: counter-move 2, earnings-within-2d 1)');
        expect(s).toContain('n 3 meanR +0.17 ΣR +0.50 W2/L1/F0 · net $10 at the budget');
        expect(s).toContain('(pre-close snapshots, first sightings)');
        expect(s).toContain('gap median +0.5%, adverse ≥20%: 1');
        expect(s).toContain('top-5 by rank: n 3 meanR +0.17');
        expect(s).toContain('judgment proposed 1 (P-1 A +1.00R) · refused 1 (B:noise-stop) · not admitted n 1 meanR +0.50');
    });
});
