/**
 * Proposal executor — the ONLY code path that turns an accepted proposal
 * into orders. Deterministic, no LLM involved.
 *
 * Gate order on accept:
 *   1. proposal exists, is open, not expired
 *   2. paper/live safety lock (assertOrderingAllowed), session + cutoff
 *   3. epoch latch (REQ-RISK-010 — a stopped epoch pauses new entries)
 *   4. daily-loss kill-switch (assertDailyLossOk — fail-safe on uncertainty)
 *   5. one direction per vehicle complex (REQ-SCAN-008)
 *   6. accept context + microstructure (pre-open spread two-tier, REQ-RISK-008)
 *   7. risk gate with live account context (position size vs net
 *      liquidation, max open positions, max trades per day), chase gate
 *   8. bracket placement (entry + OCA stop/target)
 *
 * Callers: the WhatsApp command router (explicit human message), the
 * approval-gated accept_proposal tool (interactive TUI confirmation), the
 * dashboard action route, and the auto-executor below (paper, or live
 * behind the operator's switch + veto model — REQ-LIVE-001/004).
 */

import { placeBracketOrder } from '@/tools/ibkr/bracket.js';
import { assertOrderingAllowed, getIBApi, getManagedAccounts, getVerifiedSingleAccount, isLivePort } from '@/tools/ibkr/connection.js';
import { createIbkrMarketData } from '@/tools/ibkr/market-data.js';
import { logger } from '@/utils';
import { getMarketSession, intradayEntryCutoffReached, isMarketHalfDay, isTradeableSession, MarketSession } from '@/utils/market-hours.js';
import { assertDailyLossOk, getActiveHalt } from './daily-loss-guard.js';
import { assertEpochRunning, readEpochState } from './epoch-state.js';
import { isLiveEnabled } from './live-switch.js';
import { oppositeDirectionConflict } from './vehicle-complexes.js';
import { replayMissedExecutions, trackExecutedProposal } from './outcome-tracker.js';
import { getSectorInfo } from './sector-map.js';
import { assertAcceptContext, assertProposalRisk, checkMicrostructure, checkPriceRun, ENTRY_CONFIRM_FRACTION, formulaTakePct } from './proposal-risk-gate.js';
import { buildBookContext } from './book-context.js';
import { costViability, estimateRoundTrip } from './trade-costs.js';
import { fetchDailyRiskContext } from '@/tools/ibkr/daily-atr.js';
import type { RiskRules } from '@/tools/ibkr/risk-rules.js';
import { fetchShortabilitySnapshot } from '@/tools/ibkr/microstructure.js';
import { fetchBrokerExposure, unionExposure } from './exposure-snapshot.js';
import {
    claimProposalForExecution,
    countExecutedSince,
    countOpenByClass,
    countOpenExecuted,
    etDayStartMs,
    expireStale,
    listExposure,
    formatProposalLine,
    getProposal,
    listTrackable,
    markSpreadDeferred,
    recordRefusal,
    listWorkingForSymbol,
    releaseProposalClaim,
    setAutoExecuteAt,
    setProposalStatus,
    sumRealizedPnlSince,
    type TradeProposal,
} from './trade-proposals.js';
import { getAccountProfile, getRiskRules, liveDisabledClasses } from '@/tools/ibkr/risk-rules.js';

export interface ExecutionOutcome {
    ok: boolean;
    message: string;
    /** Set when the refusal came from the chase gate: 'chasing' = the
     *  price ran past the entry (the setup may still be alive at fresh
     *  levels); 'invalidated' = it traded through the stop (dead). */
    chaseKind?: 'chasing' | 'invalidated';
    /** REQ-LIVE-002: the auto-executor stamped a veto-window due time
     *  instead of placing — the row stays open until the due-sweep. */
    deferred?: boolean;
}

/** REQ-RISK-008: pre-market spread over the cap but under this multiple of
 *  it is DEFERRED to the 09:31 ET re-check rather than refused. */
export function premarketSpreadHardMult(): number {
    const n = Number(process.env.PREMARKET_SPREAD_HARD_MULT);
    return Number.isFinite(n) && n >= 1 ? n : 3;
}

/** Typed chase refusal so callers can distinguish "price ran" (worth a
 *  continuation at fresh levels) from "setup dead" (never re-enter). */
class ChaseRefusalError extends Error {
    constructor(message: string, public readonly kind: 'chasing' | 'invalidated') {
        super(message);
    }
}

export interface LiveQuote {
    last: number | null;
    bid: number | null;
    ask: number | null;
}

/** Best-effort live quote (nulls when unavailable). Live-only discipline
 *  everywhere: delayed quotes refused, never silently used. WP7 exposes
 *  bid/ask too — the microstructure gate prices the spread. */
export async function fetchLiveQuote(symbol: string): Promise<LiveQuote> {
    const none: LiveQuote = { last: null, bid: null, ask: null };
    try {
        const raw = await createIbkrMarketData().invoke({ ticker: symbol, exchange: 'SMART', currency: 'USD' });
        const data = (JSON.parse(String(raw)) as { data?: { last?: number; bid?: number; ask?: number; delayed?: boolean } }).data;
        // Never gate on a delayed quote: with IBKR_MARKET_DATA_TYPE=3 an
        // unentitled instrument degrades to ~15-min-delayed ticks, and for
        // the chase/invalidation check a stale price treated as live would
        // be exactly the failure the gate exists to catch.
        if (data?.delayed) {
            logger.warn(`[proposal-executor] ${symbol}: quote is DELAYED (entitlement regression?) — accept-time checks will refuse`);
            return none;
        }
        const bid = data?.bid && Number.isFinite(data.bid) && data.bid > 0 ? data.bid : null;
        const ask = data?.ask && Number.isFinite(data.ask) && data.ask > 0 ? data.ask : null;
        const last = data?.last && Number.isFinite(data.last) && data.last > 0
            ? data.last
            : bid !== null && ask !== null ? (bid + ask) / 2 : null;
        return { last, bid, ask };
    } catch {
        return none;
    }
}

/** Last price only (creation-time buy-now check, entry-context capture). */
export async function fetchLastPrice(symbol: string): Promise<number | null> {
    return (await fetchLiveQuote(symbol)).last;
}

/** Pure (REQ-EXPO-001): the notional an open row contributes to the
 *  exposure caps. Filled rows price at the fill. Unfilled STP_LMT rows
 *  price at the WORST basis — the larger of trigger and limit cap is the
 *  fill the caps must survive (the risk gate adopted this doctrine in
 *  review-2; the notional valuer had kept pricing at the trigger). */
export function worstEntryNotional(t: {
    quantity: number;
    entryFillPrice: number | null;
    entry: number | null;
    entryLimit: number | null;
}): number {
    if (t.entryFillPrice !== null && t.entryFillPrice > 0) return t.quantity * t.entryFillPrice;
    return t.quantity * Math.max(t.entry ?? 0, t.entryLimit ?? 0);
}

/** The snapshot fields the structural checks below read (BrokerOrderSnap
 *  shape, review-18/19). */
export interface WorkingOrderView {
    orderId: number;
    symbol: string;
    orderRef: string | null;
    account: string | null;
    quantity: number | null;
    action: string | null;
    orderType: string | null;
    auxPrice: number | null;
    lmtPrice: number | null;
    ocaGroup: string | null;
    status: string | null;
    ocaType: number | null;
}

/** Review-20: the only OrderState statuses that PROVE an order is
 *  working at the broker. Inactive is invalid/rejected/held (a held
 *  order is not protection), PendingSubmit is unacknowledged, and
 *  silence proves nothing — all fail closed. */
const WORKING_STATUSES = new Set(['PreSubmitted', 'Submitted']);

/** Review-19, pure: the conservative planned-risk basis is
 *  DIRECTION-AWARE. max(cost, mark) is conservative only for a LONG; a
 *  short from $100 marked $80 with a $90 stop has $10/share of
 *  current-to-stop downside that a $100 basis hides as "zero risk".
 *  Long → max(cost, mark); short → min(cost, mark); no mark → cost. */
export function directionalBasis(positionQty: number, avgCost: number, mark: number | null): number {
    if (mark === null || !(mark > 0)) return avgCost;
    return positionQty > 0 ? Math.max(avgCost, mark) : Math.min(avgCost, mark);
}

/** Review-17/18, pure: Dexter-ref orders whose proposal row is not
 *  working (zombie brackets) plus legacy `BRKT-` fallback refs — both
 *  are unreconciled exposure-in-waiting the accept refuses. protect-/
 *  close-/reduce- refs are transient risk-REDUCING orders and stay
 *  owned. */
export function classifyOrphanBracketRefs<T extends { orderRef: string | null }>(
    orders: T[],
    workingIds: ReadonlySet<string>,
): T[] {
    return orders.filter((o) => {
        const ref = o.orderRef ?? '';
        const m = /^(P-[0-9A-F]{4}):/.exec(ref);
        if (m) return !workingIds.has(m[1]);
        return /^BRKT-/.test(ref);
    });
}

