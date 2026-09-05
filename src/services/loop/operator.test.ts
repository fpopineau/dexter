import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLadderState } from '../ladder-state.js';
import { readEpochRecord, startEpoch } from './epoch-control.js';
import type { LoopStatus } from './looks.js';
import { CONFIRM_TTL_MS, createOperator, type OperatorDeps } from './operator.js';

const T0 = Date.UTC(2026, 8, 10, 14, 0, 0);

function statusWith(over: Partial<LoopStatus> = {}, dir?: string): LoopStatus {
    return {
        at: T0, epoch: dir ? readEpochRecord(dir) : null, constantsOk: true, openInCohort: 0, looksThisPass: [], anomalies: [], stoppedThisPass: null, shadowSample: null,
        sample: { n: 30, days: 12, sumR: 9.5, meanR: 0.32, profitFactor: 1.8, netUsd: 285, netUsdCostsDoubled: null, nextLook: 50, informational: true },
        band: null, shadow: [], drawdown: null, rankByLane: [],
        ladder: { state: readLadderState(dir), rung: readLadderState(dir)?.rung ?? 0.25, ceilingPct: 1.0, effectivePct: readLadderState(dir)?.rung ?? 0.25, eligibility: { eligible: true, nextRung: 0.5, milestone: 25, reason: 'n 30 ≥ 25, net R 9.50 > 0' } },
        models: [],
        lanes: [],
        ...over,
    };
}

