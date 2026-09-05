import { describe, expect, test } from 'bun:test';
import { currentAgentLane, deriveLane, withAgentLane } from './lane-context.js';

describe('agent run context (WP0.8 — lane attribution)', () => {
    test('lane is visible through the async call tree, null outside', async () => {
        expect(currentAgentLane()).toBeNull();
        const seen = await withAgentLane('trigger', async () => {
            await new Promise((r) => setTimeout(r, 1));
            return currentAgentLane();
        });
        expect(seen).toBe('trigger');
        expect(currentAgentLane()).toBeNull();
    });

    test('concurrent runs keep their own lanes', async () => {
        const [a, b] = await Promise.all([
            withAgentLane('breadth', async () => {
                await new Promise((r) => setTimeout(r, 5));
                return currentAgentLane();
            }),
            withAgentLane('cron:daily-brief', async () => {
                await new Promise((r) => setTimeout(r, 1));
                return currentAgentLane();
            }),
        ]);
        expect(a).toBe('breadth');
        expect(b).toBe('cron:daily-brief');
    });

    test('deriveLane: explicit wins, then sessionKey conventions, then channel', () => {
        expect(deriveLane({ lane: 'cron:brief', sessionKey: 'cron:abc123' })).toBe('cron:brief');
        expect(deriveLane({ sessionKey: 'trigger:NVDA' })).toBe('trigger');
        expect(deriveLane({ sessionKey: 'breadth:SMH:long' })).toBe('breadth');
        expect(deriveLane({ sessionKey: 'cron:abc123' })).toBe('cron:abc123');
        expect(deriveLane({ sessionKey: 'user-jid', channel: 'whatsapp' })).toBe('whatsapp');
        expect(deriveLane({ sessionKey: 'anything' })).toBe('agent');
    });
});

describe('trigger rank in the lane context (REQ-TRIG-002 — the firing rank rides with the run)', () => {
    test('rank is visible inside the run, null outside and when not supplied', async () => {
        const { currentTriggerRank } = await import('./lane-context.js');
        expect(currentTriggerRank()).toBeNull();
        const seen = await withAgentLane('trigger', async () => {
            await new Promise((r) => setTimeout(r, 1));
            return currentTriggerRank();
        }, 'anthropic:claude-sonnet-5', { triggerRank: 66 });
        expect(seen).toBe(66);
        expect(currentTriggerRank()).toBeNull();
        const none = await withAgentLane('breadth', async () => currentTriggerRank());
        expect(none).toBeNull();
    });
});
