/**
 * Deterministic WhatsApp command router for trade proposals.
 *
 * Runs BEFORE the agent: an explicit human message like "accept P-3F2A" is
 * the approval itself, so execution goes straight through the deterministic
 * proposal executor (safety lock + kill-switch) — no LLM in the loop.
 *
 * Recognized (DMs only):
 *   accept|ok|go P-XXXX     execute the proposal (paper bracket)
 *   reject|no P-XXXX        reject the proposal
 *   proposals               list open proposals
 *   positions               current account holdings + daily P&L
 *   orders                  working (unfilled) orders at IBKR
 *   protect SYM STOP [TGT]  attach GTC protective exits to an open position
 *   close SYM [SYM…]        market-close full position(s), cancelling their exits (risk-reducing)
 *   cancel P-XXXX|SYM       cancel an executed-but-unfilled bracket (risk-reducing)
 *   halt status             show the daily-loss kill-switch state
 *   performance [N]         closed-trade P&L summary over the last N days (default 7),
 *                           measured from the baseline when one is set
 *   performance all [N]     same, ignoring the baseline (full history)
 *   performance reset       stamp a new baseline NOW (non-destructive)
 */

import { getDailyLossStatus } from '@/services/daily-loss-guard.js';
import { acceptProposal, rejectProposal } from '@/services/proposal-executor.js';
import {
    formatPerformanceReport,
    setPerformanceBaseline,
    formatProposalLine,
    getPerformanceSummary,
    listProposals,
    listTrackable,
} from '@/services/trade-proposals.js';
import { cancelProposalBracket, cancelProposalForSymbol } from '@/services/proposal-executor.js';
import { closePosition, protectPosition } from '@/services/position-actions.js';
import { createIbkrAccount } from '@/tools/ibkr/account.js';
import { createIbkrOrders } from '@/tools/ibkr/orders.js';

