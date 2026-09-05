import { describe, expect, test } from 'bun:test';
import { handleLoopCommand, type LoopCommandCore } from './loop-commands.js';

function fakeCore(log: string[]): LoopCommandCore {
    return {
        veto: async (id) => { log.push(`veto:${id}`); return { ok: true, message: `vetoed ${id}` }; },
        kill: async (symbol) => { log.push(`kill:${symbol}`); return { ok: true, message: `closing ${symbol}` }; },
        liveStatus: async () => 'live switch: OFF (no state file)',
        ladderStatus: async () => 'ladder: rung 0.25% (bottom, no state file)',
        epochStatus: async () => 'epoch: none started (no state file)',
    };
}

describe('loop commands (REQ-LIVE-003 — control-plane grammar, routed outside the behavior paths)', () => {
    test('veto P-XXXX and kill SYMBOL route to the core; ids are upper-cased', async () => {
        const log: string[] = [];
        expect(await handleLoopCommand('veto p-1a2b', fakeCore(log))).toBe('vetoed P-1A2B');
        expect(await handleLoopCommand('  kill nvda ', fakeCore(log))).toBe('closing NVDA');
        expect(log).toEqual(['veto:P-1A2B', 'kill:NVDA']);
    });

    test('read-only status commands answer from the state files', async () => {
        const log: string[] = [];
        expect(await handleLoopCommand('live status', fakeCore(log))).toContain('live switch');
        expect(await handleLoopCommand('ladder', fakeCore(log))).toContain('rung');
        expect(await handleLoopCommand('epoch', fakeCore(log))).toContain('epoch');
        expect(log).toEqual([]);
    });

    test('mutating loop commands are not available until WP3/WP4 — named, not silently ignored', async () => {
        const log: string[] = [];
        for (const body of ['live on', 'live off', 'live on ABC123', 'ladder up', 'epoch new', 'promote exit-ratchet']) {
            const reply = await handleLoopCommand(body, fakeCore(log));
            expect(reply).toMatch(/not available until WP[34]/);
        }
        expect(log).toEqual([]);
    });

    test('unrelated messages fall through (null) so the agent handles them', async () => {
        const log: string[] = [];
        expect(await handleLoopCommand('what is the tape doing?', fakeCore(log))).toBeNull();
        expect(await handleLoopCommand('accept P-1234', fakeCore(log))).toBeNull();
        expect(await handleLoopCommand('kill the lights', fakeCore(log))).toBeNull();
    });
});
