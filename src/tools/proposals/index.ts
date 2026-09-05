/**
 * Trade proposal tools.
 *
 * `trade_proposals` (safe): create / list / get / reject — lets the agent
 * register actionable recommendations and inspect their lifecycle. Creating
 * a proposal NEVER trades; it just persists a human-actionable record.
 *
 * `accept_proposal` (approval-gated, in TOOLS_REQUIRING_APPROVAL): executes
 * an open proposal as a paper bracket order through the deterministic
 * executor (safety lock + daily-loss kill-switch). In headless contexts
 * (cron/gateway agent runs) approval is auto-denied, so only an interactive
 * human confirmation — or the WhatsApp command router — can execute.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { deriveStrategyId, LANE_TABLE, type StrategyId } from '@/services/lane-contract.js';
import type { TradeClass } from '@/tools/ibkr/risk-rules.js';
import { acceptProposal, autoExecuteProposal, isAutoExecuteEnabled } from '@/services/proposal-executor.js';
import {
    createProposal,
    formatPerformanceReport,
    formatProposalLine,
    getPerformanceSummary,
    getProposal,
    listProposals,
} from '@/services/trade-proposals.js';
import { rejectProposal } from '@/services/proposal-executor.js';
import { currentAgentLane, currentAgentModel, currentTriggerDirection, currentTriggerRank, currentTriggerSymbol } from '@/agent/lane-context.js';
import { fetchDailyRiskContext } from '../ibkr/daily-atr.js';
import { formatToolResult } from '../types.js';
import { logger } from '@/utils';

export const TRADE_PROPOSALS_DESCRIPTION = `
Manage trade proposals — persisted, human-actionable trade recommendations.

**create** — register a recommendation (symbol, direction, entryType LMT/MKT, entry,
  stop, target, score, rationale, expiresMinutes default 120). OMIT quantity: the
  position sizer computes shares from the account's risk budget, the confidence score
  and the stop distance (works on any account size). Creating a proposal does NOT trade. The entry price is REQUIRED even for MKT proposals (pass the
  current price — it anchors deterministic risk validation; execution is still at market).
  Every proposal passes a mandatory risk gate (min risk/reward, min price, coherent
  stop/target) — a rejected create returns the violations; fix the numbers, don't fight it.
  Always include the returned proposal id in your answer, with the instruction
  "reply 'accept <ID>' to execute (paper)".
**list** — list proposals (status filter: open/executed/closed/rejected/expired/failed; default open).
**get** — fetch one proposal by id.
**reject** — mark an open proposal rejected (risk-reducing, always allowed).
**performance** — closed-trade outcomes over the last N days (default 7): wins/losses,
  win rate, gross/net P&L, best/worst, exit reasons. Use it for daily recaps. Measured
  from the performance baseline when one is set; pass allHistory=true for everything.

Execution is human-only: the accept_proposal tool requires interactive approval, and
WhatsApp users execute by replying 'accept <ID>'. Prices must be coherent: for long,
stop < entry < target; for short, target < entry < stop.
`.trim();

export const ACCEPT_PROPOSAL_DESCRIPTION = `
Execute an OPEN trade proposal as a paper bracket order (entry + OCA stop/target).

Requires interactive user approval (TOOLS_REQUIRING_APPROVAL) — in headless runs it is
auto-denied by design. Passes through the paper/live safety lock and the daily-loss
kill-switch before any order is placed. Use trade_proposals (action get/list) first to
verify what will be executed.
`.trim();

const CreateSchema = z.object({
    action: z.literal('create'),
    symbol: z.string().describe("US equity ticker, e.g. 'AAPL'."),
    direction: z.enum(['long', 'short']),
    entryType: z.enum(['LMT', 'MKT', 'STP_LMT']).default('LMT')
        .describe('LMT: PULLBACK entry — must REST away from the current price (long: below it) by at least max(0.1%, 0.25× the stop distance); the gate refuses limits at/near the quote (a buy-now order that fills on the next tick is the record\'s losing pattern). STP_LMT: CONFIRMATION entry — triggers at `entry` and fills up to `entryLimit`; the trigger must sit at least the same margin BEYOND the current price (long: above), so the trade only exists if the move continues. MKT: refused for intraday proposals when a live quote exists — buying the discovery move at its top.'),
    entry: z.coerce.number().positive()
        .describe('Entry price. LMT: the limit — rest it at real structure BELOW the market for longs (VWAP, breakout retest), not at the quote. MKT: current price (indicative, risk validation). STP_LMT: the TRIGGER price (above market for longs, beyond the confirmation margin).'),
    entryLimit: z.coerce.number().positive().optional()
        .describe('STP_LMT only: the limit cap for the triggered entry (slightly beyond the trigger, e.g. trigger +0.3–0.6%).'),
    stop: z.coerce.number().positive()
        .describe('Stop-loss price at REAL STRUCTURE (low of day, pullback low, VWAP). The gate refuses stops closer than 0.4× the daily ATR — inside intraday noise, they fill on randomness.'),
    target: z.coerce.number().positive()
        .describe('Take-profit price. INTRADAY (take-at-x% policy): the target must sit AT the take level — x% from the worst permitted fill, where x defaults to 1.5× the daily ATR% clamped into the configured take band (3–10%), or your takePct override. The gate prescribes the exact required price on a mismatch. Swing/earnings-bet: a real objective (prior high, measured move) at ≥2× the stop distance.'),
    takePct: z.coerce.number().positive().optional()
        .describe("Intraday only: override the take percent x within the configured take band (3–10%) when the instrument's potential justifies it (catalyst, structure). The target must then sit AT x% from the worst permitted fill. Omit for the ATR default."),
    quantity: z.coerce.number().positive().optional()
        .describe('Number of shares (decimals allowed when the account profile enables fractional trading). OMIT to auto-size (recommended): the position sizer computes shares from the account risk budget, the confidence score, and the stop distance — this is the only way sizing stays correct across account sizes. Pass explicitly only when the user demanded a specific quantity.'),
    tif: z.enum(['DAY', 'GTC']).default('DAY')
        .describe("Bracket time-in-force. Use 'GTC' for overnight/swing setups so the stop and target SURVIVE the market close; 'DAY' brackets expire at the bell and can leave a filled position unprotected overnight."),
    tradeClass: z.enum(['intraday', 'swing', 'earnings-bet']).optional()
        .describe("Risk class. Usually OMIT it — the lane (strategyId) fixes it: intraday → 'intraday'; overnight, swing and cup-and-handle → 'swing' (GTC exits, gap-stress sizing, swing pool of 3); earnings-bet → 'earnings-bet' (a DELIBERATE hold through a print, one at a time, sized to the worst-case gap). Passing a class that contradicts the lane is refused. Never label a trade earnings-bet to dodge the exit-before-print rule of other classes; the class has stricter sizing, not looser."),
    strategyId: z.enum(['intraday', 'overnight', 'swing', 'cup-and-handle', 'earnings-bet']).optional()
        .describe("The LANE (four-lane contract). 'intraday' (default): same session, flat by close, take-at-x% target, tif DAY. 'overnight': registered from 15:00 ET, GTC bracket, an unfilled entry dies with the close (expiry clamps to the bell), the position exits at 10:00 ET next session at the latest — a stated reason the move survives the night is required. 'swing': multi-session pattern trade (pullback / flat-base), GTC, closed by 15:50 ET at the latest 10 trading sessions AFTER the fill session (the 11th session counting the fill day). 'cup-and-handle': the cup lane from swing_patterns, GTC, closed 15 trading sessions after the fill session. 'earnings-bet': through-print bet (its own rules). Omitted = derived from tradeClass."),
    setupId: z.string().max(40).optional()
        .describe("The setup inside the lane, lowercase-with-dashes, e.g. 'pullback', 'flat-base', 'cup-and-handle', 'eod-continuation', 'gap-continuation', 'catalyst-reversal'. Cup-and-handle defaults to its own."),
    worstCaseGapPct: z.coerce.number().min(0).max(100).optional()
        .describe("Earnings bets only: the symbol's worst ADVERSE post-print move in %, from its own earnings history (e.g. 18 for -18%). The sizer floors this at the configured minimum gap assumption. Omit if unknown — the floor alone is used."),
    score: z.coerce.number().min(0).max(150).optional().describe('Signal/composite score backing this proposal.'),
    rationale: z.string().min(5).describe('One or two sentences: why this trade, catalyst, risk note.'),
    expiresMinutes: z.coerce.number().int().positive().max(24 * 60).default(120)
        .describe('Validity window in minutes. Defaults to 120.'),
});

const ListSchema = z.object({
    action: z.literal('list'),
    status: z.enum(['open', 'executed', 'closed', 'rejected', 'expired', 'failed']).optional()
        .describe('Filter by status. Omit for all (recent first).'),
});

const GetSchema = z.object({
    action: z.literal('get'),
    id: z.string().describe("Proposal id, e.g. 'P-3F2A'."),
});

const RejectSchema = z.object({
    action: z.literal('reject'),
    id: z.string().describe('Proposal id to reject.'),
});

const PerformanceSchema = z.object({
    action: z.literal('performance'),
    days: z.coerce.number().int().positive().max(365).default(7)
        .describe('Look-back window in days for closed-trade outcomes. Defaults to 7.'),
    allHistory: z.boolean().default(false)
        .describe('Include trades from before the performance baseline (a non-destructive reset stamp). Default false.'),
});

const ProposalsSchema = z.discriminatedUnion('action', [CreateSchema, ListSchema, GetSchema, RejectSchema, PerformanceSchema]);

/** Four-lane contract (REQ-LANE-001): the lane fixes the risk class. An
 *  explicit class that contradicts the lane is an error, never a silent
 *  override; an omitted class is derived. */
