import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EquitySample } from '@/utils/equity-series-math.js';
import type { RTrade } from '@/utils/sequential-test.js';
import type { SimTrade } from '../simulator/store.js';
import { readEpochRecord, startEpoch } from './epoch-control.js';
import { runNightlyLooks, shadowLines, type LooksDeps } from './looks.js';
import type { EpochSample } from './sample.js';

const T0 = Date.UTC(2026, 8, 10, 14, 0, 0);
const DAY = 86_400_000;

function rtrades(rs: number[], band: '60-74' | '75+' = '75+'): RTrade[] {
    return rs.map((r, i) => ({ id: `P-${i}`, entryDay: `2026-09-${String(10 + (i % 12)).padStart(2, '0')}`, closedAt: T0 + i * 60_000, netR: r, netUsd: r * 30, band, tradeClass: 'intraday', score: 60 + (i % 30) }));
}

function simRow(variant: string, id: string, netR: number, dayOffset: number): SimTrade {
    return {
        variant, sourceKind: 'proposal', sourceId: id, symbol: 'X', direction: 'long', tradeClass: 'intraday', entryType: 'LMT', entry: 100, entryLimit: null,
        stop: 97, target: 106, quantity: 10, tif: 'DAY', createdAt: T0 + dayOffset * DAY, barSource: 'archive-1m', fillAt: 1, fillPrice: 100, exitAt: 2, exitPrice: 100 + 3 * netR,
        outcome: netR > 0 ? 'target' : 'stop', commissions: 2, netUsd: netR * 30, netR, status: 'settled', biasNote: 'pessimistic', settledAt: 3, horizonDays: 1, note: null,
    };
}

