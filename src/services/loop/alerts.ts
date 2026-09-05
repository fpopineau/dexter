/**
 * Loop alert fan-out (live-loop WP3) — dependency-free so both the equity
 * sampler (guards) and the nightly runner can emit without an import
 * cycle. outcome-alerts bridges the callbacks to WhatsApp.
 */

import { logger } from '@/utils';

export type LoopMessageCallback = (message: string) => void | Promise<void>;

const alertCallbacks = new Set<LoopMessageCallback>();
const digestCallbacks = new Set<LoopMessageCallback>();

export function onLoopAlert(cb: LoopMessageCallback): () => void {
    alertCallbacks.add(cb);
    return () => alertCallbacks.delete(cb);
}

export function onLoopDigest(cb: LoopMessageCallback): () => void {
    digestCallbacks.add(cb);
    return () => digestCallbacks.delete(cb);
}

/** Fire-and-forget: an alert must never block the guard that raised it. */
export function emitLoopAlert(message: string): void {
    for (const cb of [...alertCallbacks]) {
        Promise.resolve()
            .then(() => cb(message))
            .catch((err) => logger.error(`[loop] alert callback failed: ${err}`));
    }
}

export async function emitLoopDigest(message: string): Promise<void> {
    for (const cb of [...digestCallbacks]) {
        try { await cb(message); } catch (err) { logger.error(`[loop] digest callback failed: ${err}`); }
    }
}
