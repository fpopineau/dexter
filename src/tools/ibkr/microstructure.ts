/**
 * Shortability / halt snapshot (WP7, REMEDIATION-2026-08-20).
 *
 * A brief streaming reqMktData with generic tick 236 delivers tickGeneric
 * field 46 (shortable: >=2.5 deep borrow, 1.5–2.5 available, <1.5 none)
 * and field 49 (halted: >=1 halted). The stream is cancelled after both
 * fields arrive or 2.5s — whichever first. Nulls mean UNKNOWN, and the
 * caller's gate decides what unknown costs: a short refuses (borrow must
 * be confirmed), a long carries a note.
 *
 * ⚠ live-verify field values against the paper gateway before the
 * validation freeze (E2E checklist) — tick field semantics are the one
 * thing a unit harness cannot pin.
 */

import { EventName, SecType, type Contract } from '@stoqey/ib';
import { allocReqId, getIBApi } from './connection.js';
import { logger } from '@/utils';

export interface ShortabilitySnapshot {
    shortable: boolean | null;
    halted: boolean | null;
}

const UNKNOWN: ShortabilitySnapshot = { shortable: null, halted: null };
const SNAPSHOT_WINDOW_MS = 2_500;

export async function fetchShortabilitySnapshot(symbol: string): Promise<ShortabilitySnapshot> {
    if (process.env.NODE_ENV === 'test') return { ...UNKNOWN };
    try {
        const api = await getIBApi();
        return await new Promise<ShortabilitySnapshot>((resolve) => {
            const reqId = allocReqId();
            const out: ShortabilitySnapshot = { ...UNKNOWN };
            const timer = setTimeout(finish, SNAPSHOT_WINDOW_MS);
            function cleanup() {
                api.off(EventName.tickGeneric, onGeneric);
            }
            function finish() {
                clearTimeout(timer);
                cleanup();
                try { api.cancelMktData(reqId); } catch { /* stream already gone */ }
                resolve(out);
            }
            const onGeneric = (id: number, field: number, value: number) => {
                if (id !== reqId) return;
                if (field === 46) out.shortable = value >= 1.5;
                if (field === 49) out.halted = value >= 1;
                if (out.shortable !== null && out.halted !== null) finish();
            };
            api.on(EventName.tickGeneric, onGeneric);
            const contract: Contract = {
                symbol: symbol.trim().toUpperCase(),
                secType: SecType.STK,
                exchange: 'SMART',
                currency: 'USD',
            };
            // Streaming (not snapshot): IBKR refuses generic ticks on
            // snapshot requests — hence the explicit cancel above.
            api.reqMktData(reqId, contract, '236', false, false);
        });
    } catch (err) {
        logger.warn(`[microstructure] ${symbol}: shortability snapshot failed — ${err instanceof Error ? err.message : err}`);
        return { ...UNKNOWN };
    }
}