function harness(sample: Partial<EpochSample> = {}, opts: { equity?: EquitySample[]; triageFailed?: boolean; sim?: SimTrade[]; ceilingPct?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dexter-looks-'));
    const journal: string[] = [];
    const alerts: string[] = [];
    startEpoch({ now: T0, dataDir: dir, netLiqUsd: 12_000, fingerprint: 'fp', setBaseline: () => {}, journal: () => {} });
    const deps: LooksDeps = {
        now: T0 + 5 * DAY,
        dataDir: dir,
        ceilingPct: opts.ceilingPct ?? 1.0,
        loadSample: async () => ({ trades: [], shadowTrades: [], anomalies: [], openInCohort: 0, models: [], unmodelled: 0, ...sample }),
        listSimRows: async () => opts.sim ?? [],
        equitySeries: () => opts.equity ?? [{ ts: T0 + 1000, netLiq: 12_000 }],
        triageFailedToday: () => opts.triageFailed ?? false,
        journal: (l) => { journal.push(l); },
        alert: (m) => { alerts.push(m); },
    };
    return { dir, deps, journal, alerts };
}

describe('runNightlyLooks (REQ-SEQ-002/003/007, REQ-EPOCH-002)', () => {
    test('no epoch → nothing evaluated, one anomaly naming `epoch new`', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'dexter-looks-none-'));
        const st = await runNightlyLooks({ now: T0, dataDir: dir, ceilingPct: 0.5, loadSample: async () => ({ trades: [], shadowTrades: [], anomalies: [], openInCohort: 0, models: [], unmodelled: 0 }), listSimRows: async () => [], equitySeries: () => [], triageFailedToday: () => false, journal: () => {} });
        expect(st.epoch).toBeNull();
        expect(st.anomalies[0]).toContain('epoch new');
    });

    test('below the first boundary: informational running stats, no look, no journal decision', async () => {
        const h = harness({ trades: rtrades([1, -0.5, 1.2]) });
        const st = await runNightlyLooks(h.deps);
        expect(st.looksThisPass).toEqual([]);
        expect(st.sample?.n).toBe(3);
        expect(st.sample?.nextLook).toBe(25);
        expect(st.sample?.informational).toBe(true);
        expect(h.journal.filter((l) => l.includes('LOOK'))).toEqual([]);
    });

    test('reaching n=25 evaluates ONCE, records the look, and a strong sample ACCEPTs with an alert; the next pass evaluates nothing new', async () => {
        const h = harness({ trades: rtrades(Array.from({ length: 27 }, (_, i) => (i % 5 === 0 ? -1 : 1.5))) });
        const st = await runNightlyLooks(h.deps);
        expect(st.looksThisPass).toHaveLength(1);
        expect(st.looksThisPass[0].lookN).toBe(25);
        expect(st.looksThisPass[0].decision).toBe('ACCEPT');
        const rec = readEpochRecord(h.dir)!;
        expect(rec.looksDone).toEqual([25]);
        expect(rec.firstAcceptAt).toBe(h.deps.now);
        expect(rec.status).toBe('running');
        expect(h.alerts.some((a) => a.includes('ACCEPT'))).toBe(true);
        const again = await runNightlyLooks({ ...h.deps, now: h.deps.now + DAY });
        expect(again.looksThisPass).toEqual([]);
    });

    test('REJECT stops the epoch (status stopped, reason names the look, live switch off)', async () => {
        const h = harness({ trades: rtrades(Array.from({ length: 26 }, (_, i) => (i % 4 === 0 ? 0.5 : -1))) });
        const st = await runNightlyLooks(h.deps);
        expect(st.looksThisPass[0].decision).toBe('REJECT');
        expect(st.stoppedThisPass).toContain('REJECT look at n=25');
        expect(readEpochRecord(h.dir)?.status).toBe('stopped');
    });

    test("REQ-SEQ-007: a strong deployable sample cannot ACCEPT while the '60-74' band reads negative at n ≥ 20", async () => {
        const good = rtrades(Array.from({ length: 26 }, (_, i) => (i % 5 === 0 ? -1 : 1.5)), '75+');
        // The band rows close AFTER the first 25 (the look evaluates the close-order prefix — AUD-12); the band bar is judged on the whole sample.
        const badBand = rtrades(Array.from({ length: 20 }, () => -0.2), '60-74').map((t, i) => ({ ...t, id: `B-${i}`, closedAt: T0 + (100 + i) * 60_000, entryDay: `2026-09-${String(10 + (i % 12)).padStart(2, '0')}` }));
        const h = harness({ trades: [...good, ...badBand] });
        const st = await runNightlyLooks(h.deps);
        // 46 trades → looks 25 evaluated; the band withholds ACCEPT
        const look = st.looksThisPass.find((l) => l.lookN === 25)!;
        expect(look.decision).toBe('CONTINUE');
        expect(look.reasons.join(' ')).toContain('band');
        expect(st.band?.barMet).toBe(false);
    });

    test('constants mismatch → looks NOT EVALUABLE (no decision recorded); an EOD triage stamped failed stops the epoch', async () => {
        const h = harness({ trades: rtrades(Array.from({ length: 30 }, () => 1)) });
        const rec = readEpochRecord(h.dir)!;
        writeFileSync(join(h.dir, 'epoch-state.json'), JSON.stringify({ ...rec, constantsHash: 'deadbeef0000' }));
        const st = await runNightlyLooks(h.deps);
        expect(st.constantsOk).toBe(false);
        expect(st.looksThisPass).toEqual([]);
        expect(readEpochRecord(h.dir)?.looksDone).toEqual([]);

        const h2 = harness({ trades: rtrades([1, 1]) }, { triageFailed: true });
        const st2 = await runNightlyLooks(h2.deps);
        expect(st2.stoppedThisPass).toContain('triage');
        expect(readEpochRecord(h2.dir)?.status).toBe('stopped');
    });

    test('a planned-risk anomaly freezes the looks (recorded, not decided); step-up eligibility is queued in the epoch record', async () => {
        const h = harness({ trades: rtrades(Array.from({ length: 30 }, () => 1)), anomalies: ['P-BAD X: commissions missing'] });
        const st = await runNightlyLooks(h.deps);
        expect(st.looksThisPass).toEqual([]);
        expect(st.anomalies[0]).toContain('P-BAD');
        // eligibility still computed (n 30 ≥ 25, net R > 0, no stop)
        expect(st.ladder.eligibility?.eligible).toBe(true);
        expect(readEpochRecord(h.dir)?.stepUpEligible?.nextRung).toBe(0.5);
    });

    test('AUD-09: with the live ceiling at 0.5% a step-up beyond it is never queued; the status carries rung, ceiling and effective risk', async () => {
        const h = harness({ trades: rtrades(Array.from({ length: 60 }, () => 1)) }, { ceilingPct: 0.5 });
        const { writeLadderState } = await import('./ladder-control.js');
        writeLadderState({ rung: 0.5, since: 'x', lastStepUpNetLiq: 12_000 }, h.dir);
        const st = await runNightlyLooks(h.deps);
        expect(st.ladder.rung).toBe(0.5);
        expect(st.ladder.ceilingPct).toBe(0.5);
        expect(st.ladder.effectivePct).toBe(0.5);
        expect(st.ladder.eligibility?.eligible).toBe(false);
        expect(st.ladder.eligibility?.reason).toContain('ceiling');
        expect(readEpochRecord(h.dir)?.stepUpEligible).toBeNull();
    });

    test('AUD-11: the sample loader receives the epoch fingerprint, and its anomalies freeze the looks', async () => {
        let seenFp = null as string | null;
        const h = harness({ trades: rtrades(Array.from({ length: 30 }, () => 1)) });
        const st = await runNightlyLooks({
            ...h.deps,
            loadSample: async (_ms, fp) => { seenFp = fp; return { trades: rtrades(Array.from({ length: 30 }, () => 1)), shadowTrades: [], anomalies: ['P-X MU: fingerprint aaaaaaaaaaaa ≠ epoch fp — mixed identity in the cohort'], openInCohort: 0, models: ['m1', 'm2'], unmodelled: 0 }; },
        });
        expect(seenFp).toBe('fp');
        expect(st.looksThisPass).toEqual([]);
        expect(st.models).toEqual(['m1', 'm2']);
        expect(st.anomalies[0]).toContain('mixed identity');
    });

    test('the hard stop is re-checked at night from the marked series', async () => {
        const h = harness({ trades: rtrades([1]) }, { equity: [{ ts: T0 + 1000, netLiq: 12_000 }, { ts: T0 + DAY, netLiq: 11_300 }] });
        const st = await runNightlyLooks(h.deps);
        expect(st.stoppedThisPass).toContain('hard stop');
        expect(st.drawdown?.minNetLiq).toBe(11_300);
    });
});

describe('shadowLines (REQ-SEQ-006)', () => {
    test('per variant: summary, difference bounds vs the incumbent, promotion-candidate flag at ≥30 trades / ≥10 days / LCB > 0', () => {
        const rows: SimTrade[] = [];
        for (let i = 0; i < 36; i++) {
            rows.push(simRow('incumbent', `P-${i}`, 0.2, i % 12));
            rows.push(simRow('exit-x2.0', `P-${i}`, 1.0, i % 12));   // beats the incumbent every day
            rows.push(simRow('stop-x/3', `P-${i}`, i % 2 ? 1.5 : -1.2, i % 12)); // coin flip
        }
        const lines = shadowLines(rows);
        const x2 = lines.find((l) => l.variant === 'exit-x2.0')!;
        expect(x2.summary?.n).toBe(36);
        expect(x2.diff?.lcb).toBeGreaterThan(0);
        expect(x2.candidate).toBe(true);
        const flip = lines.find((l) => l.variant === 'stop-x/3')!;
        expect(flip.candidate).toBe(false);
        expect(lines.find((l) => l.variant === 'incumbent')?.diff).toBeNull();
        expect(lines.find((l) => l.variant === 'weights-calibrated')?.status).toMatch(/inactive/);
    });
});
