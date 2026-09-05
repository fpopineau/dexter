import { describe, expect, test } from 'bun:test';
import { handleLoopCommand, type LoopCommandCore } from './loop-commands.js';

function fakeCore(log: string[]): LoopCommandCore {
    return {
        veto: async (id) => { log.push(`veto:${id}`); return { ok: true, message: `vetoed ${id}` }; },
        kill: async (symbol) => { log.push(`kill:${symbol}`); return { ok: true, message: `closing ${symbol}` }; },
        liveStatus: async () => 'live switch: OFF (no state file)',
        ladderStatus: async () => 'ladder: rung 0.25% (bottom, no state file)',
        epochStatus: async () => 'epoch: none started (no state file)',
        ladderUp: async (confirm) => { log.push(`ladderUp:${confirm}`); return `ladder up ${confirm ? 'applied' : 'asked'}`; },
        epochNew: async (carry, confirm) => { log.push(`epochNew:${carry}:${confirm}`); return `epoch new carry=${carry} confirm=${confirm}`; },
        promote: async (variant, confirm) => { log.push(`promote:${variant}:${confirm}`); return `promote ${variant} ${confirm ? 'recorded' : 'asked'}`; },
        digest: async () => { log.push('digest'); return 'DIGEST'; },
        liveOn: async (token) => { log.push(`liveOn:${token}`); return token === null ? 'challenge ABC234' : `confirmed ${token}`; },
        liveOff: async () => { log.push('liveOff'); return 'switch off'; },
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
        expect(await handleLoopCommand('digest', fakeCore(log))).toBe('DIGEST');
        expect(log).toEqual(['digest']);
    });

    test('WP3 mutating commands: two-step grammar (ask, then confirm), carry flag, variant names with punctuation', async () => {
        const log: string[] = [];
        expect(await handleLoopCommand('ladder up', fakeCore(log))).toBe('ladder up asked');
        expect(await handleLoopCommand('Ladder Up Confirm', fakeCore(log))).toBe('ladder up applied');
        expect(await handleLoopCommand('epoch new', fakeCore(log))).toBe('epoch new carry=false confirm=false');
        expect(await handleLoopCommand('epoch new carry', fakeCore(log))).toBe('epoch new carry=true confirm=false');
        expect(await handleLoopCommand('epoch new carry confirm', fakeCore(log))).toBe('epoch new carry=true confirm=true');
        expect(await handleLoopCommand('epoch new confirm', fakeCore(log))).toBe('epoch new carry=false confirm=true');
        expect(await handleLoopCommand('promote exit-x2.0', fakeCore(log))).toBe('promote exit-x2.0 asked');
        expect(await handleLoopCommand('promote gate-off:noise-stop confirm', fakeCore(log))).toBe('promote gate-off:noise-stop recorded');
        expect(log).toEqual(['ladderUp:false', 'ladderUp:true', 'epochNew:false:false', 'epochNew:true:false', 'epochNew:true:true', 'epochNew:false:true', 'promote:exit-x2.0:false', 'promote:gate-off:noise-stop:true']);
    });

    test('REQ-LIVE-004 grammar: live on → challenge, live on <token> → confirm, live off → immediate', async () => {
        const log: string[] = [];
        expect(await handleLoopCommand('live on', fakeCore(log))).toBe('challenge ABC234');
        expect(await handleLoopCommand('Live ON abc234', fakeCore(log))).toBe('confirmed abc234');
        expect(await handleLoopCommand('live off', fakeCore(log))).toBe('switch off');
        expect(await handleLoopCommand('live status', fakeCore(log))).toContain('live switch');
        expect(log).toEqual(['liveOn:null', 'liveOn:abc234', 'liveOff']);
    });

    test('unrelated messages fall through (null) so the agent handles them', async () => {
        const log: string[] = [];
        expect(await handleLoopCommand('what is the tape doing?', fakeCore(log))).toBeNull();
        expect(await handleLoopCommand('accept P-1234', fakeCore(log))).toBeNull();
        expect(await handleLoopCommand('kill the lights', fakeCore(log))).toBeNull();
        expect(await handleLoopCommand('ladder up please', fakeCore(log))).toBeNull();
        expect(await handleLoopCommand('digest me', fakeCore(log))).toBeNull();
    });
});
