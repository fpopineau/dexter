/**
 * Pre-market mover alerts — the deterministic notification channel.
 *
 * MRNA 2026-08-19: +110% between 06:45 and 07:50 ET; the engine idled
 * until 08:00 and the operator learned of it from the press at lunch.
 * This channel exists so an outsized pre-market mover reaches the phone
 * within one dawn-watch cycle of appearing in the scans: one line per
 * symbol per day, straight from scan+quote facts — no LLM evaluation, no
 * gates, no orders. Notification is decoupled from tradability on
 * purpose: most of these are exactly the moves the gates refuse to
 * chase, and the human deciding with their own eyes is the point.
 */

import { onPreMarketMover, type Opportunity } from '@/services/opportunity-engine.js';
import { logger } from '@/utils';
import { assertOutboundAllowed, sendMessageWhatsApp } from './channels/whatsapp/index.js';
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

function formatMoverAlert(opp: Opportunity): string {
    // dayMovePct is direction-signed; show the human the actual tape sign.
    const actual = opp.direction === 'long' ? (opp.dayMovePct ?? 0) : -(opp.dayMovePct ?? 0);
    return [
        `⚡ PRE-MARKET MOVER — ${opp.symbol} ${actual >= 0 ? '+' : ''}${actual.toFixed(1)}% vs prior close` +
        `${opp.price != null ? ` at $${opp.price}` : ''}` +
        `${opp.rvol != null ? `, RVOL ${opp.rvol}` : ''} (${opp.scanSources.join(', ')})`,
        `Deterministic alert: no evaluation ran, no order placed. Engine rank ${opp.compositeRank}` +
        ` — it stays in the normal pipeline. Reply if you want an analysis or a plan.`,
    ].join('\n');
}

/** Subscribe pre-market mover alerts (idempotent). Called at gateway startup. */
export function registerMoverAlerts(): void {
    if (registered) return;
    registered = true;

    onPreMarketMover(async (opp) => {
        const session = findTargetSession();
        if (!session?.lastTo || !session?.lastAccountId) {
            logger.warn('[mover-alerts] no WhatsApp delivery target, skipping mover alert');
            return;
        }
        try {
            assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
        } catch {
            logger.warn('[mover-alerts] outbound blocked, skipping mover alert');
            return;
        }
        await sendMessageWhatsApp({
            to: session.lastTo,
            body: formatMoverAlert(opp),
            accountId: session.lastAccountId,
        });
        logger.info(`[mover-alerts] ${opp.symbol} mover alert delivered`);
    });

    logger.info('[mover-alerts] registered');
}
