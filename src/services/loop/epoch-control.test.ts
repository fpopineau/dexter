import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constantsHash } from '@/utils/sequential-test.js';
import { readLadderState } from '../ladder-state.js';
import { readEpochState, epochGateVerdict } from '../epoch-state.js';
import { readLiveSwitch } from '../live-switch.js';
import { evaluateEquityGuards, nextEpochId, readEpochRecord, startEpoch, stopEpoch } from './epoch-control.js';

function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'dexter-epoch-'));
    const journal: string[] = [];
    const alerts: string[] = [];
    const baselines: Array<[string, number | null]> = [];
    return { dir, journal, alerts, baselines, j: (l: string) => { journal.push(l); }, a: (m: string) => { alerts.push(m); } };
}

describe('startEpoch (REQ-EPOCH-001, REQ-LADDER-003)', () => {
    test('performance reset + record (running, constants hash, NetLiq) + ladder reset + journal; ids count up; the behavior reader accepts the record', () => {
        const h = harness();
        expect(nextEpochId(h.dir)).toBe('epoch-1');
        const rec = startEpoch({ now: 1_000, dataDir: h.dir, netLiqUsd: 12_000, fingerprint: 'abcdef123456', policyLabel: 'incumbent', setBaseline: (n, nl) => { h.baselines.push([n, nl]); }, journal: h.j });
        expect(rec.id).toBe('epoch-1');
        expect(rec.status).toBe('running');
        expect(rec.constantsHash).toBe(constantsHash());
        expect(rec.netLiq).toBe(12_000);
        expect(h.baselines).toEqual([['epoch-1 start', 12_000]]);
        expect(readLadderState(h.dir)?.rung).toBe(0.25);
        expect(h.journal.some((l) => l.includes('epoch-1 START') && l.includes('fp abcdef123456') && l.includes('rung 0.25'))).toBe(true);
        // The accept path's reader parses the same file and sees a running epoch.
        const read = readEpochState(h.dir);
        expect(read.kind).toBe('present');
        expect(epochGateVerdict(read)).toEqual({ ok: true });
        expect(nextEpochId(h.dir)).toBe('epoch-2');
    });

    test('carryRung keeps the previous rung; without it a new epoch resets to 0.25', () => {
        const h = harness();
        startEpoch({ now: 1, dataDir: h.dir, netLiqUsd: 12_000, fingerprint: 'fp', setBaseline: () => {}, journal: h.j });
        writeFileSync(join(h.dir, 'ladder-state.json'), JSON.stringify({ rung: 0.5, since: 'x', lastStepUpNetLiq: 12_500, history: [] }));
        startEpoch({ now: 2, dataDir: h.dir, netLiqUsd: 12_600, fingerprint: 'fp', carryRung: true, setBaseline: () => {}, journal: h.j });
        expect(readLadderState(h.dir)?.rung).toBe(0.5);
        startEpoch({ now: 3, dataDir: h.dir, netLiqUsd: 12_700, fingerprint: 'fp', setBaseline: () => {}, journal: h.j });
        expect(readLadderState(h.dir)?.rung).toBe(0.25);
        expect(readEpochRecord(h.dir)?.id).toBe('epoch-3');
    });
});

describe('stopEpoch (REQ-EPOCH-002/003)', () => {
    test('stops once: status, reason, journal, alert, live switch written OFF by the system; a second stop is a no-op', () => {
        const h = harness();
        startEpoch({ now: 1, dataDir: h.dir, netLiqUsd: 12_000, fingerprint: 'fp', setBaseline: () => {}, journal: h.j });
        writeFileSync(join(h.dir, 'live-switch.json'), JSON.stringify({ enabled: true, by: 'operator' }));
        const s = stopEpoch({ now: 5, dataDir: h.dir, reason: 'REJECT look at n=25', journal: h.j, alert: h.a });
        expect(s?.status).toBe('stopped');
        expect(s?.stopReason).toContain('REJECT');
        expect(readLiveSwitch(h.dir)).toMatchObject({ enabled: false, by: 'system' });
        expect(epochGateVerdict(readEpochState(h.dir)).ok).toBe(false);
        expect(h.alerts).toHaveLength(1);
        const journalLen = h.journal.length;
        stopEpoch({ now: 6, dataDir: h.dir, reason: 'again', journal: h.j, alert: h.a });
        expect(h.journal).toHaveLength(journalLen);
        expect(h.alerts).toHaveLength(1);
        expect(readEpochRecord(h.dir)?.stopReason).toContain('REJECT'); // the first reason stands
    });

    test('no epoch → null, nothing written', () => {
        const h = harness();
        expect(stopEpoch({ now: 1, dataDir: h.dir, reason: 'x', journal: h.j })).toBeNull();
        expect(readLiveSwitch(h.dir)).toBeNull();
    });
});

describe('evaluateEquityGuards (REQ-SEQ-004 hard stop, REQ-LADDER-002 step-down)', () => {
    test('−5% from the epoch NetLiq stops the epoch; −5% from the step-up mark steps the ladder down and re-anchors; never below 0.25', () => {
        const h = harness();
        startEpoch({ now: 1, dataDir: h.dir, netLiqUsd: 12_000, fingerprint: 'fp', setBaseline: () => {}, journal: h.j });
        writeFileSync(join(h.dir, 'ladder-state.json'), JSON.stringify({ rung: 0.75, since: 'x', lastStepUpNetLiq: 12_000, history: [] }));
        expect(evaluateEquityGuards(11_800, { now: 2, dataDir: h.dir, journal: h.j, alert: h.a })).toEqual({ hardStop: false, stepDown: false });
        const r = evaluateEquityGuards(11_400, { now: 3, dataDir: h.dir, journal: h.j, alert: h.a });
        expect(r).toEqual({ hardStop: true, stepDown: true });
        expect(readEpochRecord(h.dir)?.status).toBe('stopped');
        const ladder = readLadderState(h.dir)!;
        expect(ladder.rung).toBe(0.5);
        expect(ladder.lastStepUpNetLiq).toBe(11_400); // re-anchored
        // Another −5% from the new mark steps down again; the bottom rung holds.
        evaluateEquityGuards(10_800, { now: 4, dataDir: h.dir, journal: h.j });
        expect(readLadderState(h.dir)?.rung).toBe(0.25);
        evaluateEquityGuards(10_000, { now: 5, dataDir: h.dir, journal: h.j });
        expect(readLadderState(h.dir)?.rung).toBe(0.25);
        expect(h.journal.filter((l) => l.includes('STEP-DOWN')).length).toBeGreaterThanOrEqual(2);
        expect(JSON.parse(readFileSync(join(h.dir, 'epoch-state.json'), 'utf-8')).stopReason).toContain('-5% hard stop');
    });
});
