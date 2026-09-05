import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLiveSwitch } from '../live-switch.js';
import { startEpoch, stopEpoch, writeEpochRecord, readEpochRecord } from './epoch-control.js';
import { CHALLENGE_TTL_MS, createLiveSwitchControl, makeToken, type LiveSwitchContext } from './live-switch-control.js';

const T0 = Date.UTC(2026, 8, 12, 14, 0, 0);

function harness(ctx: Partial<LiveSwitchContext> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dexter-liveswitch-'));
    let now = T0;
    const journal: string[] = [];
    const control = createLiveSwitchControl({
        now: () => now,
        dataDir: dir,
        journal: (l) => { journal.push(l); },
        context: () => ({ accountKind: 'live', allowLiveEnv: true, profile: 'live', vetoWindowMin: 5, ...ctx }),
        token: () => 'ABC234',
    });
    return { dir, control, journal, advance: (ms: number) => { now += ms; } };
}

describe('live switch writer (REQ-LIVE-004)', () => {
    test('live on → challenge; live on <token> within 2 min writes enabled:true by operator + journal; live off is immediate', () => {
        const h = harness();
        const ask = h.control.requestOn();
        expect(ask.ok).toBe(true);
        expect(ask.message).toContain("'live on ABC234'");
        expect(readLiveSwitch(h.dir)).toBeNull(); // nothing written by the request
        h.advance(60_000);
        const done = h.control.confirmOn(' abc234 ');
        expect(done.ok).toBe(true);
        expect(readLiveSwitch(h.dir)).toMatchObject({ enabled: true, by: 'operator' });
        expect(h.journal.some((l) => l.startsWith('LIVE SWITCH ON by operator'))).toBe(true);
        const off = h.control.off();
        expect(off.ok).toBe(true);
        expect(readLiveSwitch(h.dir)).toMatchObject({ enabled: false, by: 'operator' });
        expect(h.journal.some((l) => l.startsWith('LIVE SWITCH OFF by operator'))).toBe(true);
    });

    test('expiry, mismatch (challenge kept), no pending, and a second confirm are all refused — the switch stays OFF', () => {
        const h = harness();
        expect(h.control.confirmOn('ABC234').ok).toBe(false); // nothing pending
        h.control.requestOn();
        expect(h.control.confirmOn('ZZZZZZ')).toMatchObject({ ok: false });
        expect(h.control.confirmOn('ZZZZZZ').message).toContain('mismatch');
        expect(readLiveSwitch(h.dir)).toBeNull();
        // the challenge survives a typo
        h.advance(CHALLENGE_TTL_MS - 1);
        expect(h.control.confirmOn('abc234').ok).toBe(true);
        h.control.off();
        // expiry
        h.control.requestOn();
        h.advance(CHALLENGE_TTL_MS + 1);
        const late = h.control.confirmOn('ABC234');
        expect(late.ok).toBe(false);
        expect(late.message).toContain('EXPIRED');
        expect(readLiveSwitch(h.dir)?.enabled).toBe(false);
        // a consumed challenge cannot be replayed
        h.control.requestOn();
        expect(h.control.confirmOn('ABC234').ok).toBe(true);
        expect(h.control.confirmOn('ABC234').ok).toBe(false);
    });

    test('tokens are 6 unambiguous characters', () => {
        for (let i = 0; i < 50; i++) expect(makeToken()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    });
});

describe('REQ-LIVE-005: the challenge shows the evidence the operator acts on', () => {
    test('no epoch → says so; with an epoch → last look, ACCEPT state, rung, account, cold arm, profile, veto window', () => {
        const h = harness({ accountKind: 'paper', allowLiveEnv: false });
        const none = h.control.requestOn().message;
        expect(none).toContain('epoch: NONE');
        expect(none).toContain('not on a live account');
        startEpoch({ now: T0, dataDir: h.dir, netLiqUsd: 12_000, fingerprint: 'abcdef123456', setBaseline: () => {}, journal: () => {} });
        const rec = readEpochRecord(h.dir)!;
        writeEpochRecord({ ...rec, looksDone: [25], looks: [{ n: 25, at: T0, decision: 'ACCEPT', lcb: 0.21, ucb95: 0.9, sumR: 14.2, profitFactor: 1.9 }], firstAcceptAt: T0 }, h.dir);
        const msg = h.control.requestOn().message;
        expect(msg).toContain('epoch-1: RUNNING');
        expect(msg).toContain('last look n=25: ACCEPT');
        expect(msg).toContain('ACCEPT recorded');
        expect(msg).toContain('rung 0.25%');
        expect(msg).toContain('IBKR_ALLOW_LIVE NOT true');
        expect(msg).toContain('veto window 5 min');
        expect(h.control.status()).toContain('live switch: OFF');
    });
});

describe('REQ-EPOCH-002 ∘ REQ-LIVE-004: the system may only ever write false', () => {
    test('after live on, an epoch stop turns the switch OFF by the system; a later live on needs a fresh challenge', () => {
        const h = harness();
        startEpoch({ now: T0, dataDir: h.dir, netLiqUsd: 12_000, fingerprint: 'fp', setBaseline: () => {}, journal: () => {} });
        h.control.requestOn();
        expect(h.control.confirmOn('ABC234').ok).toBe(true);
        stopEpoch({ now: T0 + 1, dataDir: h.dir, reason: 'REJECT look at n=25', journal: () => {} });
        expect(readLiveSwitch(h.dir)).toMatchObject({ enabled: false, by: 'system' });
        expect(h.control.confirmOn('ABC234').ok).toBe(false);
    });
});
