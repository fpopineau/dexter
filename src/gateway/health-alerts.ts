/**
 * Scanner-health alerts — bridges engine degraded/recovered transitions to
 * WhatsApp. Born from 2026-07-21: the engine scanned zero symbols for seven
 * market hours (degraded IB Gateway API) and the silence cost three catchable
 * movers. One message at the third empty cycle turns that failure mode into
 * a five-minute fix (usually: the Gateway needs attention — handbook §3.1).
 */

import { onEngineHealth } from '@/services/opportunity-engine.js';
import { logger } from '@/utils';
import { sendMessageWhatsApp } from './channels/whatsapp/index.js';
import { loadSessionStore, resolveSessionStorePath, type SessionEntry } from './sessions/store.js';

let registered = false;

function findTargetSession(): SessionEntry | null {
    const storePath = resolveSessionStorePath('default');
    const store = loadSessionStore(storePath);
    const entries = Object.values(store).filter((e) => e.lastTo);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries[0];
}

function etTime(ms: number): string {
    return new Date(ms).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    });
}

/** Subscribe scanner-health alerts (idempotent). Called at gateway startup. */
export function registerScanHealthAlerts(): void {
    if (registered) return;
    registered = true;

    onEngineHealth(async (t) => {
        const session = findTargetSession();
        if (!session?.lastTo) {
            logger.warn(`[health-alerts] scanner ${t.kind} but no WhatsApp delivery target yet`);
            return;
        }
        const body = t.kind === 'degraded'
            ? `⚠️ Scanner health: ${t.emptyCycles} consecutive scan cycles returned ZERO symbols since ` +
              `${etTime(t.sinceMs)} ET while the market is open. The IB Gateway API is likely degraded ` +
              `(auto-restart / weekly login — handbook §3.1). Briefs and triggers are flying blind until ` +
              `it recovers — check the Gateway window.`
            : `✅ Scanner recovered — scans are returning data again (was empty ${t.emptyCycles} cycles ` +
              `since ${etTime(t.sinceMs)} ET).`;
        try {
            await sendMessageWhatsApp({ to: session.lastTo, body, accountId: session.lastAccountId });
            logger.info(`[health-alerts] delivered scanner-${t.kind} alert`);
        } catch (err) {
            logger.error(`[health-alerts] delivery failed: ${err}`);
        }
    });

    logger.info('[health-alerts] registered');
}
