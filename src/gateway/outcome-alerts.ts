/**
 * Outcome alerts — pushes trade-close notifications to WhatsApp.
 *
 * When the outcome tracker closes an executed proposal (target hit, stop
 * hit, cancelled, manual), the result is delivered to the most recent
 * WhatsApp session — same delivery model as trigger alerts. Deterministic,
 * no LLM involved.
 */

import { onTradeClosed } from '@/services/outcome-tracker.js';
import { formatProposalLine, type TradeProposal } from '@/services/trade-proposals.js';
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

function formatCloseMessage(p: TradeProposal): string {
    const icons: Record<string, string> = {
        target: '🎯', stop: '🛑', cancelled: '🚫', manual: '✋', unknown: '❓',
    };
    const icon = icons[p.exitReason ?? 'unknown'] ?? '🏁';
    const lines = [`${icon} Trade closed — ${p.exitReason ?? 'unknown'}`, formatProposalLine(p)];
    if (p.realizedPnl != null) {
        const net = p.realizedPnl - (p.commissions ?? 0);
        lines.push(
            `P&L ${p.realizedPnl >= 0 ? '+' : ''}$${p.realizedPnl.toFixed(2)} gross` +
            (p.commissions ? `, ${net >= 0 ? '+' : ''}$${net.toFixed(2)} net of $${p.commissions.toFixed(2)} commissions` : ''),
        );
    } else if (p.exitReason === 'manual') {
        lines.push('P&L unknown — position was closed or left unprotected outside the bracket. Check ibkr_account.');
    }
    lines.push("Send 'performance' for the running summary.");
    return lines.join('\n');
}

/** Subscribe outcome alerts (idempotent). Called at gateway startup. */
export function registerOutcomeAlerts(): void {
    if (registered) return;
    registered = true;

    onTradeClosed(async (proposal) => {
        const session = findTargetSession();
        if (!session?.lastTo || !session?.lastAccountId) {
            logger.warn('[outcome-alerts] no WhatsApp delivery target, skipping close alert');
            return;
        }
        try {
            assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
        } catch {
            logger.warn('[outcome-alerts] outbound blocked, skipping close alert');
            return;
        }
        await sendMessageWhatsApp({
            to: session.lastTo,
            body: formatCloseMessage(proposal),
            accountId: session.lastAccountId,
        });
        logger.info(`[outcome-alerts] ${proposal.id} close alert delivered`);
    });

    logger.info('[outcome-alerts] registered');
}
