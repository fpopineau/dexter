import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LADDER_RUNGS, parseLadderState, readLadderState, rungFromState } from './ladder-state.js';

describe('ladder state (REQ-RISK-009 — the sizer rung overlay reads a state file)', () => {
    test('rungs are the pre-registered 0.25 → 1.0 ladder', () => {
        expect(LADDER_RUNGS).toEqual([0.25, 0.5, 0.75, 1.0]);
    });

    test('parseLadderState accepts a well-formed record and rejects garbage', () => {
        const ok = parseLadderState({ rung: 0.5, since: '2026-09-10T13:00:00Z', lastStepUpNetLiq: 12000, history: [] });
        expect(ok?.rung).toBe(0.5);
        expect(parseLadderState(null)).toBeNull();
        expect(parseLadderState('0.5')).toBeNull();
        expect(parseLadderState({ rung: 0.6 })).toBeNull();      // not a rung
        expect(parseLadderState({ rung: '0.5' })).toBeNull();    // wrong type
        expect(parseLadderState({ rung: 1.0 })?.rung).toBe(1.0); // minimal record
    });

    test('rungFromState: absent or malformed → the bottom rung 0.25 (fail-safe toward SMALLER size)', () => {
        expect(rungFromState(null)).toBe(0.25);
        expect(rungFromState(parseLadderState({ rung: 0.75 }))).toBe(0.75);
    });

    test('readLadderState reads the file under DEXTER_DATA_DIR; absent file → null; corrupt file → null', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dexter-ladder-'));
        expect(readLadderState(dir)).toBeNull();
        writeFileSync(join(dir, 'ladder-state.json'), '{not json');
        expect(readLadderState(dir)).toBeNull();
        writeFileSync(join(dir, 'ladder-state.json'), JSON.stringify({ rung: 0.5, since: 'x', lastStepUpNetLiq: 1, history: [] }));
        expect(readLadderState(dir)?.rung).toBe(0.5);
    });
});