const ACCEPT_RE = /^\s*(accept|ok|go)\s+(P-[A-Za-z0-9]{4})\s*$/i;
const REJECT_RE = /^\s*(reject|no)\s+(P-[A-Za-z0-9]{4})\s*$/i;
const LIST_RE = /^\s*proposals?\s*$/i;
const POSITIONS_RE = /^\s*positions?\s*$/i;
const ORDERS_RE = /^\s*orders?\s*$/i;
const PROTECT_RE = /^\s*protect\s+([A-Za-z.]{1,6})\s+(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?\s*$/i;
const CLOSE_RE = /^\s*close\s+([A-Za-z.,\s]+?)\s*$/i;

/**
 * Parse the argument of a 'close' command into ticker symbols. Accepts
 * separators ',' / whitespace / 'and' ("close MU, NVDA and SMCI"). Returns
 * null when any token does not look like a ticker ("close the positions")
 * so the message falls through to the agent instead of guessing.
 */
export function parseCloseSymbols(arg: string): string[] | null {
    const tokens = arg.split(/[\s,]+/).filter(Boolean).filter((t) => !/^and$/i.test(t));
    if (tokens.length === 0 || tokens.length > 8) return null;
    const symbols: string[] = [];
    for (const t of tokens) {
        if (!/^[A-Za-z.]{1,6}$/.test(t)) return null;
        symbols.push(t.toUpperCase());
    }
    return [...new Set(symbols)];
}
const CANCEL_RE = /^\s*cancel\s+(P-[A-Za-z0-9]{4}|[A-Za-z.]{1,6})\s*$/i;
const HALT_RE = /^\s*halt\s+status\s*$/i;
const PERF_RE = /^\s*(performance|perf)(?:\s+(all))?(?:\s+(\d{1,3})\s*d?)?\s*$/i;
const PERF_RESET_RE = /^\s*(performance|perf)\s+reset\s*$/i;

interface PositionRow {
    account: string;
    symbol: string;
    quantity: number;
    avgCost: number;
}

interface OpenOrderRow {
    orderId?: number;
    symbol: string;
    action: string;
    quantity: number;
    orderType: string;
    limitPrice?: number;
    auxPrice?: number;
    status?: string;
}

/** Deterministic working-orders snapshot from IBKR (no LLM) — the state
 *  between "proposal executed" (bracket placed) and "position" (entry
 *  filled), which is otherwise invisible from the phone. */
async function formatOrdersReply(): Promise<string> {
    try {
        const raw = await createIbkrOrders().invoke({ action: 'list' });
        const data = (JSON.parse(String(raw)) as { data: { openOrderCount: number; orders: OpenOrderRow[] } }).data;
        if (!data.orders?.length) {
            return '📭 No working orders at IBKR.';
        }

        // Group by symbol: a flat list makes correct bracket structure
        // (stop + target on the same position) look like duplicate sells.
        const bySymbol = new Map<string, OpenOrderRow[]>();
        for (const o of data.orders) {
            const list = bySymbol.get(o.symbol) ?? [];
            list.push(o);
            bySymbol.set(o.symbol, list);
        }

        // orderId → proposal id, so each group names the P-XXXX it belongs
        // to ('cancel' takes either). Orders placed outside the proposal
        // flow (manual TWS, 'protect') simply carry no id.
        const proposalByOrderId = new Map<number, string>();
        try {
            for (const t of await listTrackable()) {
                for (const oid of t.orderIds ?? []) proposalByOrderId.set(oid, t.id);
            }
        } catch { /* annotation only — never break the order list */ }

        const fmt = (o: OpenOrderRow) => {
            // IBKR reports unset prices as 0 — a LMT shows lmtPrice, a STP
            // shows auxPrice (the trigger), never a legitimate 0.
            const price = (o.limitPrice || undefined) ?? (o.auxPrice || undefined);
            return `  • #${o.orderId ?? '?'} ${o.action} ${o.quantity} ${o.orderType}${price !== undefined ? ` @ ${price}` : ''} [${o.status ?? '?'}]`;
        };

        const lines = [`📬 Working orders (${data.orders.length}):`];
        for (const [symbol, orders] of bySymbol) {
            const ids = [...new Set(orders
                .map((o) => (o.orderId !== undefined ? proposalByOrderId.get(o.orderId) : undefined))
                .filter((id): id is string => id !== undefined))];
            const tag = ids.length ? ` [${ids.join(', ')}]` : '';
            const sides = new Set(orders.map((o) => o.action));
            const label = sides.size > 1
                ? `${symbol}${tag} — bracket, entry still working:`
                : orders.length > 1
                    ? `${symbol}${tag} — exits protecting the position (OCA: one fills, the other cancels):`
                    : `${symbol}${tag}:`;
            lines.push(label, ...orders.map(fmt));
        }
        lines.push("A position appears only when an entry fills ('positions').");
        return lines.join('\n');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `⚠️ Could not fetch orders — IBKR connection issue: ${msg}`;
    }
}

/** Deterministic positions + daily P&L snapshot from IBKR (no LLM).
 *  Each part degrades independently: a slow PnL subscription must not
 *  hide the holdings list (and vice versa). */
async function formatPositionsReply(): Promise<string> {
    const tool = createIbkrAccount();
    const [posResult, pnlResult] = await Promise.allSettled([
        tool.invoke({ action: 'positions' }),
        tool.invoke({ action: 'pnl' }),
    ]);

    const usd = (n: number | undefined) =>
        n === undefined ? '?' : `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`;

    const lines: string[] = [];

    if (posResult.status === 'fulfilled') {
        const pos = (JSON.parse(String(posResult.value)) as {
            data: { positions: PositionRow[]; partial?: boolean };
        }).data;
        if (pos.positions.length === 0) {
            lines.push('📒 Positions: none — account is flat.');
        } else {
            lines.push(`📒 Positions (${pos.positions[0].account}):`);
            for (const p of pos.positions) {
                lines.push(`• ${p.symbol} ${p.quantity > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.quantity)} @ ${p.avgCost.toFixed(2)}`);
            }
            if (pos.partial) lines.push('(list may be partial — IBKR answered slowly)');
        }
    } else {
        lines.push(`⚠️ Positions unavailable: ${posResult.reason instanceof Error ? posResult.reason.message : posResult.reason}`);
    }

    if (pnlResult.status === 'fulfilled') {
        const pnl = (JSON.parse(String(pnlResult.value)) as {
            data: { account?: string; dailyPnL?: number; unrealizedPnL?: number; realizedPnL?: number };
        }).data;
        lines.push(`Daily P&L ${usd(pnl.dailyPnL)} (unrealized ${usd(pnl.unrealizedPnL)}, realized ${usd(pnl.realizedPnL)})`);
    } else {
        lines.push('Daily P&L unavailable (PnL subscription timed out — try again in a minute).');
    }

    return lines.join('\n');
}

/**
 * Try to handle the message as a proposal command.
 * Returns the reply text when handled, or null to fall through to the agent.
 */
export async function handleProposalCommand(body: string): Promise<string | null> {
    const accept = ACCEPT_RE.exec(body);
    if (accept) {
        const outcome = await acceptProposal(accept[2].toUpperCase());
        return outcome.message;
    }

    const reject = REJECT_RE.exec(body);
    if (reject) {
        const outcome = await rejectProposal(reject[2].toUpperCase());
        return outcome.message;
    }

    if (LIST_RE.test(body)) {
        const open = await listProposals('open');
        if (open.length === 0) return 'No open proposals.';
        return [
            `Open proposals (${open.length}):`,
            ...open.map((p) => `• ${formatProposalLine(p)}`),
            "Reply 'accept <ID>' to execute (paper) or 'reject <ID>'.",
        ].join('\n');
    }

    if (POSITIONS_RE.test(body)) {
        return formatPositionsReply();
    }

    if (ORDERS_RE.test(body)) {
        return formatOrdersReply();
    }

    // Risk-REDUCING position actions — the explicit human message is the
    // approval (same trust model as 'accept'). Paper lock applies; the
    // kill-switch does not (it only blocks risk-increasing actions).
    const protect = PROTECT_RE.exec(body);
    if (protect) {
        const outcome = await protectPosition(
            protect[1],
            Number(protect[2]),
            protect[3] !== undefined ? Number(protect[3]) : undefined,
        );
        return outcome.message;
    }

    const close = CLOSE_RE.exec(body);
    if (close) {
        const symbols = parseCloseSymbols(close[1]);
        if (symbols) {
            const messages: string[] = [];
            for (const s of symbols) {
                messages.push((await closePosition(s)).message);
            }
            return messages.join('\n');
        }
        // Not a clean symbol list ("close the positions") → let the agent
        // interpret it.
    }

    const cancel = CANCEL_RE.exec(body);
    if (cancel) {
        const arg = cancel[1].toUpperCase();
        const outcome = /^P-/.test(arg)
            ? await cancelProposalBracket(arg)
            : await cancelProposalForSymbol(arg);
        return outcome.message;
    }

    // Non-destructive: stamps a baseline so reports judge the current
    // gate stack on its own record; all labeled history stays in the DB.
    if (PERF_RESET_RE.test(body)) {
        const b = setPerformanceBaseline('manual reset');
        return `📊 Performance baseline reset to ${new Date(b.epochMs).toISOString().slice(0, 16).replace('T', ' ')} UTC.\n` +
            `Reports now start here; nothing was deleted — 'performance all' shows the full history.`;
    }

    const perf = PERF_RE.exec(body);
    if (perf) {
        const all = !!perf[2];
        const days = perf[3] ? Math.max(1, Number(perf[3])) : (all ? 365 : 7);
        const summary = await getPerformanceSummary(Date.now() - days * 24 * 3600_000, { includeAllHistory: all });
        return formatPerformanceReport(summary, all ? `all, last ${days}d` : `last ${days}d`);
    }

    if (HALT_RE.test(body)) {
        const s = await getDailyLossStatus();
        return s.halted
            ? `⛔ Trading HALTED — ${s.reason}`
            : `✅ Trading allowed. Daily P&L ${s.dailyPnL?.toFixed(0) ?? '?'} / limit -${s.limitDollars?.toFixed(0) ?? '?'} (${s.limitPct}% of ${s.netLiquidation?.toFixed(0) ?? '?'}).`;
    }

    return null;
}
