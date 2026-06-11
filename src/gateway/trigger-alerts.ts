/**
 * Trigger alerts — bridges Opportunity Engine event triggers to WhatsApp.
 *
 * On trigger: run a focused, isolated agent evaluation of the candidate
 * (news catalyst, risk validation). If the agent deems it actionable it
 * registers a trade proposal (trade_proposals tool) and the resulting
 * message — including the 'accept <ID>' instruction — is delivered to the
 * most recent WhatsApp session. Non-actionable evaluations reply with the
 * heartbeat token and are suppressed.
 *
 * Execution stays human-only: headless agent runs cannot approve orders,
 * and acceptance flows through the deterministic command router.
 */

import { onOpportunityTrigger, type Opportunity } from '@/services/opportunity-engine.js';
import { getSetting } from '@/utils/config.js';
import { logger } from '@/utils';
import { runAgentForMessage } from './agent-runner.js';
import { assertOutboundAllowed, sendMessageWhatsApp } from './channels/whatsapp/index.js';
import { HEARTBEAT_OK_TOKEN } from './heartbeat/suppression.js';
import { loadSessionStore, resolveSessionStorePath, type SessionEntry } from './sessions/store.js';
import { cleanMarkdownForWhatsApp } from './utils.js';

let registered = false;

function findTargetSession(): SessionEntry | null {
    const storePath = resolveSessionStorePath('default');
    const store = loadSessionStore(storePath);
    const entries = Object.values(store).filter((e) => e.lastTo);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries[0];
}

function buildPrompt(opp: Opportunity): string {
    return [
        `[OPPORTUNITY TRIGGER] ${opp.symbol} just ranked top-3 in the live scanner.`,
        '',
        `Candidate: ${opp.direction.toUpperCase()} ${opp.symbol} (${opp.longName})`,
        `compositeRank ${opp.compositeRank}, signalScore ${opp.signalScore} (${opp.rating}), ` +
        `price ${opp.price}, RVOL ${opp.rvol}, ATR ${opp.atr}, RSI ${opp.rsi}, VWAP ${opp.vwap}, ` +
        `scanners: ${opp.scanSources.join(', ')}.`,
        '',
        'Evaluate this candidate NOW for an intraday trade:',
        '1. Check for a news catalyst (web_search). A move without a catalyst is suspect.',
        '2. Validate entry/stop/target and position size with risk_manager (stop from ATR).',
        '3. Decision:',
        `   - NOT actionable → respond with exactly: ${HEARTBEAT_OK_TOKEN}`,
        '   - Actionable → register it with trade_proposals (action create, source rationale included),',
        "     then reply briefly: the setup, the proposal line, and \"Reply 'accept <ID>' to execute (paper)\".",
        'Never place orders yourself. Keep the alert under 10 lines.',
    ].join('\n');
}

/** Subscribe trigger alerts (idempotent). Called at gateway startup. */
export function registerTriggerAlerts(): void {
    if (registered) return;
    registered = true;

    onOpportunityTrigger(async (opp) => {
        const session = findTargetSession();
        if (!session?.lastTo || !session?.lastAccountId) {
            logger.warn('[trigger-alerts] no WhatsApp delivery target, skipping alert');
            return;
        }
        try {
            assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
        } catch {
            logger.warn('[trigger-alerts] outbound blocked, skipping alert');
            return;
        }

        const model = getSetting('modelId', 'gpt-5.5') as string;
        const modelProvider = getSetting('provider', 'openai') as string;

        const answer = await runAgentForMessage({
            sessionKey: `trigger:${opp.symbol}`,
            query: buildPrompt(opp),
            model,
            modelProvider,
            maxIterations: 6,
            isolatedSession: true,
            channel: 'whatsapp',
        });

        if (!answer.trim() || answer.toUpperCase().includes(HEARTBEAT_OK_TOKEN)) {
            logger.info(`[trigger-alerts] ${opp.symbol}: evaluation not actionable, suppressed`);
            return;
        }

        await sendMessageWhatsApp({
            to: session.lastTo,
            body: cleanMarkdownForWhatsApp(answer).trim(),
            accountId: session.lastAccountId,
        });
        logger.info(`[trigger-alerts] ${opp.symbol}: alert delivered`);
    });

    logger.info('[trigger-alerts] registered');
}