export function laneClassOf(input: { strategyId?: StrategyId; tradeClass?: TradeClass }): { tradeClass: TradeClass; strategyId: StrategyId } | { error: string } {
    const strategyId: StrategyId = input.strategyId ?? deriveStrategyId(input.tradeClass ?? 'intraday');
    const laneClass = LANE_TABLE[strategyId].tradeClass;
    if (input.tradeClass !== undefined && input.tradeClass !== laneClass) {
        return { error: `strategyId '${strategyId}' rides the '${laneClass}' risk class — omit tradeClass or set '${laneClass}'` };
    }
    return { tradeClass: laneClass, strategyId };
}

export function coherent(input: { direction: 'long' | 'short'; entry: number; stop: number; target: number; tif: 'DAY' | 'GTC'; tradeClass: TradeClass; strategyId: StrategyId; worstCaseGapPct?: number }): string | null {
    if (input.direction === 'long' && !(input.stop < input.entry && input.entry < input.target)) {
        return 'long proposal requires stop < entry < target';
    }
    if (input.direction === 'short' && !(input.target < input.entry && input.entry < input.stop)) {
        return 'short proposal requires target < entry < stop';
    }
    // A multi-day class on a DAY bracket leaves the position unprotected at
    // the first close — structurally incoherent, not a style choice.
    if (input.tradeClass !== 'intraday' && input.tif !== 'GTC') {
        return `${input.strategyId} (${input.tradeClass} class) proposals require tif GTC — a DAY bracket expires at the close and leaves the position unprotected`;
    }
    if (input.worstCaseGapPct != null && input.tradeClass !== 'earnings-bet') {
        return 'worstCaseGapPct only applies to earnings-bet proposals';
    }
    return null;
}