function harness(opts: { netLiq?: number | null; fp?: string | null; status?: (dir: string) => LoopStatus; liveAccount?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dexter-operator-'));
    let now = T0;
    const journal: string[] = [];
    const baselines: string[] = [];
    const deps: OperatorDeps = {
        now: () => now,
        dataDir: dir,
        netLiqUsd: async () => (opts.netLiq === undefined ? 12_000 : opts.netLiq),
        fingerprint: async () => (opts.fp === undefined ? 'abcdef123456' : opts.fp),
        looks: async () => (opts.status ?? ((d) => statusWith({}, d)))(dir),
        setBaseline: (note) => { baselines.push(note); },
        journal: (l) => { journal.push(l); },
        digest: async () => 'DIGEST',
        liveAccount: () => opts.liveAccount ?? false,
        ceilingPct: () => 1.0,
    };
    return { dir, deps, journal, baselines, op: createOperator(deps), advance: (ms: number) => { now += ms; } };
}

describe('epoch new (REQ-EPOCH-001)', () => {
    test('no epoch → starts epoch-1 at once: baseline reset, record, rung 0.25, journal; NetLiq/identity unavailable → refused', async () => {
        const h = harness();
        const reply = await h.op.epochNew(false, false);
        expect(reply).toContain('epoch-1 STARTED');
        expect(reply).toContain('$12000.00');
        expect(h.baselines).toEqual(['epoch-1 start']);
        expect(readEpochRecord(h.dir)?.status).toBe('running');
        expect(readLadderState(h.dir)?.rung).toBe(0.25);

        const noNetLiq = harness({ netLiq: null });
        expect(await noNetLiq.op.epochNew(false, false)).toContain('NetLiq unavailable');
        expect(readEpochRecord(noNetLiq.dir)).toBeNull();
        const noFp = harness({ fp: null });
        expect(await noFp.op.epochNew(false, false)).toContain('UNRESOLVED');
    });

    test('a RUNNING epoch needs the two-step confirm; carry keeps the rung; a lapsed confirm is refused', async () => {
        const h = harness();
        await h.op.epochNew(false, false);
        const ask = await h.op.epochNew(true, false);
        expect(ask).toContain('epoch-1 is RUNNING');
        expect(ask).toContain("'epoch new carry confirm'");
        expect(readEpochRecord(h.dir)?.id).toBe('epoch-1');
        // step the ladder by hand, then carry
        const { writeLadderState } = await import('./ladder-control.js');
        writeLadderState({ rung: 0.5, since: 'x', lastStepUpNetLiq: 12_000 }, h.dir);
        const done = await h.op.epochNew(true, true);
        expect(done).toContain('epoch-2 STARTED');
        expect(readLadderState(h.dir)?.rung).toBe(0.5);
        // lapsed
        await h.op.epochNew(false, false);
        h.advance(CONFIRM_TTL_MS + 1);
        expect(await h.op.epochNew(false, true)).toContain('lapsed');
        expect(readEpochRecord(h.dir)?.id).toBe('epoch-2');
    });

    test('REQ-LADDER-003 / REQ-LIVE-006: on a live account `epoch new carry` is refused; plain `epoch new` starts at 0.25', async () => {
        const h = harness({ liveAccount: true });
        expect(await h.op.epochNew(true, false)).toContain('refused on a LIVE account');
        expect(readEpochRecord(h.dir)).toBeNull();
        expect(await h.op.epochNew(false, false)).toContain('epoch-1 STARTED');
        expect(readLadderState(h.dir)?.rung).toBe(0.25);
    });
});

describe('ladder up (REQ-LADDER-001)', () => {
    test('shows the evidence, applies on confirm with the step-down mark; refused when not eligible or NetLiq missing', async () => {
        const h = harness();
        startEpoch({ now: T0, dataDir: h.dir, netLiqUsd: 12_000, fingerprint: 'fp', setBaseline: () => {}, journal: () => {} });
        const ask = await h.op.ladderUp(false);
        expect(ask).toContain('0.25% → 0.5%');
        expect(ask).toContain("'ladder up confirm'");
        expect(readLadderState(h.dir)?.rung).toBe(0.25);
        const done = await h.op.ladderUp(true);
        expect(done).toContain('rung 0.25% → 0.5%');
        expect(readLadderState(h.dir)).toMatchObject({ rung: 0.5, lastStepUpNetLiq: 12_000 });
        expect(h.journal.some((l) => l.includes('STEP-UP'))).toBe(true);

        const notEligible = harness({ status: (d) => statusWith({ ladder: { state: null, rung: 0.25, ceilingPct: 1.0, effectivePct: 0.25, eligibility: { eligible: false, nextRung: 0.5, milestone: 25, reason: 'n 7 < 25' } } }, d) });
        expect(await notEligible.op.ladderUp(false)).toContain('not available: n 7 < 25');

        const noNetLiq = harness({ netLiq: null });
        startEpoch({ now: T0, dataDir: noNetLiq.dir, netLiqUsd: 12_000, fingerprint: 'fp', setBaseline: () => {}, journal: () => {} });
        await noNetLiq.op.ladderUp(false);
        expect(await noNetLiq.op.ladderUp(true)).toContain('marked NetLiq unavailable');
        expect(readLadderState(noNetLiq.dir)?.rung).toBe(0.25);
    });

    test('confirm without a pending request is refused', async () => {
        const h = harness();
        expect(await h.op.ladderUp(true)).toContain("Send 'ladder up' first");
    });
});

describe('promote (REQ-EPOCH-004)', () => {
    test('shows evidence + the change the variant maps to; confirm records the ratification (journal + epoch record); unknown variant refused', async () => {
        const h = harness({
            status: (d) => statusWith({
                shadow: [{ variant: 'exit-x2.0', status: 'active', summary: { variant: 'exit-x2.0', n: 40, days: 14, sumR: 12, meanR: 0.3, netUsd: 360, wins: 20, losses: 20, flats: 0, open: 0, unknown: 0, unfilled: 0 }, diff: { days: 14, lcb: 0.12, median: 0.2, meanDiff: 0.19 }, candidate: true }],
            }, d),
        });
        startEpoch({ now: T0, dataDir: h.dir, netLiqUsd: 12_000, fingerprint: 'fp', setBaseline: () => {}, journal: () => {} });
        const ask = await h.op.promote('exit-x2.0', false);
        expect(ask).toContain('PROMOTION CANDIDATE');
        expect(ask).toContain('take_atr_mult: 2.0');
        expect(readEpochRecord(h.dir)?.promotionPending).toBeNull();
        const done = await h.op.promote('exit-x2.0', true);
        expect(done).toContain('RECORDED');
        expect(readEpochRecord(h.dir)?.promotionPending?.variant).toBe('exit-x2.0');
        expect(h.journal.some((l) => l.startsWith('PROMOTE exit-x2.0'))).toBe(true);
        expect(await h.op.promote('nope', false)).toContain('unknown variant');
    });
});

describe('digest', () => {
    test('one-step, delegates', async () => {
        expect(await harness().op.digest()).toBe('DIGEST');
    });
});
