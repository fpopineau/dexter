import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epochGateVerdict, parseEpochState, readEpochState } from './epoch-state.js';

describe('epoch state (REQ-RISK-010 — a stopped epoch pauses NEW ENTRIES only)', () => {
    test('parseEpochState accepts running/stopped records, rejects malformed ones', () => {
        expect(parseEpochState({ id: 'epoch-1', startedAt: 1, fingerprint: 'abc', status: 'running' })?.status).toBe('running');
        const stopped = parseEpochState({ id: 'epoch-1', startedAt: 1, fingerprint: 'abc', status: 'stopped', stopReason: 'REJECT look at n=25' });
        expect(stopped?.status).toBe('stopped');
        expect(stopped?.stopReason).toContain('REJECT');
        expect(parseEpochState({ id: 'epoch-1', status: 'paused' })).toBeNull();
        expect(parseEpochState(null)).toBeNull();
        expect(parseEpochState({ status: 'running' })).toBeNull(); // id required
    });

    test('verdict: absent file = running; stopped = refused with the reason; corrupt = refused (fail-closed)', () => {
        expect(epochGateVerdict({ kind: 'absent' })).toEqual({ ok: true });
        const stopped = epochGateVerdict({
            kind: 'present',
            state: { id: 'epoch-1', startedAt: 1, fingerprint: 'abc', status: 'stopped', stopReason: '-5% drawdown' },
        });
        expect(stopped.ok).toBe(false);
        if (!stopped.ok) {
            expect(stopped.reason).toContain('-5% drawdown');
            expect(stopped.reason).toContain('epoch-1');
        }
        const corrupt = epochGateVerdict({ kind: 'corrupt', error: 'bad json' });
        expect(corrupt.ok).toBe(false);
        if (!corrupt.ok) expect(corrupt.reason).toContain('unreadable');
        expect(epochGateVerdict({
            kind: 'present',
            state: { id: 'epoch-1', startedAt: 1, fingerprint: 'abc', status: 'running' },
        })).toEqual({ ok: true });
    });

    test('readEpochState classifies the file: absent / present / corrupt', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dexter-epoch-'));
        expect(readEpochState(dir).kind).toBe('absent');
        writeFileSync(join(dir, 'epoch-state.json'), '{{{');
        expect(readEpochState(dir).kind).toBe('corrupt');
        writeFileSync(join(dir, 'epoch-state.json'), JSON.stringify({ id: 'epoch-2', startedAt: 5, fingerprint: 'fp', status: 'running' }));
        const r = readEpochState(dir);
        expect(r.kind).toBe('present');
        if (r.kind === 'present') expect(r.state.id).toBe('epoch-2');
    });
});
