/**
 * Per-run lane attribution (WP0.8, REMEDIATION-2026-08-20).
 *
 * Tools are registered once in a global registry, but attribution is a
 * property of the RUN: which lane (trigger, breadth, cron brief, chat)
 * asked the agent to act. AsyncLocalStorage threads that through the
 * agent's async call tree without touching every tool signature — the
 * proposals tool reads it to stamp `source`, ending the era of every DB
 * row saying 'agent'.
 *
 * (Distinct from ./run-context.ts, which is the agent loop's mutable
 * per-run state — this module carries only cross-cutting attribution.)
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface AgentLaneContext {
    lane: string;
    /** Model id driving this run (review 2026-08-21): the frozen sample
     *  must not silently mix judgment policies — every proposal records
     *  which model proposed it. */
    model?: string;
}

const storage = new AsyncLocalStorage<AgentLaneContext>();

/** Run `fn` with `lane` (and optionally the model id) visible to
 *  everything it awaits. */
export function withAgentLane<T>(lane: string, fn: () => Promise<T>, model?: string): Promise<T> {
    return storage.run({ lane, model }, fn);
}

/** The lane of the run this call sits inside, or null outside any run. */
export function currentAgentLane(): string | null {
    return storage.getStore()?.lane ?? null;
}

/** The model id of the run this call sits inside, or null. */
export function currentAgentModel(): string | null {
    return storage.getStore()?.model ?? null;
}

/** Pure: lane from an agent-run request. Explicit lane wins; otherwise the
 *  sessionKey convention (trigger:SYM, breadth:VEH:dir, cron:<id>) names
 *  it; interactive chat falls back to its channel. */
export function deriveLane(req: { lane?: string; sessionKey: string; channel?: string }): string {
    if (req.lane) return req.lane;
    if (req.sessionKey.startsWith('trigger:')) return 'trigger';
    if (req.sessionKey.startsWith('breadth:')) return 'breadth';
    if (req.sessionKey.startsWith('cron:')) return req.sessionKey;
    return req.channel ?? 'agent';
}