export function createTradeProposalsTool() {
    return new DynamicStructuredTool({
        name: 'trade_proposals',
        description:
            'Create, list, get, or reject persisted trade proposals. Creating never trades; execution is human-only.',
        schema: ProposalsSchema,
        func: async (input) => {
            switch (input.action) {
                case 'create': {
                    const laneClass = laneClassOf(input);
                    if ('error' in laneClass) return formatToolResult({ error: laneClass.error });
                    const lane = { tradeClass: laneClass.tradeClass, strategyId: laneClass.strategyId };
                    const problem = coherent({ ...input, ...lane });
                    if (problem) return formatToolResult({ error: problem });
                    try {
                        // Server-side daily ATR + EMA10 for the noise-stop
                        // and extension checks — never taken from the model.
                        // Fail-open (nulls skip the checks).
                        const riskCtx = await fetchDailyRiskContext(input.symbol);
                        const { dailyAtr, ema10, recentEarnings, prevClose } = riskCtx;

                        // Live quote (never delayed) for the buy-now
                        // entry-pricing check and the spread the cost model
                        // prices (WP6), plus session VWAP — all server-side,
                        // all fail-open. Skipped in tests (IBKR-dependent,
                        // same as the daily context).
                        const quote = process.env.NODE_ENV === 'test'
                            ? null
                            : await import('@/services/proposal-executor.js')
                                .then((m) => m.fetchLiveQuote(input.symbol)).catch(() => null);
                        const lastPrice = quote?.last ?? null;
                        const { buildEntryContext, fetchSessionVwap, minutesSinceOpenEt } =
                            await import('@/services/entry-context.js');
                        const vwap = await fetchSessionVwap(input.symbol).catch(() => null);
                        // Context is measured at the LIVE price when we have
                        // one (the market state at proposal time); the
                        // proposed entry stands in otherwise.
                        const entryContext = buildEntryContext({
                            direction: input.direction,
                            ref: lastPrice ?? input.entry,
                            dailyAtr, ema10, prevClose, vwap,
                            minutesSinceOpen: minutesSinceOpenEt(),
                        });

                        // Earnings bets: server-fetched evidence for the
                        // LIVE-GATE checks. Fail-CLOSED, unlike the ATR
                        // context: a data failure arrives as nulls and the
                        // gate refuses — the evidence bar must not be
                        // satisfiable by breaking the data source.
                        const betEvidence = lane.tradeClass === 'earnings-bet'
                            ? await (await import('@/services/earnings-reactions.js'))
                                .fetchEarningsBetEvidence(input.symbol, input.direction)
                            : undefined;

                        // REQ-LANE-005: the detector version of a pattern lane.
                        // REQ-DISC-003 (WP8): the lane rank and its ranker, resolved
                        // SERVER-SIDE from the run context, the latest snapshot and
                        // the pattern scan — the model never passes a rank.
                        const { getLatestPatternScan } = await import('@/services/pattern-scanner.js');
                        const { getLatestSnapshot } = await import('@/services/opportunity-engine.js');
                        const { laneRankFor } = await import('@/services/lane-rankers.js');
                        const patternScan = getLatestPatternScan();
                        let detectorVersion: string | null = null;
                        if (lane.strategyId === 'cup-and-handle') {
                            detectorVersion = patternScan?.candidates.find((c) => c.symbol.toUpperCase() === input.symbol.toUpperCase())?.detectorVersion ?? patternScan?.detectorVersion ?? null;
                        }
                        const snapshotNow = getLatestSnapshot();
                        const provenance = laneRankFor(lane.strategyId, input.symbol, input.direction, {
                            triggerRank: currentTriggerRank(),
                            triggerSymbol: currentTriggerSymbol(),
                            triggerDirection: currentTriggerDirection(),
                            snapshot: snapshotNow,
                            patternScan,
                        });

                        // WP6 (REQ-SIZE-001): the book context — the SAME
                        // sums the acceptance gate reads, built from the
                        // proposals store (no broker call at creation: rows
                        // price at their worst entry basis). Sectors are
                        // live-only (Nasdaq metadata; 'UNKNOWN' bucket for
                        // misses, as at accept); in tests they stay unknown
                        // and the sector cap skips. An unpriceable row makes
                        // the planned risk UNKNOWN (never zero): the sizer
                        // then skips the headroom cap and the accept-time
                        // gate refuses until the row prices — fail-closed
                        // where the orders are placed, informative here.
                        const store = await import('@/services/trade-proposals.js');
                        const { buildBookContext } = await import('@/services/book-context.js');
                        const { getRiskRules } = await import('@/tools/ibkr/risk-rules.js');
                        const { worstEntryNotional } = await import('@/services/proposal-executor.js');
                        const rows = await store.listExposure().catch(() => []);
                        const sectorsLive = process.env.NODE_ENV !== 'test';
                        const resolveSector = async (sym: string): Promise<string> => {
                            try {
                                const { getSectorInfo } = await import('@/services/sector-map.js');
                                return (await getSectorInfo(sym))?.sector ?? 'UNKNOWN';
                            } catch { return 'UNKNOWN'; }
                        };
                        const sector = sectorsLive ? await resolveSector(input.symbol) : null;
                        const sectorOf = sectorsLive ? new Map<string, string>() : null;
                        if (sectorOf) for (const t of rows) sectorOf.set(t.symbol.toUpperCase(), await resolveSector(t.symbol));
                        const book = buildBookContext({ rows, symbol: input.symbol, rules: getRiskRules(), valueOf: worstEntryNotional, sector, sectorOf });
                        const realizedLossTodayUsd = Math.min(0, await store.sumRealizedPnlSince(store.etDayStartMs()).catch(() => 0));
                        const executedToday = await store.countExecutedSince(store.etDayStartMs()).catch(() => 0);
                        const spreadPct = quote?.bid != null && quote.ask != null && quote.ask > quote.bid
                            ? ((quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2)) * 100
                            : null;
                        const { avgDailyVolume20d } = riskCtx;
                        // Live NetLiq (both paths): the sizer needs it; the
                        // account caps of the creation gate read it too.
                        const netLiq = process.env.NODE_ENV === 'test'
                            ? null
                            : (await import('@/services/daily-loss-guard.js').then((m) => m.getDailyLossStatus()).catch(() => null))?.netLiquidation ?? null;

                        // Auto-sizing: quantity omitted → the deterministic
                        // sizer computes shares from live NetLiq, the score
                        // and the stop distance, COMPOSED with every cap the
                        // acceptance gate enforces (REQ-SIZE-002) and the
                        // cost-to-target viability check (REQ-SIZE-003).
                        // Sizing failures return the reason and the binding
                        // constraint — the model adjusts or skips, never guesses.
                        let quantity = input.quantity;
                        let costToTargetPct: number | null = null;
                        const sizingBasis = input.entryType === 'STP_LMT' && input.entryLimit != null && input.entryLimit > 0
                            ? input.entryLimit // Review 2026-08-21: STP_LMT sizes at the LIMIT cap (the worst permitted fill)
                            : input.entry;
                        if (quantity == null) {
                            const { computeQuantity } = await import('@/services/position-sizer.js');
                            if (netLiq == null || !(netLiq > 0)) {
                                return formatToolResult({ error: 'auto-sizing needs the live account net liquidation and it is unavailable — retry shortly or pass an explicit quantity' });
                            }
                            const sized = computeQuantity({
                                entry: sizingBasis, stop: input.stop, target: input.target, score: input.score, netLiquidation: netLiq,
                                tradeClass: lane.tradeClass, worstCaseGapPct: input.worstCaseGapPct, strategyId: lane.strategyId,
                                book: {
                                    ...(book.unpriceableRows.length === 0 ? { openPlannedRiskUsd: book.openPlannedRiskUsd } : {}),
                                    realizedLossTodayUsd,
                                    existingSymbolExposureUsd: book.existingSymbolExposureUsd,
                                    overnightExposureUsd: book.overnightExposureUsd,
                                    overnightStressedLossUsd: book.overnightStressedLossUsd,
                                    sameSectorExposureUsd: book.sameSectorExposureUsd,
                                    avgDailyVolume20d, spreadPct,
                                },
                            });
                            if (sized.quantity == null) {
                                logger.warn(`[trade-proposals] auto-size refused (${sized.binding ?? '?'}): ${input.symbol} ${input.direction} @${input.entry} stop ${input.stop} score ${input.score ?? '—'} — ${sized.reason}`);
                                await store.recordRefusal({
                                    symbol: input.symbol, direction: input.direction, entryType: input.entryType,
                                    entry: input.entry, entryLimit: input.entryLimit, stop: input.stop, target: input.target,
                                    score: input.score, reason: `sizer refused [${sized.binding ?? 'unknown'}]: ${sized.reason}`,
                                    triggerRank: currentTriggerRank(),
                                }).catch(() => { /* ledger is best-effort */ });
                                return formatToolResult({ error: `position sizer refused [${sized.binding ?? 'unknown'}]: ${sized.reason}` });
                            }
                            quantity = sized.quantity;
                            costToTargetPct = sized.costToTargetPct ?? null;
                            const capLine = sized.caps ? Object.entries(sized.caps).map(([k, v]) => `${k} ${Number.isFinite(v) ? v : '∞'}`).join(', ') : '';
                            logger.info(`[trade-proposals] auto-sized ${input.symbol}: ${quantity} shares (budget $${sized.riskBudget.toFixed(0)}, confidence ×${sized.multiplier}, bound by ${sized.binding ?? '?'}; caps: ${capLine}; cost-to-target ${costToTargetPct == null ? '—' : `${costToTargetPct}%`})`);
                        } else {
                            // Explicit quantity: the cost-to-target rule applies
                            // all the same (review 2026-09-06, finding 5) — this
                            // field is reachable by the model, so a quantity is
                            // not evidence of a human decision. Refused and
                            // ledgered like a sizer refusal.
                            const { estimateRoundTrip, costViability } = await import('@/services/trade-costs.js');
                            const est = estimateRoundTrip({ quantity, entry: sizingBasis, target: input.target, spreadPct }, getRiskRules());
                            costToTargetPct = est.costToTargetPct;
                            const viable = costViability(est, getRiskRules());
                            if (!viable.ok) {
                                logger.warn(`[trade-proposals] cost gate refused (explicit quantity ${quantity}): ${input.symbol} — ${viable.reason}`);
                                await store.recordRefusal({
                                    symbol: input.symbol, direction: input.direction, entryType: input.entryType,
                                    entry: input.entry, entryLimit: input.entryLimit, stop: input.stop, target: input.target,
                                    score: input.score, reason: `cost gate refused [costs]: ${viable.reason}`,
                                    triggerRank: currentTriggerRank(),
                                }).catch(() => { /* ledger is best-effort */ });
                                return formatToolResult({ error: `cost gate refused [costs]: ${viable.reason}` });
                            }
                        }

                        const p = await createProposal({
                            symbol: input.symbol,
                            direction: input.direction,
                            entryType: input.entryType,
                            entry: input.entry,
                            entryLimit: input.entryLimit,
                            stop: input.stop,
                            target: input.target,
                            quantity,
                            tif: input.tif,
                            tradeClass: lane.tradeClass,
                            strategyId: lane.strategyId,
                            setupId: input.setupId,
                            detectorVersion,
                            costToTargetPct,
                            laneRank: provenance.laneRank,
                            rankerVersion: provenance.rankerVersion,
                            // Review 2026-09-06 (finding 8): the universe the
                            // judgment could see when it decided.
                            snapshotTs: snapshotNow?.timestamp ?? null,
                            takePct: input.takePct,
                            worstCaseGapPct: input.worstCaseGapPct,
                            score: input.score,
                            rationale: input.rationale,
                            // Lane attribution (WP0.8): trigger / breadth /
                            // cron:<name> / whatsapp / agent — read from the
                            // run context, never self-reported by the model.
                            source: currentAgentLane() ?? 'agent',
                            // Judgment-purity stamp (review 2026-08-21).
                            model: currentAgentModel() ?? undefined,
                            // Regime tag at creation — the frozen sample's
                            // breadth criterion reads this (cached service;
                            // failure leaves null, never blocks a create).
                            regime: process.env.NODE_ENV !== 'test'
                                ? (await import('@/services/market-regime.js')
                                    .then((m) => m.getMarketRegime()).catch(() => null))?.tag ?? undefined
                                : undefined,
                            expiresMinutes: input.expiresMinutes,
                            // REQ-TRIG-002: the firing rank, from the run
                            // context (null off the trigger lane).
                            triggerRank: currentTriggerRank(),
                            entryContext,
                        }, {
                            ...(dailyAtr != null ? { dailyAtr } : {}),
                            ...(ema10 != null ? { ema10 } : {}),
                            // Live-only quote: enables the buy-now entry-
                            // pricing check (intraday LMT must rest away
                            // from the market; STP_LMT must trigger beyond
                            // noise). Null → check skips honestly.
                            ...(lastPrice != null ? { lastPrice } : {}),
                            // Only a VERIFIED report waives the extension
                            // guard; null (couldn't verify) stays strict.
                            ...(recentEarnings === true ? { recentEarnings: true } : {}),
                            // worstCaseGapPct reaches the gate via createProposal's own input threading.
                            ...(betEvidence ? { earningsBetEvidence: betEvidence } : {}),
                            // WP6 (REQ-SIZE-004): the SAME book context the
                            // sizer composed against — the creation gate now
                            // runs the account, headroom, overnight, sector and
                            // slot caps too, so a sized proposal passes by
                            // construction and an explicit quantity that
                            // breaks a cap is refused HERE, not at accept.
                            // Fields that are unknown are omitted (their checks
                            // skip honestly, and refuse later at accept).
                            ...(netLiq != null && netLiq > 0 ? { netLiquidation: netLiq } : {}),
                            openPositions: book.openPositions,
                            executedToday,
                            openSwingPositions: book.openSwing,
                            openEarningsBets: book.openEarningsBets,
                            existingSymbolExposure: book.existingSymbolExposureUsd,
                            ...(book.unpriceableRows.length === 0 ? { openPlannedRiskUsd: book.openPlannedRiskUsd } : {}),
                            realizedLossTodayUsd,
                            overnightExposureUsd: book.overnightExposureUsd,
                            overnightStressedLossUsd: book.overnightStressedLossUsd,
                            ...(sector != null ? { sector, sameSectorExposureUsd: book.sameSectorExposureUsd ?? 0 } : {}),
                        });

                        // Paper-only auto-execution (AUTO_EXECUTE_PAPER=true):
                        // attempted for EVERY proposal source — the executor
                        // itself gates on score, daily cap, and paper port.
                        // A refusal simply leaves the proposal open for a
                        // manual 'accept'.
                        let autoExecution: { ok: boolean; message: string } | undefined;
                        if (isAutoExecuteEnabled()) {
                            autoExecution = await autoExecuteProposal(p.id);
                        }
                        return formatToolResult({
                            created: p,
                            ...(autoExecution ? { autoExecution } : {}),
                            userInstruction: autoExecution?.ok
                                ? `${p.id} was AUTO-EXECUTED on paper (score ${p.score}) — the bracket is working; the outcome will be tracked and alerted. Tell the user this explicitly.`
                                : `Reply 'accept ${p.id}' to execute on paper, or 'reject ${p.id}'. Expires ${new Date(p.expiresAt).toISOString()}.`,
                        });
                    } catch (err) {
                        // Risk-gate refusal: return the violations so the numbers
                        // can be corrected — do not weaken them to force a trade.
                        // Logged too: refused creates leave no DB row, so without
                        // this line they are invisible in post-hoc diagnosis.
                        const msg = err instanceof Error ? err.message : String(err);
                        logger.warn(`[trade-proposals] create refused: ${input.symbol} ${input.direction} ${input.entryType} @${input.entry} stop ${input.stop} target ${input.target} q${input.quantity} — ${msg}`);
                        const { recordRefusal } = await import('@/services/trade-proposals.js');
                        await recordRefusal({
                            symbol: input.symbol, direction: input.direction, entryType: input.entryType,
                            entry: input.entry, entryLimit: input.entryLimit, stop: input.stop, target: input.target,
                            quantity: input.quantity, score: input.score, reason: msg,
                            triggerRank: currentTriggerRank(),
                        }).catch(() => { /* ledger is best-effort */ });
                        return formatToolResult({ error: msg });
                    }
                }
                case 'list': {
                    const items = await listProposals(input.status);
                    return formatToolResult({
                        count: items.length,
                        proposals: items.map((p) => ({ ...p, summary: formatProposalLine(p) })),
                    });
                }
                case 'get': {
                    const p = await getProposal(input.id);
                    return formatToolResult(p ? { proposal: p, summary: formatProposalLine(p) } : { error: `Proposal ${input.id} not found` });
                }
                case 'reject': {
                    const outcome = await rejectProposal(input.id);
                    return formatToolResult(outcome);
                }
                case 'performance': {
                    const summary = await getPerformanceSummary(
                        Date.now() - input.days * 24 * 3600_000,
                        { includeAllHistory: input.allHistory },
                    );
                    return formatToolResult({
                        days: input.days,
                        summary,
                        report: formatPerformanceReport(summary, `last ${input.days}d`),
                    });
                }
            }
        },
    });
}

const AcceptSchema = z.object({
    id: z.string().describe("Proposal id to execute, e.g. 'P-3F2A'."),
});

export function createAcceptProposalTool() {
    return new DynamicStructuredTool({
        name: 'accept_proposal',
        description:
            'Execute an open trade proposal as a paper bracket order. Requires interactive user approval; gated by the safety lock and the daily-loss kill-switch.',
        schema: AcceptSchema,
        func: async (input) => {
            const outcome = await acceptProposal(input.id);
            return formatToolResult(outcome);
        },
    });
}