/** Review-18/19, pure: is an adopted position ACTUALLY protected? A
 *  `protect-` ref alone proves nothing — and the NORMAL protectPosition
 *  output is an OCA PAIR (`protect-SYM:stop` + `protect-SYM:tp`), so the
 *  check selects the `:stop` leg specifically and validates any `:tp`
 *  leg separately. The stop must be: exactly one `:stop`, right account,
 *  exit side, plain STP (an STP LMT's fill is NOT assured through a
 *  gap), quantity EQUAL to the position (an oversized stop REVERSES on
 *  trigger), priced. A target, when present, must mirror the stop
 *  (account/side/size) and share its OCA group — otherwise both could
 *  fill. Unknown fields fail closed. On success, returns the planned
 *  worst loss priced from the REAL broker stop against the
 *  direction-aware basis (zero for a stop already locking profit) —
 *  never the row's synthetic ±5% level. */
export function verifyAdoptedProtection(input: {
    symbol: string;
    /** Signed broker quantity — its sign IS the position's direction. */
    positionQty: number;
    /** directionalBasis(qty, avgCost, mark) — see above. */
    basisPrice: number;
    account: string;
    orders: WorkingOrderView[];
}): { ok: true; riskUsd: number } | { ok: false; reason: string } {
    const sym = input.symbol.toUpperCase();
    const long = input.positionQty > 0;
    const exitSide = long ? 'SELL' : 'BUY';
    const qty = Math.abs(input.positionQty);
    if (!(qty > 0)) return { ok: false, reason: 'no broker position to protect' };
    const protects = input.orders.filter((o) => o.symbol.toUpperCase() === sym && /^protect-/.test(o.orderRef ?? ''));
    const stopLegs = protects.filter((o) => /:stop$/.test(o.orderRef ?? ''));
    const tpLegs = protects.filter((o) => /:tp$/.test(o.orderRef ?? ''));
    const strays = protects.filter((o) => !/:(stop|tp)$/.test(o.orderRef ?? ''));
    if (strays.length > 0) {
        return { ok: false, reason: `unrecognized protect- order(s) ${strays.map((o) => `#${o.orderId} '${o.orderRef}'`).join(', ')} — re-protect with the current :stop/:tp convention` };
    }
    if (stopLegs.length === 0) return { ok: false, reason: 'no working protective stop' };
    if (stopLegs.length > 1) return { ok: false, reason: `${stopLegs.length} :stop legs — incoherent protection` };
    const s = stopLegs[0];
    if (s.account !== input.account) return { ok: false, reason: `stop #${s.orderId} in account ${s.account ?? 'unknown'}, not ${input.account}` };
    if (s.action !== exitSide) return { ok: false, reason: `stop #${s.orderId} is ${s.action ?? 'unknown'}-side — not an exit for this ${long ? 'long' : 'short'}` };
    if (s.orderType !== 'STP') return { ok: false, reason: `stop #${s.orderId} is ${s.orderType ?? 'unknown'} — only a plain STP assures an exit through a gap` };
    if (s.quantity === null || s.quantity !== qty) return { ok: false, reason: `stop #${s.orderId} covers ${s.quantity ?? '?'} of ${qty} shares — must match exactly (an oversized stop reverses on trigger)` };
    if (s.auxPrice === null || !(s.auxPrice > 0)) return { ok: false, reason: `stop #${s.orderId} has no stop price` };
    // Review-20: right ref/type/price is not enough — an Inactive,
    // cancelled or held order will not fire. Only a broker-acknowledged
    // WORKING status proves protection.
    if (s.status === null || !WORKING_STATUSES.has(s.status)) {
        return { ok: false, reason: `stop #${s.orderId} status is ${s.status ?? 'unknown'} — not a proven working order` };
    }
    if (tpLegs.length > 1) return { ok: false, reason: `${tpLegs.length} :tp legs — incoherent protection` };
    if (tpLegs.length === 1) {
        const t = tpLegs[0];
        if (t.account !== input.account) return { ok: false, reason: `target #${t.orderId} in account ${t.account ?? 'unknown'}, not ${input.account}` };
        if (t.action !== exitSide) return { ok: false, reason: `target #${t.orderId} is ${t.action ?? 'unknown'}-side — not an exit for this ${long ? 'long' : 'short'}` };
        if (t.quantity === null || t.quantity !== qty) return { ok: false, reason: `target #${t.orderId} covers ${t.quantity ?? '?'} of ${qty} shares — must match exactly` };
        if (t.status === null || !WORKING_STATUSES.has(t.status)) {
            return { ok: false, reason: `target #${t.orderId} status is ${t.status ?? 'unknown'} — not a proven working order` };
        }
        if (s.ocaGroup === null || t.ocaGroup === null || s.ocaGroup !== t.ocaGroup) {
            return { ok: false, reason: `stop #${s.orderId} and target #${t.orderId} are not OCA-joined — both could fill and reverse the position` };
        }
        // Blocking OCA (type 1) is what protectPosition places; any other
        // mode lets both legs partially fill in a race.
        if (s.ocaType !== 1 || t.ocaType !== 1) {
            return { ok: false, reason: `stop/target OCA is not BLOCKING (ocaType ${s.ocaType ?? '?'}/${t.ocaType ?? '?'}, need 1/1) — a race can overfill` };
        }
    }
    const riskUsd = long
        ? Math.max(0, input.basisPrice - s.auxPrice) * qty
        : Math.max(0, s.auxPrice - input.basisPrice) * qty;
    return { ok: true, riskUsd: Math.round(riskUsd * 100) / 100 };
}

export async function acceptProposal(id: string): Promise<ExecutionOutcome> {
    await expireStale();
    const p = await getProposal(id);
    if (!p) {
        return { ok: false, message: `Proposal ${id.toUpperCase()} not found.` };
    }
    if (p.status !== 'open') {
        return { ok: false, message: `Proposal ${p.id} is ${p.status}, not open. ${formatProposalLine(p)}` };
    }

    // Atomic claim (open → executing): exactly one concurrent accept wins.
    // Without this, two accepts racing through the async gates below could
    // both observe 'open' and place two brackets.
    if (!(await claimProposalForExecution(p.id))) {
        return { ok: false, message: `⛔ ${p.id} is already being executed by another accept — not placing a second bracket.` };
    }
    // SYMBOL-level exclusion (review 2026-08-23, omission 3): the claim is
    // atomic per proposal id — two DIFFERENT same-symbol proposals could
    // both win their own claim. After claiming, exactly one survivor per
    // symbol: any other executing/executed row on it releases this claim.
    {
        const rival = (await listWorkingForSymbol(p.symbol, p.id))[0];
        if (rival) {
            await releaseProposalClaim(p.id);
            return {
                ok: false,
                message: `⛔ ${p.id} refused: one active thesis per symbol — ${rival.id} already owns ${p.symbol} ` +
                    `(${rival.status}). Cancel or close it first.`,
            };
        }
    }

    // Safety gates — order matters: cheap static lock first, then live P&L.
    // A gate REFUSAL leaves the proposal OPEN: gates re-run on every accept,
    // and transient conditions (P&L verification timeout, a halt cleared
    // later) must not permanently kill a valid proposal before its expiry.
    // The live quote is hoisted so the refusal ledger can record what the
    // chase gate actually saw (null when the refusal fired before the fetch).
    let liveLast: number | null = null;
    // REQ-RISK-008: set by the microstructure gate when the pre-open spread
    // check was deferred; flagged on the row after a successful placement.
    let spreadDeferred = false;
    try {
        assertOrderingAllowed();
        // DAY brackets need a session to live in: placed post-close they are
        // guaranteed broker rejections (IBKR 201 "exchange is closed" —
        // observed live 2026-08-11, bell-race triggers). GTC brackets rest
        // legally at any hour; pre-market DAY orders rest until the open.
        // Gated off in tests (wall-clock dependent, same as the tracker's
        // DAY-expiry detection) — the scenario suites must not change
        // verdicts with the hour they run at.
        if (process.env.NODE_ENV !== 'test' && p.tif !== 'GTC' && !isTradeableSession(getMarketSession().session)) {
            throw new Error(
                '[session-gate] the session is over — a DAY bracket placed now is a guaranteed broker rejection. ' +
                'Re-propose as a GTC overnight setup if the thesis survives the night, or wait for the next session.',
            );
        }
        // Review-21 P1: intraday entries CLOSE with the triage window. An
        // accept at 15:54 can fill after the EOD triage's final snapshot
        // and ride the night unvetted — and the bell's 🌙 conversion would
        // then keep it, contradicting flat-by-close. Latched from the
        // CLOCK (close − 8 min, half-day aware), independent of whether
        // triage ran or succeeded. Auto-execution shares this path. GTC
        // swing/bet proposals stay governed by their overnight gates.
        // Test-gated like the session gate (wall-clock dependent).
        if (process.env.NODE_ENV !== 'test' && p.tif !== 'GTC') {
            const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            const closeMin = isMarketHalfDay(todayIso) ? 13 * 60 : 16 * 60;
            if (intradayEntryCutoffReached(nowEt.getHours() * 60 + nowEt.getMinutes(), closeMin)) {
                throw new Error(
                    '[session-gate] intraday entries are CLOSED for today (inside the EOD triage window — a fill now ' +
                    'would ride the night unvetted). Wait for the next session, or propose a GTC swing through its ' +
                    'overnight gates.',
                );
            }
        }
        // REQ-RISK-010 (live-loop WP1): a STOPPED epoch (REJECT look, -5%
        // hard stop, unresolved broker anomaly — WP3 writes the file) pauses
        // NEW ENTRIES only. Same gate lifecycle as the session gates: the
        // proposal stays open, the refusal is ledgered. Absent file = running.
        assertEpochRunning();

        const lossStatus = await assertDailyLossOk();

        // REQ-SCAN-008: one DIRECTION per vehicle complex — accepting a
        // constituent against a working vehicle (or vice versa) trades the
        // same sector both ways (2026-09-04: SOXL short breadth-triggered
        // into a semis rally while MU/ASML/ARM ran). Re-checked here because
        // the book can change between creation and accept.
        {
            const working = (await listExposure()).filter((t) => t.id !== p.id);
            const hit = oppositeDirectionConflict(p.symbol, p.direction, working, undefined, p.id);
            if (hit) {
                throw new Error(
                    `[complex-gate] REFUSED ${p.symbol}: one direction per complex — ${hit.rivalId} (${hit.rivalSymbol}, ` +
                    `${p.direction === 'long' ? 'short' : 'long'}) already works the '${hit.complex}' complex the other way; ` +
                    `cancel or close ${hit.rivalId} first, or skip`,
                );
            }
        }

        // WP6: refetch the market context — REQUIRED at accept, unlike
        // creation. A proposal created during a data outage used to reach
        // real orders with the noise-stop/target/extension/chase checks
        // silently skipped. Any missing piece refuses fail-closed (the
        // proposal stays open; retry when data is back).
        const riskCtx = await fetchDailyRiskContext(p.symbol);
        const quote = await fetchLiveQuote(p.symbol);
        const last = quote.last;
        liveLast = last;
        assertAcceptContext({ symbol: p.symbol, dailyAtr: riskCtx.dailyAtr, ema10: riskCtx.ema10, lastPrice: last });

        // WP7: microstructure — can the market absorb this order? Spread
        // and ADV are hard-required; borrow must be CONFIRMED for shorts;
        // a known halt refuses. All refusals transient (retry).
        // REQ-RISK-008: a PRE-OPEN accept of a DAY entry is quoted on the
        // pre-market book, which does not price the fill at the open —
        // the spread check becomes two-tier (defer under the hard multiple,
        // refuse beyond it); the 09:31 ET re-check (spread-recheck.ts)
        // decides the deferred rows on the regular-session quote.
        const shortSnap = await fetchShortabilitySnapshot(p.symbol);
        const preOpenDay = p.tif !== 'GTC' && getMarketSession().session === MarketSession.PRE_MARKET;
        const micro = checkMicrostructure(
            {
                symbol: p.symbol,
                direction: p.direction,
                quantity: p.quantity,
                bid: quote.bid,
                ask: quote.ask,
                avgDailyVolume20d: riskCtx.avgDailyVolume20d,
                shortable: shortSnap.shortable,
                halted: shortSnap.halted,
            },
            getRiskRules(),
            { preOpenDay, hardMult: premarketSpreadHardMult() },
        );
        for (const n of micro.notes) logger.info(`[proposal-executor] ${p.id}: ${n}`);
        if (micro.violations.length > 0) {
            throw new Error(`[microstructure-gate] ${micro.violations.join('; ')}`);
        }
        spreadDeferred = micro.spreadDeferred;

        // REQ-SIZE-003 at ACCEPTANCE (review 2026-09-06, finding 5): the
        // round trip is re-priced with the live spread — a spread unknown at
        // creation or wider now can make the trade unviable while still
        // under the microstructure cap. A deferred pre-open spread is not a
        // regular-session spread: commissions + slippage only, like an
        // unknown one.
        {
            const rules = getRiskRules();
            const spreadPct = !micro.spreadDeferred && quote.bid !== null && quote.ask !== null && quote.ask > quote.bid
                ? ((quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2)) * 100
                : null;
            const basis = p.entryFillPrice ?? Math.max(p.entry ?? 0, p.entryLimit ?? 0);
            if (basis > 0) {
                const viable = costViability(estimateRoundTrip({ quantity: p.quantity, entry: basis, target: p.target, spreadPct }, rules), rules);
                if (!viable.ok) throw new Error(`[cost-gate] ${viable.reason}`);
            }
        }

        // REQ-LANE-002 at ACCEPTANCE (review 2026-09-06, finding 2): the
        // overnight lane's cap counts real commitments excluding this row —
        // three open ideas accepted one after the other cannot pass a cap of
        // two through the swing pool of three.
        if (p.strategyId === 'overnight') {
            const { countOpenByStrategy } = await import('./trade-proposals.js');
            const openOvernight = await countOpenByStrategy('overnight', p.id);
            const cap = getRiskRules().max_overnight_lane_positions;
            if (openOvernight >= cap) {
                throw new Error(`[lane-contract] ${openOvernight} overnight-lane position(s) already working/held — max ${cap}; this accept would exceed the lane cap`);
            }
        }

        // REQ-LANE-010 at ACCEPTANCE: an intraday idea registered before the
        // cutoff but accepted inside it has the same problem — the triage
        // flattens it before an ATR-sized target can play out. Test-gated
        // like the session gate below (wall-clock dependent).
        if (process.env.NODE_ENV !== 'test' && (p.strategyId ?? (p.tradeClass === 'intraday' ? 'intraday' : null)) === 'intraday') {
            const { intradayEntryCutoffViolation } = await import('./lane-contract.js');
            const late = intradayEntryCutoffViolation(Date.now(), getRiskRules());
            if (late) throw new Error(`[lane-contract] ${late}`);
        }

        // Risk gate with live account context. Re-runs the static checks too:
        // rules may have been tightened since the proposal was created.
        const exposure = (await listExposure()).filter((t) => t.id !== p.id);

        // WP4: the broker book is canonical — the caps see the MAX of what
        // the DB believes and what the broker actually holds. FAIL CLOSED:
        // a fetch failure refuses the accept (proposal stays open, retry
        // when the snapshot is back) — unknown exposure never passes.
        // Planned-RISK headroom stays DB-side (a broker-only position has
        // no stop to price); WP3 adoption rows close that gap within a
        // sweep cycle, this union backstops the counts and notionals.
        // Review-17 P1: FRESH (no 10s cache — this decision places real
        // orders) and MARKED — every exposure sum below prices at
        // max(basis, |qty|×mark), so a position that ran since entry
        // cannot hide behind its cost. Review-18 P1: a MISSING mark
        // REFUSES the accept — cost basis is a floor under a live mark,
        // never the answer for an unknown one (a $100-cost position at
        // $150 would be understated 33% through a quote outage). The
        // proposal can wait; unpriced exposure cannot pass.
        const brokerBookRaw = await fetchBrokerExposure({ fresh: true });
        const marks = new Map<string, number>();
        const exposureSymbols = new Set([...brokerBookRaw.map((b) => b.symbol), ...exposure.map((t) => t.symbol.toUpperCase())]);
        for (const sym of exposureSymbols) {
            const m = await fetchLastPrice(sym).catch(() => null);
            if (m !== null && m > 0) marks.set(sym, m);
        }
        const unmarked = [...exposureSymbols].filter((sym) => !marks.has(sym));
        if (unmarked.length > 0) {
            throw new Error(
                `[exposure-gate] no trustworthy market mark for ${unmarked.join(', ')} — held exposure cannot ` +
                `be priced at market (cost basis is only a floor); retry when quotes return`,
            );
        }
        const brokerBook = brokerBookRaw.map((b) => ({ ...b, markPrice: marks.get(b.symbol) ?? null }));
        const exposureValue = (t: { symbol: string; quantity: number } & Parameters<typeof worstEntryNotional>[0]): number =>
            Math.max(worstEntryNotional(t), Math.abs(t.quantity) * (marks.get(t.symbol.toUpperCase()) ?? 0));
        const union = unionExposure(
            exposure.map((t) => ({ symbol: t.symbol, quantity: t.quantity, valueUsd: exposureValue(t) })),
            brokerBook,
        );
        // Review 2026-08-23 (item 5, was a warn): a broker position with no
        // DB row is exposure the sector, planned-risk and stress sums cannot
        // see — the accept REFUSES until the adoption sweep (≤15 min) gives
        // it a row. The validated selection policy must be the deployed one.
        if (union.brokerOnlySymbols.length > 0) {
            throw new Error(
                `[exposure-gate] broker holds position(s) with no DB row yet: ${union.brokerOnlySymbols.join(', ')} — ` +
                `sector/planned-risk/stress sums cannot price them; retry after the adoption sweep (runs every 15 min)`,
            );
        }
        // Foreign working orders (item 5): an order Dexter does not own is
        // exposure-in-waiting the caps cannot classify. Complete view
        // required; any non-Dexter ref refuses the accept.
        // Review-18: adopted rows' planned risk comes from their VERIFIED
        // broker stop (built here, consumed by the headroom sum below) —
        // the synthetic ±5% level never prices headroom again.
        const adoptedRiskUsd = new Map<string, number>();
        {
            const { fetchOpenOrderSnaps } = await import('./broker-adopt.js');
            const { isOurOrderRef } = await import('./position-actions.js');
            const snap = await fetchOpenOrderSnaps(await getIBApi());
            if (!snap.complete) {
                throw new Error('[exposure-gate] the open-orders snapshot did not complete — unclassified working orders may exist; retry in a moment');
            }
            const foreign = snap.orders.filter((o) => !isOurOrderRef(o.orderRef));
            if (foreign.length > 0) {
                throw new Error(
                    `[exposure-gate] ${foreign.length} working order(s) not placed by Dexter ` +
                    `(${foreign.slice(0, 4).map((o) => `#${o.orderId} ${o.symbol}`).join(', ')}${foreign.length > 4 ? ', …' : ''}) — ` +
                    `unclassifiable exposure-in-waiting; cancel them in TWS or wait for reconciliation, then retry`,
                );
            }
            // Review-17 P1: the ownership PREFIX is not reconciliation. A
            // `P-XXXX:*` ref whose proposal row is no longer working is a
            // zombie bracket — exposure-in-waiting no cap prices — and a
            // legacy `BRKT-` fallback ref maps to no row at all. Both
            // refuse. protect-/close-/reduce- refs are transient
            // risk-REDUCING orders on existing positions and stay owned.
            const workingIds = new Set([p.id, ...exposure.map((t) => t.id)]);
            const orphans = classifyOrphanBracketRefs(snap.orders, workingIds);
            if (orphans.length > 0) {
                throw new Error(
                    `[exposure-gate] ${orphans.length} working Dexter-ref order(s) with no live proposal row ` +
                    `(${orphans.slice(0, 4).map((o) => `#${o.orderId} ${o.symbol} ref '${o.orderRef}'`).join(', ')}${orphans.length > 4 ? ', …' : ''}) — ` +
                    `orphaned exposure-in-waiting; cancel them in TWS or wait for the sweeps, then retry`,
                );
            }
            // Review-17/18 P1: an adopted row's synthetic ±5% stop is
            // BOOKKEEPING, not protection — and a same-symbol `protect-`
            // REF is not verification. The stop is checked structurally
            // (account, exit side, STP type, full size, priced); only
            // then does its REAL level price the adopted row's planned
            // risk in the headroom sum below. Anything less refuses.
            const account = getVerifiedSingleAccount();
            const brokerPosBySym = new Map(brokerBookRaw.map((b) => [b.symbol, b]));
            for (const t of exposure) {
                if (t.source !== 'adopted') continue;
                const sym = t.symbol.toUpperCase();
                const pos = brokerPosBySym.get(sym);
                if (!pos || pos.quantity === 0) {
                    throw new Error(
                        `[exposure-gate] adopted row ${t.id} (${sym}) has no broker position behind it — ` +
                        `stale reconciliation; wait for the adoption sweep to resolve it, then retry`,
                    );
                }
                // Review-19: direction-aware basis — max(cost, mark) hid a
                // profitable short's current-to-stop downside as zero risk.
                // The mark is guaranteed by the unmarked-refusal above.
                const check = verifyAdoptedProtection({
                    symbol: sym,
                    positionQty: pos.quantity,
                    basisPrice: directionalBasis(pos.quantity, pos.avgCost, marks.get(sym) ?? null),
                    account,
                    orders: snap.orders,
                });
                if (!check.ok) {
                    throw new Error(
                        `[exposure-gate] adopted position ${sym} (${t.id}) is NOT verifiably protected: ${check.reason} — ` +
                        `its synthetic ±5% level prices headroom but bounds nothing; ` +
                        `'protect ${sym}' (or fix the stop) or close it before accepting new risk`,
                    );
                }
                adoptedRiskUsd.set(sym, check.riskUsd);
            }
        }

        // Sector concentration context — decision D3 (WP6): an
        // unresolvable sector no longer SKIPS the cap. Unknowns (ETFs,
        // metadata misses, resolution errors) count into a shared
        // 'UNKNOWN' bucket capped at the same percentage — a blind spot
        // can no longer accumulate unbounded concentration.
        const resolveSector = async (sym: string): Promise<string> => {
            try {
                return (await getSectorInfo(sym))?.sector ?? 'UNKNOWN';
            } catch {
                return 'UNKNOWN';
            }
        };
        const sector = await resolveSector(p.symbol);
        const sectorOf = new Map<string, string>();
        for (const t of exposure) sectorOf.set(t.symbol.toUpperCase(), await resolveSector(t.symbol));
        // WP6 (REQ-SIZE-006): the four book sums — planned risk, symbol
        // aggregate, overnight notional + class-aware stress, same-sector —
        // come from the SAME builder the creation-time sizer used, priced
        // here at max(basis, mark). Unpriceable rows are listed, never
        // zeroed: plannedWorstLossUsd's null means NOT countable (WP0.3),
        // and an adopted row prices only at its VERIFIED broker stop
        // (review-18) — either refuses the accept until the row prices,
        // fills, or dies.
        const book = buildBookContext({
            rows: exposure, symbol: p.symbol, rules: getRiskRules(), valueOf: exposureValue, sector, sectorOf, adoptedRiskUsd,
        });
        for (const u of book.unpriceableRows) {
            if (u.kind === 'adopted-unverified') {
                throw new Error(`[risk-gate] adopted row ${u.id} (${u.symbol}) missed protection verification — refuse`);
            }
            throw new Error(
                `[risk-gate] open proposal ${u.id} (${u.symbol}) has no usable price basis — ` +
                `its worst-case risk is unknown, so the daily-loss headroom cannot be computed. ` +
                `Retry when its entry fills or it is cleaned up.`,
            );
        }
        assertProposalRisk(
            {
                symbol: p.symbol,
                direction: p.direction,
                entryType: p.entryType,
                entry: p.entry,
                entryLimit: p.entryLimit,
                stop: p.stop,
                target: p.target,
                quantity: p.quantity,
                tradeClass: p.tradeClass,
                // Review 2026-09-06 (finding 6): the lane's own budget at the re-check.
                strategyId: p.strategyId,
                // WP-EXIT: the STORED x rides the re-check as an override so
                // the required target is stable across daily ATR drift.
                takePct: p.takePct,
                tif: p.tif,
            },
            {
                netLiquidation: lossStatus.netLiquidation,
                // Both counts exclude the row this accept just claimed to
                // 'executing' — otherwise the proposal consumes its own
                // position slot and daily-trade slot and the practical caps
                // sit one below the configured ones (audit 2026-08-20).
                // WP4: the DB count (per-proposal, sees stacking) and the
                // union count (per-symbol, sees broker-only positions)
                // guard different drifts — the larger one binds.
                openPositions: Math.max(await countOpenExecuted(p.id), union.distinctSymbols),
                executedToday: await countExecutedSince(etDayStartMs(), p.id),
                // Class caps re-checked with live counts (this proposal
                // excluded) — two accepts cannot both pass a full book.
                openSwingPositions: await countOpenByClass('swing', p.id),
                openEarningsBets: await countOpenByClass('earnings-bet', p.id),
                ...(p.worstCaseGapPct != null ? { worstCaseGapPct: p.worstCaseGapPct } : {}),
                // Committed notional on this symbol from OTHER working/filled
                // proposals — the aggregate cap stops same-name stacking.
                // WP4: MAX of the DB view and the broker's actual holding,
                // so a manual TWS position in the same name binds the cap.
                existingSymbolExposure: Math.max(book.existingSymbolExposureUsd, union.notionalBySymbol.get(p.symbol) ?? 0),
                // Daily-loss headroom: the open book's planned stop-outs
                // (gap cost for bets) plus today's realized losses — the
                // gate refuses a book that could stop out through the halt.
                // Every row priced (the unpriceable list above is empty).
                openPlannedRiskUsd: book.openPlannedRiskUsd,
                realizedLossTodayUsd: Math.min(0, await sumRealizedPnlSince(etDayStartMs())),
                // Overnight book: GTC rows survive the close (incl. 🌙
                // kept-overnight holds — converted to GTC at the bell);
                // CLASS-AWARE stressed loss (review 2026-08-23, omission 6):
                // a bet in the book gaps at ITS assumed severity.
                overnightExposureUsd: book.overnightExposureUsd,
                overnightStressedLossUsd: book.overnightStressedLossUsd,
                sector,
                sameSectorExposureUsd: book.sameSectorExposureUsd ?? 0,
                // WP6: the context the creation-time checks used, now
                // guaranteed present (assertAcceptContext above) — the
                // noise-stop, target-reachability and extension checks run
                // UNCONDITIONALLY at accept.
                dailyAtr: riskCtx.dailyAtr!,
                ema10: riskCtx.ema10!,
                lastPrice: last!,
                ...(riskCtx.recentEarnings === true ? { recentEarnings: true } : {}),
                // Earnings bets: re-verify the evidence at ACCEPTANCE — the
                // calendar or the record may have shifted since creation,
                // and this is the last gate before real orders. Fail-closed.
                ...(p.tradeClass === 'earnings-bet'
                    ? {
                        earningsBetEvidence: await (await import('./earnings-reactions.js'))
                            .fetchEarningsBetEvidence(p.symbol, p.direction),
                    }
                    : {}),
            },
        );

        // Chase/invalidation gate: proposal levels are anchored at creation
        // time; on a fast mover the edge may be gone by accept time. The
        // quote is guaranteed by the context gate above (WP6) — an
        // unavailable quote refused the accept before reaching here.
        if (last !== null) {
            const run = checkPriceRun(p, last);
            if (!run.ok) {
                // Steer the retry: a deep pullback limit under a runner
                // either never fills (SAP) or fills when momentum breaks
                // (AEHR) — the right re-proposal is a continuation trigger.
                // On invalidation (through the stop) the setup is dead:
                // never advise re-entering.
                const hint = run.kind === 'chasing' && p.entryType === 'LMT'
                    ? 'On a runner, a deep pullback limit either never fills or fills when momentum breaks — re-propose as STP_LMT continuation (trigger just above the market, fresh stop/target) or skip.'
                    : run.kind === 'chasing'
                        ? 'Ask for re-evaluated levels instead of accepting stale ones.'
                        : 'The setup is dead at these levels — do not re-enter; re-evaluate from scratch if the thesis still stands.';
                throw new ChaseRefusalError(`[chase-gate] ${run.reason}. ${hint}`, run.kind ?? 'chasing');
            }
        } else {
            logger.warn(`[proposal-executor] ${p.id}: live quote unavailable — chase check skipped`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[proposal-executor] ${p.id} refused by gates (proposal stays open): ${msg}`);
        await releaseProposalClaim(p.id); // refusal → back to open, retryable
        // Ledger the ACCEPTANCE-time refusal — until 2026-08-13 only
        // creation-time refusals were recorded, so the chase gate (the SMCI
        // case itself) was invisible to the nightly counterfactual replay
        // and the gate scoreboard. proposalAgeSec quantifies how stale the
        // levels were when the gate fired; each retried accept records its
        // own event (distinct age/quote — not a duplicate).
        await recordRefusal({
            symbol: p.symbol, direction: p.direction, entryType: p.entryType,
            entry: p.entry, entryLimit: p.entryLimit, stop: p.stop, target: p.target,
            quantity: p.quantity, score: p.score, reason: msg,
            proposalAgeSec: Math.round((Date.now() - p.createdAt) / 1000),
            livePrice: liveLast,
        }).catch(() => { /* ledger is best-effort — never blocks the refusal path */ });
        // Timezone audit 2026-08-25: this expiry rendered as a raw UTC ISO
        // timestamp in WhatsApp and the dashboard banner — operator-facing
        // times are ET (market clock) or Paris, always labeled, never UTC.
        const expiresEt = new Date(p.expiresAt).toLocaleTimeString('en-US', {
            timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        return {
            ok: false,
            message:
                `⛔ ${p.id} NOT executed — ${msg}\n` +
                `The proposal remains OPEN (expires ${expiresEt} ET); ` +
                `resolve the issue and reply 'accept ${p.id}' to retry.`,
            ...(err instanceof ChaseRefusalError ? { chaseKind: err.kind } : {}),
        };
    }

    try {
        const result = await placeBracketOrder({
            symbol: p.symbol,
            direction: p.direction,
            quantity: p.quantity,
            entryType: p.entryType,
            entryPrice: p.entry ?? undefined,
            entryLimitPrice: p.entryLimit ?? undefined,
            stopPrice: p.stop,
            targetPrice: p.target,
            tif: p.tif, // GTC brackets survive the close (overnight/swing)
            refId: p.id, // orderRef "<id>:leg" — the broker-side correlation key
        });

        // Broker rejection inside the ack window (WP1): the legs were
        // cancel-swept in bracket.ts. Round-6 review: 'failed' is only
        // truthful when the sweep CONFIRMED every leg dead — a 'failed'
        // row is invisible to exposure caps and the outcome tracker, so a
        // surviving leg (or a parent that filled during the sweep) would
        // be live risk on a slot Dexter considers free. With residues the
        // row stays 'executed' + tracked, mirroring the
        // placement-unconfirmed precedent: consume the slot, watch the
        // legs, let reconciliation finalize the truth.
        if (result.ack.outcome === 'rejected') {
            const r = result.ack.rejection!;
            const reason = `broker rejected order ${r.orderId} (code ${r.code ?? '?'}): ${r.reason}`;
            const residues = result.ack.sweepResidues ?? [];
            if (residues.length === 0) {
                await setProposalStatus(p.id, 'failed', { note: reason });
                logger.error(`[proposal-executor] ${p.id} ${reason}`);
                return {
                    ok: false,
                    message: `❌ ${p.id} NOT executed — ${reason}. All bracket legs were cancelled (broker-confirmed); nothing is working.`,
                };
            }
            const residueNote = `rejected-with-residues: ${reason}; legs NOT confirmed dead: ${residues.join(', ')}`;
            await setProposalStatus(p.id, 'executed', {
                orderIds: [result.parentOrderId, result.takeProfitOrderId, result.stopOrderId],
                orderPermIds: result.ack.permIds,
                executedAt: Date.now(),
                note: residueNote,
            });
            logger.error(`[proposal-executor] ${p.id} ${residueNote} — row kept 'executed' and TRACKED so exposure caps and reconciliation see the surviving legs`);
            const residueRow = await getProposal(p.id);
            if (residueRow) {
                try { trackExecutedProposal(residueRow); } catch (err) {
                    logger.warn(`[proposal-executor] outcome tracking failed for residue row ${p.id}: ${err}`);
                }
                // Round-7 review: a leg can FILL during the multi-second
                // cancel sweep — before these ids were registered — and the
                // permanent listener discarded that event. Replay today's
                // executions so the fill lands now, not at the next
                // reconnect.
                try { await replayMissedExecutions(); } catch (err) {
                    logger.warn(`[proposal-executor] execution replay after residue registration failed: ${err}`);
                }
            }
            return {
                ok: false,
                message: `❌ ${p.id} NOT executed — ${reason}. ` +
                    `⚠️ Bracket legs NOT confirmed dead: ${residues.join(', ')} — the row stays TRACKED (slot consumed) ` +
                    `until reconciliation proves them gone; check 'orders'/TWS before retrying.`,
            };
        }

        const orderIds = [result.parentOrderId, result.takeProfitOrderId, result.stopOrderId];
        // Deviation from the remediation plan's letter (recorded): an
        // UNCONFIRMED placement is marked 'executed' with a loud note
        // rather than left 'executing' — 'executing' rows are invisible to
        // the outcome tracker and releasable by the claim sweeper, and a
        // released claim on live orders invites a double placement. The
        // conservative direction is to track and consume the slot.
        const unconfirmed = result.ack.outcome === 'unconfirmed';
        await setProposalStatus(p.id, 'executed', {
            orderIds,
            orderPermIds: result.ack.permIds,
            executedAt: Date.now(),
            ...(unconfirmed ? { note: 'placement-unconfirmed: no broker ack within the window — verify with \'orders\'' } : {}),
        });
        logger.info(`[proposal-executor] ${p.id} executed (orders ${orderIds.join('/')}, ack ${result.ack.outcome})`);
        if (spreadDeferred) {
            // REQ-RISK-008: the 09:31 ET re-check reads this flag; a failed
            // flag write must not lose the placement — it is logged loudly
            // (the row simply keeps resting, as a regular-session accept would).
            await markSpreadDeferred(p.id, true).catch((err) =>
                logger.error(`[proposal-executor] ${p.id}: could not flag the deferred spread check — ${err}`));
        }

        // Hand the bracket to the outcome tracker (fills, exit, realized P&L).
        const executed = await getProposal(p.id);
        if (executed) {
            try { trackExecutedProposal(executed); } catch (err) {
                logger.warn(`[proposal-executor] outcome tracking failed for ${p.id}: ${err}`);
            }
        }

        return {
            ok: true,
            message:
                `✅ ${p.id} bracket ${unconfirmed ? 'handed to broker' : 'ACKNOWLEDGED'}: ${p.direction.toUpperCase()} ${p.quantity} ${p.symbol} ` +
                `${p.entryType === 'MKT' ? 'at market' : `limit ${p.entry}`}, stop ${p.stop}, target ${p.target} ` +
                `(orders ${orderIds.join('/')}, OCA ${result.ocaGroup}` +
                `${result.ack.permIds[0] ? `, permId ${result.ack.permIds[0]}` : ''}).\n` +
                (unconfirmed
                    ? `⚠️ The broker has not acknowledged yet — verify with 'orders' before assuming the entry is working.`
                    : `The entry order is WORKING — you hold a position once it fills. ` +
                      `Track with 'orders' (resting orders) and 'positions' (fills).`),
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Review-23 P2: the IN-LOCK cutoff recheck throws before the id
        // grant — no order exists, so this is a GATE refusal, not an
        // execution failure. Same lifecycle as every other gate: release
        // the claim (back to open), ledger the refusal. Everything else
        // in this catch keeps failure semantics (an order may exist).
        if (msg.startsWith('[session-gate]')) {
            await releaseProposalClaim(p.id);
            await recordRefusal({
                symbol: p.symbol, direction: p.direction, entryType: p.entryType,
                entry: p.entry, entryLimit: p.entryLimit, stop: p.stop, target: p.target,
                quantity: p.quantity, score: p.score, reason: msg,
                proposalAgeSec: Math.round((Date.now() - p.createdAt) / 1000),
            }).catch(() => { /* ledger is best-effort */ });
            logger.warn(`[proposal-executor] ${p.id} refused at placement (proposal stays open): ${msg}`);
            return { ok: false, message: `⛔ ${p.id} NOT executed — ${msg}\nThe proposal remains OPEN.` };
        }
        await setProposalStatus(p.id, 'failed', { note: msg });
        logger.error(`[proposal-executor] ${p.id} failed: ${msg}`);
        return { ok: false, message: `❌ ${p.id} NOT executed — ${msg}` };
    }
}

// ---------------------------------------------------------------------------
// Auto-execution (behind AUTO_EXECUTE_PAPER; live additionally behind the
// operator's live switch — REQ-LIVE-001/002/004/006, live-loop WP1/WP4)
//
// The switch + veto model (live-loop program, 2026-09-05). The old
// doctrine — "auto-execution is never available for live; every live
// trade is a hand-accept" (assertPaperOnly) — is retired. Live
// auto-execution is a layered verdict (autoExecVerdict): on a PAPER
// account the semantics are unchanged; on a LIVE port or non-'D' account
// every condition must hold — IBKR_ALLOW_LIVE=true (the cold arm, an env
// var that needs a restart), the operator's live switch (live-switch.json,
// warm: written `true` ONLY by the operator's challenge-confirmed 'live
// on'; the system writes only `false`, on an epoch stop), verified
// account identity, the 'live' rule profile active, a running epoch and
// no latched daily halt. Any missing condition refuses with the named
// reason. The operator's per-trade controls are the veto window
// (LIVE_VETO_WINDOW_MIN > 0 stamps a due time and announces instead of
// placing — REQ-LIVE-002; the due-sweep executes oldest first through
// every gate again; a row the executor has CLAIMED cannot be vetoed —
// `cancel`/`kill` apply after placement, REQ-LIVE-007) and `kill`.
//
// REQ-LIVE-006: on a live account the classes disabled in the raw live
// yaml (swing, earnings-bet — the shadow forcing is paper-only) are never
// auto-executed: the row is marked `sim-only` (rejected + note + refusal
// ledger) and settles in the simulator; a hand `accept` is refused by the
// class gate.
//
// The daily cap (AUTO_EXECUTE_MAX_PER_DAY, default 6 — REQ-TRIG-004) and
// the score floor apply on every account type. The default window 0 is
// immediate execution.
// ---------------------------------------------------------------------------

export function isAutoExecuteEnabled(): boolean {
    return (process.env.AUTO_EXECUTE_PAPER ?? '').trim().toLowerCase() === 'true';
}

/** REQ-LIVE-002: minutes the operator has to veto before a proposal
 *  auto-executes. 0 (default) = execute unconditionally, now. */
export function liveVetoWindowMin(): number {
    const n = Number(process.env.LIVE_VETO_WINDOW_MIN);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface AutoExecState {
    livePort: boolean;
    accounts: string[];
    allowLiveEnv: boolean;
    liveSwitchEnabled: boolean;
    profile: 'paper' | 'live';
    epochOk: boolean;
    haltLatched: boolean;
}

export type AutoExecVerdict = { ok: true; account: 'paper' | 'live' } | { ok: false; reason: string };

/**
 * Pure (REQ-LIVE-001): may the auto-executor place on this account state?
 * Check ORDER matters for the operator-facing reason: on a live port the
 * static arms (env, switch) are named before the connection-dependent
 * identity — the same order the executor evaluates them in.
 */
export function autoExecVerdict(s: AutoExecState): AutoExecVerdict {
    const nonPaperAccounts = s.accounts.filter((a) => !a.toUpperCase().startsWith('D'));
    const isLive = s.livePort || nonPaperAccounts.length > 0;
    if (!isLive) {
        // An EMPTY account list is not proof of paper — it is proof of
        // nothing. Fail closed until IBKR says who we are (audit finding 4).
        if (s.accounts.length === 0) {
            return { ok: false, reason: 'account identity not verified yet (no managed accounts received) — refusing' };
        }
        return { ok: true, account: 'paper' };
    }
    if (!s.allowLiveEnv) {
        return { ok: false, reason: 'live auto-execution refused — IBKR_ALLOW_LIVE is not true (the cold arm; live port or non-paper account detected)' };
    }
    if (!s.liveSwitchEnabled) {
        return { ok: false, reason: 'live auto-execution refused — the operator\'s live switch is OFF (live-switch.json; only \'live on\' turns it on)' };
    }
    if (s.accounts.length === 0) {
        return { ok: false, reason: 'live auto-execution refused — account identity not verified yet (no managed accounts received)' };
    }
    if (s.profile !== 'live') {
        return { ok: false, reason: `live auto-execution refused — the active rule profile is '${s.profile}', not 'live'` };
    }
    if (!s.epochOk) {
        return { ok: false, reason: "live auto-execution refused — no RUNNING epoch (none started, or stopped): live automation needs an epoch ('epoch new')" };
    }
    if (s.haltLatched) {
        return { ok: false, reason: 'live auto-execution refused — the daily-loss halt is latched' };
    }
    return { ok: true, account: 'live' };
}

/** The verdict over the RUNNING process state.
 *
 *  Audit 2026-09-05 (AUD-10): the accept-path latch (REQ-RISK-010) treats an
 *  ABSENT epoch file as "intake open" — the WP1 inert seam for paper. The
 *  LIVE verdict (REQ-LIVE-001) requires a RUNNING epoch: absent is not
 *  running. The paper branch of `autoExecVerdict` never reads `epochOk`,
 *  so paper semantics are unchanged. */
function currentAutoExecVerdict(): AutoExecVerdict {
    const epoch = readEpochState();
    return autoExecVerdict({
        livePort: isLivePort(),
        accounts: getManagedAccounts(),
        allowLiveEnv: (process.env.IBKR_ALLOW_LIVE ?? '').trim().toLowerCase() === 'true',
        liveSwitchEnabled: isLiveEnabled(),
        profile: getAccountProfile(),
        epochOk: epoch.kind === 'present' && epoch.state.status === 'running',
        haltLatched: getActiveHalt() !== null,
    });
}

/** Auto-executions per ET day. REQ-TRIG-004 (2026-09-05): default 5 → 6,
 *  aligned with the live yaml's max_daily_trades so the two caps cannot
 *  disagree about how many trades a burn-in day may take. Exported for
 *  the boot banner (gateway) and the test pin. */
export function autoExecMaxPerDay(): number {
    const n = Number(process.env.AUTO_EXECUTE_MAX_PER_DAY);
    return Number.isFinite(n) && n > 0 ? n : 6;
}

export function autoExecMinScore(): number {
    const n = Number(process.env.AUTO_EXECUTE_MIN_SCORE);
    // D6 (resolved 2026-08-21): DEFAULT 0 for the paper burn-in. The old
    // 80 floor preferentially sampled one band — the ledger's worst
    // (0-for-5) — and starved the protocol's decile-monotonicity test of
    // cross-band data. The burn-in is an EXPERIMENT ON THE SCORE:
    // conditioning sampling on the score biases it. Every deterministic
    // gate still applies; AUTO_EXECUTE_MAX_PER_DAY bounds volume; sizing
    // is flat. The freeze pins whatever value is set here.
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

function etDate(): string {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

let autoExecDate = '';
let autoExecCount = 0;

/**
 * Auto-execute a proposal. Returns a non-ok outcome (never throws) when
 * disabled, capped, refused by the account verdict, deferred by the veto
 * window, or when the underlying acceptance fails.
 */
export async function autoExecuteProposal(id: string, opts: { skipVetoWindow?: boolean } = {}): Promise<ExecutionOutcome> {
    if (!isAutoExecuteEnabled()) {
        return { ok: false, message: 'auto-execute is disabled (AUTO_EXECUTE_PAPER != true)' };
    }
    const today = etDate();
    if (today !== autoExecDate) {
        autoExecDate = today;
        autoExecCount = 0;
    }
    const max = autoExecMaxPerDay();
    if (autoExecCount >= max) {
        return { ok: false, message: `auto-execute daily cap reached (${max}/day)` };
    }

    // Static live-port refusal first — it must dominate every other message.
    // The verdict names the first missing live condition (REQ-LIVE-001);
    // with no live switch writer yet (WP4) this branch is structurally OFF.
    if (isLivePort()) {
        const v = currentAutoExecVerdict();
        if (!v.ok) return { ok: false, message: `auto-execute refused — ${v.reason}` };
    }

    // Confidence gate next: a pure filter that places nothing — refusals
    // here must not depend on connection state. The account verdict runs
    // just before anything could actually execute.
    const p = await getProposal(id);
    if (!p) {
        return { ok: false, message: `auto-execute: proposal ${id.toUpperCase()} not found` };
    }
    const minScore = autoExecMinScore();
    if (p.score == null || p.score < minScore) {
        return {
            ok: false,
            message: `auto-execute: ${p.id} score ${p.score ?? 'none'} is below the confidence threshold ` +
                `${minScore} (AUTO_EXECUTE_MIN_SCORE) — left open for manual 'accept ${p.id}'`,
        };
    }

    const verdict = currentAutoExecVerdict();
    if (!verdict.ok) {
        logger.error(`[proposal-executor] auto-execute refused: ${verdict.reason}`);
        return { ok: false, message: `auto-execute refused — ${verdict.reason}` };
    }

    // REQ-LIVE-006: a live account trades only the classes the raw live
    // yaml enables. A disabled-class row is marked sim-only — it never
    // reaches the veto window or the accept path, and the simulator's
    // class variants replay it (that is where its record accrues).
    if (verdict.account === 'live' && liveDisabledClasses().includes(p.tradeClass)) {
        const msg = `sim-only: the ${p.tradeClass} class is disabled in risk-rules.live.yaml — the row settles in the simulator only (REQ-LIVE-006)`;
        await setProposalStatus(p.id, 'rejected', { note: msg });
        await recordRefusal({
            symbol: p.symbol, direction: p.direction, entryType: p.entryType,
            entry: p.entry, entryLimit: p.entryLimit, stop: p.stop, target: p.target,
            quantity: p.quantity, score: p.score, reason: msg,
            proposalAgeSec: Math.round((Date.now() - p.createdAt) / 1000),
            triggerRank: p.triggerRank,
        }).catch(() => { /* ledger is best-effort */ });
        logger.info(`[proposal-executor] ${p.id} ${p.symbol}: ${msg}`);
        return { ok: false, message: `🧪 ${p.id} ${p.symbol} ${msg}` };
    }

    // REQ-LIVE-002: veto window — stamp the due time and announce instead
    // of placing; the due-sweep (veto-window.ts) executes through this same
    // function with skipVetoWindow once the window elapses. Window 0
    // (default) is today's immediate execution.
    const windowMin = liveVetoWindowMin();
    if (windowMin > 0 && !opts.skipVetoWindow) {
        const dueMs = Date.now() + windowMin * 60_000;
        await setAutoExecuteAt(p.id, dueMs);
        const dueEt = new Date(dueMs).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
        logger.info(`[proposal-executor] ${p.id}: auto-execution deferred to ${dueEt} ET (veto window ${windowMin} min)`);
        return {
            ok: false,
            deferred: true,
            message: `⏳ ${p.id} ${p.direction.toUpperCase()} ${p.symbol} executes at ${dueEt} ET (${windowMin}-min veto window) unless you reply 'veto ${p.id}'.`,
        };
    }

    const outcome = await acceptProposal(id);
    if (outcome.ok) autoExecCount++;

    // The SMCI lesson: a 'chasing' refusal means the THESIS survived but
    // the price didn't wait — chase-gate correctness must not equal a
    // missed move. One deterministic STP_LMT continuation at fresh levels,
    // through every gate again. (proposeChaseContinuation recurses into
    // this function for the new proposal; the source guard ends the chain.)
    if (!outcome.ok && outcome.chaseKind === 'chasing') {
        const cont = await proposeChaseContinuation(p).catch((err) => {
            logger.warn(`[proposal-executor] chase continuation for ${p.id} failed: ${err}`);
            return null;
        });
        if (cont) {
            return {
                ok: outcome.ok,
                chaseKind: outcome.chaseKind,
                message: `🤖 AUTO-EXECUTE (${verdict.account}, score ${p.score}, ${autoExecCount}/${max} today) — ${outcome.message}\n${cont.message}`,
            };
        }
    }
    return {
        ok: outcome.ok,
        ...(outcome.chaseKind ? { chaseKind: outcome.chaseKind } : {}),
        message: `🤖 AUTO-EXECUTE (${verdict.account}, score ${p.score}, ${autoExecCount}/${max} today) — ${outcome.message}`,
    };
}

// ---------------------------------------------------------------------------
// Chase continuation — the SMCI lesson (2026-08-12)
//
// SMCI triggered at rank 83, was proposed at honest 2:1 geometry, and the
// chase gate refused acceptance 70 seconds later: the price had run +2.3%
// while the evaluation typed. The refusal message told the model the right
// re-proposal shape (STP_LMT continuation) — but the evaluation had
// already ended, nobody acted, and a +19% day went unmonetized. The gate
// was right to refuse the STALE price; the desk was wrong to stop there.
//
// On a 'chasing' auto-exec refusal, ONE continuation proposal is created
// deterministically: same thesis, STP_LMT trigger just above the market
// (it fills only if strength continues), the original's stop DISTANCE
// (the noise-stop calibration is unchanged minutes later), a fresh
// min_risk_reward target, tick-aligned, auto-sized, short expiry. Every
// gate re-runs on creation and acceptance. 'invalidated' refusals (traded
// through the stop) never continue — that setup is dead.
// ---------------------------------------------------------------------------

export function isChaseContinuationEnabled(): boolean {
    // Default OFF (review 2026-08-23, "profit as surely as possible"): a
    // gate that refused an extended entry should not automatically
    // manufacture another way into the same move. Re-enable deliberately
    // with CHASE_CONTINUATION=true; the machinery and its ledger stay.
    return (process.env.CHASE_CONTINUATION ?? 'false').trim().toLowerCase() === 'true';
}

/** Confirmation quantum for the continuation trigger, as a fraction of the
 *  original stop distance. The chase gate defines "the price moved
 *  meaningfully" in units of the trade's own geometry (CHASE_FRACTION of
 *  the edge); a continuation must demand confirmation on the same scale —
 *  a 0.1%-above-last trigger is microstructure noise that converts
 *  "don't chase at X" into "chase at X + 4 cents" and pays a full 1R on
 *  every false breakout of a gap-fill day. The margin arithmetic lives in
 *  the risk gate (ENTRY_CONFIRM_FRACTION) since 2026-08-18 — the same
 *  "beyond noise" definition now also gates creation-time entry pricing,
 *  and the two must never drift apart. */

/** Pure: fresh continuation levels from the live price, preserving the
 *  original stop distance. The trigger sits max(0.1%, ENTRY_CONFIRM_FRACTION
 *  × stop distance) beyond the live price — it fills only on continuation
 *  beyond noise, not on the first uptick. Target semantics follow the exit
 *  style (REQ-EXIT-011): under 'target' the take policy pins the target at
 *  x% from the limit cap (x inherited from the original's stamped take_pct,
 *  else the ATR formula — mirroring the gate's arithmetic exactly, so the
 *  levels pass the gate they are about to face); under 'ratchet' the legacy
 *  min-R:R target from the rounded stop distance. Null = degenerate (no
 *  price, no stop distance, or no ATR to price the take under 'target'). */
export function continuationLevels(
    p: { direction: 'long' | 'short'; entry: number | null; stop: number; takePct?: number | null },
    last: number,
    rules: RiskRules,
    dailyAtr: number | null,
): { entry: number; entryLimit: number; stop: number; target: number; takePct: number | null } | null {
    if (p.entry == null || !(p.entry > 0) || !(last > 0)) return null;
    const stopDist = Math.abs(p.entry - p.stop);
    if (!(stopDist > 0)) return null;
    const c2 = (x: number) => Math.ceil(x * 100) / 100;
    const f2 = (x: number) => Math.floor(x * 100) / 100;
    const confirm = Math.max(0.001 * last, ENTRY_CONFIRM_FRACTION * stopDist);
    // Review 2026-08-21 (round 3): the gate judges STP_LMT geometry at the
    // LIMIT CAP (the worst permitted fill) — so the continuation builds its
    // stop and target FROM the cap, or every continuation is refused by
    // the very gate it exists to satisfy (~1.56R at the cap when built
    // from the trigger).
    const takeTarget = (cap: number): { target: number; takePct: number } | null => {
        const x = p.takePct ?? (dailyAtr !== null && dailyAtr > 0
            ? formulaTakePct((dailyAtr / cap) * 100, rules)
            : null);
        if (x === null) return null;
        const raw = p.direction === 'long' ? cap * (1 + x / 100) : cap * (1 - x / 100);
        return { target: Math.round(raw * 100) / 100, takePct: x };
    };
    if (p.direction === 'long') {
        const trigger = c2(last + confirm);
        const cap = c2(trigger * 1.003);
        const stop = f2(cap - stopDist);
        const dist = Math.round((cap - stop) * 100) / 100;
        if (rules.exit_style === 'target') {
            const take = takeTarget(cap);
            if (!take) return null;
            return { entry: trigger, entryLimit: cap, stop, target: take.target, takePct: take.takePct };
        }
        return { entry: trigger, entryLimit: cap, stop, target: c2(cap + rules.min_risk_reward * dist), takePct: null };
    }
    const trigger = f2(last - confirm);
    if (!(trigger > 0)) return null;
    const cap = f2(trigger * 0.997);
    if (!(cap > 0)) return null;
    const stop = c2(cap + stopDist);
    const dist = Math.round((stop - cap) * 100) / 100;
    if (rules.exit_style === 'target') {
        const take = takeTarget(cap);
        if (!take) return null;
        return { entry: trigger, entryLimit: cap, stop, target: take.target, takePct: take.takePct };
    }
    return { entry: trigger, entryLimit: cap, stop, target: f2(cap - rules.min_risk_reward * dist), takePct: null };
}

/** One continuation per original proposal, process-lifetime. */
const continuedOriginals = new Map<string, string>();

async function proposeChaseContinuation(original: TradeProposal): Promise<ExecutionOutcome | null> {
    if (!isChaseContinuationEnabled()) return null;
    // Never chain: a continuation that gets chased again has had its two
    // honest shots — further pursuit is the chasing the gate exists to stop.
    if (original.source === 'chase-continuation') return null;
    if (original.tradeClass !== 'intraday') return null; // swings/bets re-plan, not re-price
    if (continuedOriginals.has(original.id)) return null;

    const last = await fetchLastPrice(original.symbol);
    if (last === null) return null;
    const rules = getRiskRules();
    // Daily context BEFORE the levels: under the take policy the target is
    // priced from the ATR (REQ-EXIT-011) — and the gate will fail closed
    // without it anyway.
    const { dailyAtr, ema10, recentEarnings } = await fetchDailyRiskContext(original.symbol);
    const levels = continuationLevels(original, last, rules, dailyAtr);
    if (!levels) return null;

    const { getDailyLossStatus } = await import('./daily-loss-guard.js');
    const { computeQuantity } = await import('./position-sizer.js');
    const netLiq = (await getDailyLossStatus().catch(() => null))?.netLiquidation;
    if (netLiq == null || !(netLiq > 0)) return null;
    const sized = computeQuantity({
        // Worst permitted fill (review 2026-08-21): STP_LMT sizes at the cap.
        entry: levels.entryLimit,
        stop: levels.stop,
        score: original.score,
        netLiquidation: netLiq,
        tradeClass: 'intraday',
    }, rules);
    if (sized.quantity === null) {
        return { ok: false, message: `🏃 chase continuation for ${original.id} not viable: ${sized.reason}` };
    }

    try {
        const { createProposal } = await import('./trade-proposals.js');
        const cont = await createProposal({
            symbol: original.symbol,
            direction: original.direction,
            // Judgment purity (review 2026-08-21): the continuation is the
            // ORIGINAL judgment re-priced — it inherits its model stamp.
            model: original.model ?? undefined,
            // Round 4: regime is stamped at CREATION time like the tool
            // path does — a continuation minutes later inherits the
            // original's tag (same thesis, same session) rather than
            // leaving NULL to erode the sample's regime breadth.
            regime: original.regime ?? undefined,
            entryType: 'STP_LMT',
            entry: levels.entry,
            entryLimit: levels.entryLimit,
            stop: levels.stop,
            target: levels.target,
            quantity: sized.quantity,
            tif: 'DAY',
            tradeClass: 'intraday',
            // REQ-EXIT-011: the take level the target was built from rides
            // as the override so the gate re-derives the SAME target.
            takePct: levels.takePct ?? undefined,
            score: original.score ?? undefined,
            rationale: `chase continuation of ${original.id} (price ran past ${original.entry} before acceptance): ` +
                `fills only on continued strength through ${levels.entry}`,
            source: 'chase-continuation',
            expiresMinutes: 30,
        }, {
            ...(dailyAtr != null ? { dailyAtr } : {}),
            ...(ema10 != null ? { ema10 } : {}),
            ...(recentEarnings === true ? { recentEarnings: true } : {}),
        });
        continuedOriginals.set(original.id, cont.id);
        logger.info(`[proposal-executor] chase continuation ${cont.id} for ${original.id}: ${original.direction} ${original.symbol} STP_LMT @${levels.entry}`);

        const exec = await autoExecuteProposal(cont.id);
        return {
            ok: exec.ok,
            message:
                `🏃 CHASE CONTINUATION ${cont.id} (replaces the stale ${original.id} levels): ${original.direction.toUpperCase()} ` +
                `${original.symbol} STP_LMT trigger ${levels.entry} (limit ${levels.entryLimit}), stop ${levels.stop}, ` +
                `target ${levels.target}, ${sized.quantity} shares — fills only if strength continues; expires in 30 min. ${exec.message}`,
        };
    } catch (err) {
        // A gate refusal here is a final, honest no — extension/headroom/
        // caps re-judged the fresh levels and said skip.
        return { ok: false, message: `🏃 chase continuation for ${original.id} refused: ${err instanceof Error ? err.message : err}` };
    }
}

/**
 * Cancel the bracket orders of an EXECUTED, still-unfilled proposal
 * (risk-reducing: it removes a pending entry). Refused once the entry has
 * filled — a position exists then; use protect/close instead. The outcome
 * tracker observes the cancellations and closes the proposal honestly.
 */
export async function cancelProposalBracket(id: string): Promise<ExecutionOutcome> {
    const p = await getProposal(id);
    if (!p) {
        return { ok: false, message: `Proposal ${id.toUpperCase()} not found.` };
    }
    if (p.status !== 'executed' || !p.orderIds?.length) {
        return { ok: false, message: `Proposal ${p.id} has no working bracket (status: ${p.status}). Use 'reject ${p.id}' for open proposals.` };
    }
    if (p.entryFillPrice != null) {
        return {
            ok: false,
            message: `⛔ ${p.id}: the entry has FILLED — cancelling the exits would leave the ${p.symbol} position unprotected. ` +
                `Use 'close ${p.symbol}' to exit, or leave the bracket working.`,
        };
    }
    try {
        const api = await getIBApi();
        for (const orderId of p.orderIds) {
            try { api.cancelOrder(orderId); } catch { /* already gone */ }
        }
        logger.info(`[proposal-executor] ${p.id}: cancel requested for orders ${p.orderIds.join('/')}`);
        return {
            ok: true,
            message: `🚫 ${p.id}: cancel requested for the ${p.symbol} bracket (orders ${p.orderIds.join('/')}). ` +
                `The close alert confirms once IBKR processes it.`,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `❌ Could not cancel ${p.id} — ${msg}` };
    }
}

/** Resolve 'cancel SYM' to the working bracket for that symbol. */
export async function cancelProposalForSymbol(symbol: string): Promise<ExecutionOutcome> {
    const sym = symbol.toUpperCase();
    const candidates = (await listTrackable()).filter((p) => p.symbol === sym);
    if (candidates.length === 0) {
        return {
            ok: false,
            message: `No working bracket for ${sym}. 'orders' shows what is live; an open proposal is removed with 'reject P-XXXX'.`,
        };
    }
    const unfilled = candidates.filter((p) => p.entryFillPrice == null);
    if (unfilled.length > 1) {
        return {
            ok: false,
            message: `${sym} has ${unfilled.length} working brackets (${unfilled.map((p) => p.id).join(', ')}) — cancel by id.`,
        };
    }
    // Zero unfilled → every bracket's entry has filled; delegate so the
    // standard "position would be unprotected" refusal explains it.
    return cancelProposalBracket((unfilled[0] ?? candidates[0]).id);
}

export async function rejectProposal(id: string): Promise<ExecutionOutcome> {
    const p = await getProposal(id);
    if (!p) {
        return { ok: false, message: `Proposal ${id.toUpperCase()} not found.` };
    }
    if (p.status !== 'open') {
        return { ok: false, message: `Proposal ${p.id} is already ${p.status}.` };
    }
    await setProposalStatus(p.id, 'rejected');
    return { ok: true, message: `🚫 ${p.id} rejected. ${formatProposalLine({ ...p, status: 'rejected' })}` };
}
