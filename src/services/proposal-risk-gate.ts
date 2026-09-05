/**
 * Proposal risk gate — deterministic enforcement of risk-rules.yaml.
 *
 * The risk_manager tool is advisory (the LLM is *asked* to call it); this
 * gate is mandatory. It runs:
 *
 *   - at proposal CREATION (static checks: price coherence, min price,
 *     min risk/reward, quantity sanity) — a proposal that violates the
 *     rules is never persisted, so it can never be accepted;
 *   - at proposal ACCEPTANCE (context checks: position size vs live
 *     net liquidation, max open positions, max trades per day) — with the
 *     account numbers the executor already has in hand.
 *
 * Pure logic, no IBKR calls: callers supply the context. This keeps the
 * gate unit-testable and free of connection state.
 */

import { getRiskRules, type RiskRules, type TradeClass } from '@/tools/ibkr/risk-rules.js';
import { isValidQuantity, classRiskPct, gapRiskPerShare } from '@/services/position-sizer.js';
import type { StrategyId } from './lane-contract.js';
import { currentRung } from '@/services/ladder-state.js';
import { EVIDENCE_MIN_PRINTS, EVIDENCE_MIN_CONSISTENCY_PCT, type EarningsBetEvidence } from '@/services/earnings-reactions.js';
import { logger } from '@/utils';

export interface RiskGateProposal {
    symbol: string;
    direction: 'long' | 'short';
    entryType: 'LMT' | 'MKT' | 'STP_LMT';
    /** Entry price. For MKT proposals this is the indicative price used for
     *  risk math (position value, R/R); for STP_LMT it is the TRIGGER. */
    entry: number | null;
    /** STP_LMT only: the limit cap for the triggered entry. */
    entryLimit?: number | null;
    stop: number;
    target: number;
    quantity: number;
    /** Trade class; omitted = 'intraday'. Selects the risk budget and the
     *  class-specific checks (swing cap, earnings-bet cap/switch/gap math). */
    tradeClass?: TradeClass;
    /** The lane (REQ-LANE-001). Selects the lane's own budget where one
     *  exists (overnight → overnight_risk_pct) so the gate reads the same
     *  budget the sizer used (review 2026-09-06, finding 6). */
    strategyId?: StrategyId | null;
    /** Take-at-x% override (REQ-EXIT-002): the model's x, validated into
     *  [take_floor_pct, take_cap_pct]. Omitted = the ATR formula. At the
     *  accept-time re-check the STORED take_pct rides here so the required
     *  target stays stable across daily ATR drift. */
    takePct?: number | null;
    /** Bracket time-in-force. GTC = the position is MEANT to survive the
     *  close → the overnight caps apply at acceptance. Omitted = DAY. */
    tif?: 'DAY' | 'GTC';
}

export interface RiskGateContext {
    /** Live account net liquidation (USD). Enables max_position_pct check. */
    netLiquidation?: number;
    /** Executed-and-not-yet-closed proposals. Enables max_open_positions. */
    openPositions?: number;
    /** Proposals executed since the start of the ET day. Enables max_daily_trades. */
    executedToday?: number;
    /** Daily ATR(14) for the symbol (USD). Enables the noise-stop check —
     *  fetched server-side at creation, never trusted from the LLM. */
    dailyAtr?: number;
    /** EMA(10) of daily closes. With dailyAtr, enables the extension check. */
    ema10?: number;
    /** Notional (USD) already committed to THIS symbol by other working or
     *  filled proposals. Enables the per-symbol aggregate exposure check. */
    existingSymbolExposure?: number;
    /** The symbol reported earnings within the last trading session
     *  (earnings-calendar, fetched server-side). Waives the extension
     *  guard: a post-earnings re-rating is a new price regime, not a
     *  stretched move — measuring it against last week's EMA refuses
     *  exactly the days institutions are repricing (Jul 30 MSFT +15%,
     *  refused 3× at 3.2–4.6× ATR). */
    recentEarnings?: boolean;
    /** Open swing-class positions/working proposals (excluding this one).
     *  Enables the max_swing_positions cap. */
    openSwingPositions?: number;
    /** Open earnings-bet positions/working proposals (excluding this one).
     *  Enables the max_earnings_bets cap. */
    openEarningsBets?: number;
    /** Earnings bets: the symbol's worst historical adverse post-print
     *  move (%). Floored at earnings_bet_gap_floor_pct for the worst-case
     *  budget check; omitted → the floor alone is assumed. */
    worstCaseGapPct?: number;
    /** Σ planned worst-case losses (USD) of the open book — every
     *  executing/executed proposal EXCLUDING this one, each priced by
     *  plannedWorstLossUsd. Enables the daily-loss headroom check. */
    openPlannedRiskUsd?: number;
    /** Net realized P&L (USD) of trades closed today. Clamped to ≤ 0
     *  inside the check: losses shrink the headroom, wins never expand
     *  the planned-stop budget (conservative by design). */
    realizedLossTodayUsd?: number;
    /** Notional (USD) already committed to positions that survive the
     *  close (GTC rows, incl. kept-overnight holds). Enables the
     *  max_overnight_exposure_pct check for GTC proposals. */
    overnightExposureUsd?: number;
    /** CLASS-AWARE stressed loss (USD) of that same book — each row at its
     *  own gap severity (bets at max(record gap, floor, base stress)).
     *  When provided, the gap-stress check uses it instead of
     *  overnightExposureUsd × base stress (omission 6, 2026-08-23). */
    overnightStressedLossUsd?: number;
    /** Live last price at CREATION, fetched server-side (delayed quotes
     *  refused upstream — a stale price treated as live is the exact
     *  failure this exists to catch). Enables the buy-now entry-pricing
     *  check. Omitted = no live quote → the check skips honestly. */
    lastPrice?: number;
    /** The proposal symbol's sector (Nasdaq taxonomy), resolved
     *  server-side. Null/omitted = unknown or sector-less (ETF) — the
     *  sector cap is skipped with a note, never guessed. */
    sector?: string | null;
    /** Notional (USD) already committed to the SAME sector by
     *  working/filled proposals. With `sector`, enables the
     *  max_sector_exposure_pct check. */
    sameSectorExposureUsd?: number;
    /** Earnings bets: server-fetched evidence (calendar window + the
     *  symbol's own post-print record). Enables the LIVE-GATE checks —
     *  the evidence bar and the gap cross-check stop being advisory.
     *  Callers on the bet path always supply it; a fetch failure arrives
     *  as nulls, which REFUSE (fail-closed: the bar must not be
     *  satisfiable by breaking the data source). */
    earningsBetEvidence?: EarningsBetEvidence;
    /** REQ-RISK-009: the size-ladder rung (% risk) overlaying the intraday
     *  budget. Omitted = read from ladder-state.json (bottom rung when
     *  absent). Injectable so pure tests pin the arithmetic. */
    rungPct?: number;
}

/**
 * Planned worst-case loss (USD) of one working/held proposal: stop-out
 * cost for stop-protected classes, assumed adverse gap for earnings bets
 * (a stop cannot protect through a print). Null when the row lacks a
 * usable price basis (e.g. a MKT accept mid-flight before its fill) —
 * callers treat null as "not countable", never as zero risk.
 */
export function plannedWorstLossUsd(
    t: {
        quantity: number;
        entry: number | null;
        entryFillPrice?: number | null;
        entryLimit?: number | null;
        stop: number;
        tradeClass?: TradeClass;
        worstCaseGapPct?: number | null;
    },
    rules: RiskRules = getRiskRules(),
): number | null {
    // Unfilled rows price at the WORST basis (review 2026-08-21): when both
    // entry and entryLimit exist (STP_LMT), the one farther from the stop
    // is the fill the headroom must survive. A real fill overrides both.
    const worstUnfilled = t.entry != null && t.entryLimit != null && t.entryLimit > 0
        ? (Math.abs(t.entryLimit - t.stop) > Math.abs(t.entry - t.stop) ? t.entryLimit : t.entry)
        : t.entry ?? t.entryLimit ?? null;
    const basis = t.entryFillPrice ?? worstUnfilled;
    if (basis == null || !(basis > 0) || !(t.quantity > 0)) return null;
    if ((t.tradeClass ?? 'intraday') === 'earnings-bet') {
        const perShare = gapRiskPerShare(basis, t.worstCaseGapPct ?? undefined, rules);
        return Math.round(t.quantity * perShare * 100) / 100;
    }
    const dist = Math.abs(basis - t.stop);
    if (!(dist > 0)) return null;
    return Math.round(t.quantity * dist * 100) / 100;
}

/**
 * The worst planned book the caps AUTHORIZE, as % of NetLiq: fill the
 * class caps with the most expensive mix that fits max_open_positions.
 * Pure config arithmetic — when this exceeds max_daily_loss_pct, the
 * config is self-contradictory (the sizer may build a book whose planned
 * stop-outs breach the kill-switch) and the headroom gate will bind
 * before the position caps do. Surfaced as a startup warning.
 */
export function plannedBookWorstCasePct(rules: RiskRules = getRiskRules()): number {
    let slots = rules.max_open_positions;
    let pct = 0;
    const take = (n: number, each: number) => {
        const used = Math.max(0, Math.min(n, slots));
        slots -= used;
        pct += used * each;
    };
    // Most expensive classes first (swing > earnings-bet ≥ intraday in
    // both profiles; ties are order-independent).
    const classes = [
        { n: rules.max_swing_positions, each: rules.swing_risk_pct },
        { n: rules.earnings_bet_enabled ? rules.max_earnings_bets : 0, each: rules.earnings_bet_risk_pct },
    ].sort((a, b) => b.each - a.each);
    for (const c of classes) if (c.each > rules.max_risk_per_trade_pct) take(c.n, c.each);
    take(slots, rules.max_risk_per_trade_pct);
    return Math.round(pct * 100) / 100;
}

export interface RiskGateResult {
    ok: boolean;
    violations: string[];
    /** Checks that were waived or downgraded, with the reason — surfaced
     *  in logs so exceptions stay visible in post-hoc diagnosis. */
    notes: string[];
    /** Informational values computed along the way. */
    riskReward: number | null;
    positionValue: number | null;
    /** Effective take percent under the take-at-x% policy (REQ-EXIT-001);
     *  null when the policy did not apply (class exempt, ratchet mode) or
     *  the proposal was refused before x could be priced. Persisted on the
     *  proposal so the accept-time re-check reuses the SAME x (an override)
     *  instead of re-deriving from drifted ATR. */
    takePct: number | null;
    takePctSource: 'formula' | 'model' | null;
}

// ---------------------------------------------------------------------------
// Take-at-x% exit policy (WP-EXIT, operator decision 2026-08-22)
// ---------------------------------------------------------------------------

export interface TakeTargetCheck {
    violations: string[];
    notes: string[];
    takePct: number | null;
    takePctSource: 'formula' | 'model' | null;
    /** The tick-aligned target the policy demands; null when refused
     *  before a target could be priced (no ATR, band violation, symbol
     *  ineligible). */
    requiredTarget: number | null;
}

/** The formula half of REQ-EXIT-001: x = clamp(mult × ATR%, floor, cap).
 *  Exported for the ratchet-mode trail (REQ-EXIT-008 formula fallback). */
export function formulaTakePct(atrPct: number, rules: RiskRules): number {
    return Math.min(rules.take_cap_pct, Math.max(rules.take_floor_pct, rules.take_atr_mult * atrPct));
}

/**
 * Pure (REQ-EXIT-001..005): the intraday target IS the take level —
 * "better now than later" (operator, 2026-08-22). x comes from the model's
 * take_pct override inside [floor, cap], else from the ATR formula; the
 * target must sit at x% from the WORST permitted fill. The max_target_atr
 * reachability cap WINS over the floor: a symbol whose ATR is too low (or
 * too high) for the band is intraday-ineligible, with no target
 * prescription — two contradictory prescriptions teach surrender.
 */
export function checkTakeTarget(
    input: {
        symbol: string;
        direction: 'long' | 'short';
        /** Worst permitted fill (STP_LMT limit cap when present, else entry). */
        basis: number;
        target: number;
        dailyAtr: number | undefined;
        takePctOverride: number | null | undefined;
        recentEarnings: boolean;
    },
    rules: RiskRules,
): TakeTargetCheck {
    const none: Omit<TakeTargetCheck, 'violations' | 'notes'> = { takePct: null, takePctSource: null, requiredTarget: null };
    const violations: string[] = [];
    const notes: string[] = [];

    // REQ-EXIT-005: no ATR, no take target — fail closed for the class.
    if (input.dailyAtr === undefined || !(input.dailyAtr > 0)) {
        violations.push(
            `daily ATR unavailable for ${input.symbol} — the intraday take target cannot be priced (fail-closed): ` +
            `retry when daily bars are available, make it a swing with swing-class vetting, or skip`,
        );
        return { ...none, violations, notes };
    }
    const atrPct = (input.dailyAtr / input.basis) * 100;

    // REQ-EXIT-002: a model override lives inside the band or dies.
    let x: number;
    let source: 'formula' | 'model';
    if (input.takePctOverride !== null && input.takePctOverride !== undefined) {
        if (!(input.takePctOverride >= rules.take_floor_pct) || !(input.takePctOverride <= rules.take_cap_pct)) {
            violations.push(
                `take_pct ${input.takePctOverride} is outside the take band [${rules.take_floor_pct}%, ${rules.take_cap_pct}%] — ` +
                `resubmit inside the band or omit take_pct for the ATR default`,
            );
            return { ...none, violations, notes };
        }
        x = input.takePctOverride;
        source = 'model';
    } else {
        x = formulaTakePct(atrPct, rules);
        source = 'formula';
    }

    // The narrowest honest take: the noise-stop floor and min R/R together
    // demand x ≥ min_risk_reward × min_stop_atr_fraction × ATR%. Below it
    // no stop placement can satisfy both — refuse with the reason, not two
    // contradictory prescriptions later.
    const minViableX = rules.min_risk_reward * rules.min_stop_atr_fraction * atrPct;
    if (x < minViableX - 1e-9) {
        violations.push(source === 'model'
            ? `take_pct ${x}% is too tight for a ${atrPct.toFixed(1)}%-ATR symbol: the noise-stop floor × ` +
              `${rules.min_risk_reward}:1 needs at least ${minViableX.toFixed(1)}% — raise take_pct or skip`
            : `${input.symbol} is intraday-ineligible: daily ATR ${atrPct.toFixed(1)}% of price is too HIGH for the ` +
              `take band (cap ${rules.take_cap_pct}% < the ${minViableX.toFixed(1)}% the noise-stop floor demands) — ` +
              `make it a swing with swing-class vetting, or skip`);
        return { ...none, violations, notes };
    }

    // REQ-EXIT-004: reachability. The cap wins over the floor — and over a
    // model override. Waived on post-print repricing days like the other
    // ATR-yardstick checks.
    const requiredRewardUsd = (input.basis * x) / 100;
    if (rules.max_target_atr > 0 && input.recentEarnings !== true
        && requiredRewardUsd > rules.max_target_atr * input.dailyAtr + 1e-9) {
        const maxXpct = ((rules.max_target_atr * input.dailyAtr) / input.basis) * 100;
        if (source === 'model' && maxXpct >= rules.take_floor_pct - 1e-9) {
            violations.push(
                `take_pct ${x}% exceeds reachability at this ATR — the ${rules.max_target_atr}×ATR cap allows at ` +
                `most ${(Math.floor(maxXpct * 10) / 10).toFixed(1)}%; lower take_pct or omit it for the ATR default`,
            );
        } else {
            // Formula floor bound (or an override the cap forbids entirely):
            // the symbol does not move enough for the take band. REQ-EXIT-004.
            violations.push(
                `${input.symbol} is intraday-ineligible: daily ATR ${atrPct.toFixed(1)}% of price is too low for the ` +
                `take band — the ${rules.take_floor_pct}% floor sits ${(rules.take_floor_pct / atrPct).toFixed(1)}×ATR away, ` +
                `past the ${rules.max_target_atr}×ATR reachability cap (intraday needs dailyATR ≳ ` +
                `${(rules.take_floor_pct / rules.take_atr_mult).toFixed(1)}%). SKIP it for intraday, or make it a swing`,
            );
        }
        return { ...none, violations, notes };
    }
    if (rules.max_target_atr > 0 && input.recentEarnings === true
        && requiredRewardUsd > rules.max_target_atr * input.dailyAtr + 1e-9) {
        notes.push(
            `take-target reachability waived for ${input.symbol}: ${(requiredRewardUsd / input.dailyAtr).toFixed(1)}×ATR ` +
            `take, but the symbol reported earnings within the last session (repricing day)`,
        );
    }

    // REQ-EXIT-001/003: the target sits AT the take level, tick-aligned.
    const raw = input.direction === 'long' ? input.basis * (1 + x / 100) : input.basis * (1 - x / 100);
    const requiredTarget = Math.round(raw * 100) / 100;
    const tolerance = Math.max(0.01, input.basis * 0.0005);
    if (Math.abs(input.target - requiredTarget) > tolerance + 1e-9) {
        violations.push(
            `target ${input.target} does not sit at the take level: the intraday exit policy places the target AT ` +
            `x = ${x.toFixed(2)}% (${source}${source === 'formula' ? `, ${rules.take_atr_mult}×ATR clamped to [${rules.take_floor_pct}, ${rules.take_cap_pct}]` : ''}) ` +
            `from the worst permitted fill $${input.basis} — use target $${requiredTarget.toFixed(2)}`,
        );
        return { takePct: x, takePctSource: source, requiredTarget, violations, notes };
    }
    notes.push(`take target: ${x.toFixed(2)}% (${source}) → $${requiredTarget.toFixed(2)} (${(requiredRewardUsd / input.dailyAtr).toFixed(2)}×ATR)`);
    return { takePct: x, takePctSource: source, requiredTarget, violations, notes };
}

/**
 * Check a proposal against the risk rules. Static checks always run;
 * context checks run only for the context fields provided.
 */
export function checkProposalRisk(
    p: RiskGateProposal,
    ctx: RiskGateContext = {},
    rules: RiskRules = getRiskRules(),
): RiskGateResult {
    const violations: string[] = [];
    const notes: string[] = [];
    const tradeClass: TradeClass = p.tradeClass ?? 'intraday';

    // --- Trade-class switches and caps ---
    // The earnings-bet master switch is the paper-only-until-proven lock:
    // in the live profile it stays false until the class has its own
    // track record (~10 bets with acceptable outcomes).
    if (tradeClass === 'earnings-bet' && !rules.earnings_bet_enabled) {
        violations.push(
            'earnings bets are disabled in this account profile (paper-only until the class is proven) — ' +
            'do not re-propose as another class to work around this',
        );
    }
    if (tradeClass === 'earnings-bet' && ctx.openEarningsBets !== undefined
        && ctx.openEarningsBets >= rules.max_earnings_bets) {
        violations.push(
            `${ctx.openEarningsBets} earnings bet(s) already open — max ${rules.max_earnings_bets} at a time; ` +
            'wait for the open bet to resolve',
        );
    }
    // Flat-by-close corollary (review 2026-08-23): an intraday thesis ends
    // with its session, so its ENTRY has no business outliving the day —
    // a GTC intraday parent was the one order the expiry sweeper could not
    // reach while the gateway was down. DAY parents die at the bell
    // broker-side, no gateway required.
    if (tradeClass === 'intraday' && p.tif === 'GTC') {
        violations.push(
            'intraday theses end with the session (flat by close) — use tif DAY; ' +
            'a setup meant to outlive the day is a SWING proposal with swing-class vetting',
        );
    }
    if (tradeClass === 'swing' && !rules.swing_enabled) {
        violations.push(
            'the swing class is disabled in this profile (unvalidated or switched off pending its own record) — ' +
            'do not re-propose as another class to work around this',
        );
    }
    if (tradeClass === 'swing' && ctx.openSwingPositions !== undefined
        && ctx.openSwingPositions >= rules.max_swing_positions) {
        violations.push(
            `${ctx.openSwingPositions} swing positions already open/working — max ${rules.max_swing_positions}; ` +
            'close or cancel one first, or skip',
        );
    }

    // --- Earnings-bet LIVE-GATE: the evidence bar stops being advisory ---
    // Until 2026-08-11 the gate took worstCaseGapPct verbatim from the
    // model and never checked the record or the calendar: a flattering 20%
    // on a 45%-gap name undersized the bet by >2×, and a mislabeled class
    // needed no print at all. Flagged [LIVE-GATE] since AUDIT-2026-08-06 —
    // required before earnings_bet_enabled ever flips on a live profile.
    // (The bar's external-signal leg stays with the judgment layer: only
    // the machine-checkable legs are enforced here.)
    if (tradeClass === 'earnings-bet' && ctx.earningsBetEvidence) {
        const ev = ctx.earningsBetEvidence;
        if (ev.reportsWithinWindow !== true) {
            violations.push(ev.reportsWithinWindow === false
                ? `${p.symbol} has no verifiable print tonight or next-session pre-market — an earnings bet needs one; check earnings_calendar (a mislabeled class does not dodge the intraday rules)`
                : 'the print could not be verified (earnings calendar unavailable) — an unconfirmed date kills the bet');
        }
        if (ev.meetsBar !== true) {
            violations.push(ev.meetsBar === false
                ? `the symbol's own record does not meet the evidence bar for a ${p.direction} bet ` +
                  `(${ev.nPrints ?? '?'} prints, ${ev.consistencyPct ?? '?'}% consistency; ` +
                  `need ≥${EVIDENCE_MIN_PRINTS} prints and ≥${EVIDENCE_MIN_CONSISTENCY_PCT}%) — no bet`
                : 'no post-print record could be built for the symbol — no evidence base, no bet');
        }
        // REQ-VAL-002: the record must stand on calendar-VERIFIED prints,
        // not the gap-snap inference that manufactures the older dates —
        // on a total calendar failure the record is 100% inferred and this
        // refuses by construction (null counts as zero).
        if ((ev.nVerified ?? 0) < rules.earnings_bet_min_verified) {
            violations.push(
                `only ${ev.nVerified ?? 0} of ${ev.nPrints ?? '?'} prints in the record are calendar-verified ` +
                `(need ≥${rules.earnings_bet_min_verified}) — a record carried by gap-snap inference is not evidence; no bet`,
            );
        }
        if (ev.recordWorstAdversePct !== null && ev.recordWorstAdversePct > 0) {
            const assumed = Math.max(ctx.worstCaseGapPct ?? 0, rules.earnings_bet_gap_floor_pct);
            if (assumed < ev.recordWorstAdversePct - 1e-9) {
                violations.push(
                    `sized to a ${assumed}% adverse gap, but the symbol's own record has gapped ` +
                    `${ev.recordWorstAdversePct}% against a ${p.direction} — pass worstCaseGapPct ≥ ` +
                    `${ev.recordWorstAdversePct} (the record, not the floor, is the worst case)`,
                );
            }
        }
    }

    // --- Quantity sanity (whole shares, or IBKR 0.0001 fractions when the
    // active profile enables fractional_shares) ---
    if (!isValidQuantity(p.quantity, rules.fractional_shares)) {
        violations.push(
            rules.fractional_shares
                ? `quantity must be positive at IBKR's 0.0001-share resolution (got ${p.quantity})`
                : `quantity must be a positive integer (got ${p.quantity})`,
        );
    }

    // --- Entry price is required (indicative for MKT) ---
    const entry = p.entry;
    if (entry == null || !(entry > 0)) {
        violations.push(
            'entry price is required — for MKT proposals pass the current price as an indicative entry for risk validation',
        );
        return { ok: false, violations, notes, riskReward: null, positionValue: null, takePct: null, takePctSource: null };
    }

    // --- Price coherence: stop and target on the correct sides ---
    if (p.direction === 'long') {
        if (!(p.stop < entry)) violations.push(`long: stop ${p.stop} must be below entry ${entry}`);
        if (!(p.target > entry)) violations.push(`long: target ${p.target} must be above entry ${entry}`);
    } else {
        if (!(p.stop > entry)) violations.push(`short: stop ${p.stop} must be above entry ${entry}`);
        if (!(p.target < entry)) violations.push(`short: target ${p.target} must be below entry ${entry}`);
    }

    // --- STP_LMT: the limit cap must sit beyond the trigger, inside the target ---
    if (p.entryType === 'STP_LMT') {
        const cap = p.entryLimit;
        if (cap == null || !(cap > 0)) {
            violations.push('STP_LMT entries require entryLimit (the limit cap beyond the trigger)');
        } else if (p.direction === 'long') {
            if (!(cap >= entry)) violations.push(`long STP_LMT: entryLimit ${cap} must be at or above the trigger ${entry}`);
            if (!(p.target > cap)) violations.push(`long STP_LMT: target ${p.target} must be above the limit cap ${cap}`);
        } else {
            if (!(cap <= entry)) violations.push(`short STP_LMT: entryLimit ${cap} must be at or below the trigger ${entry}`);
            if (!(p.target < cap)) violations.push(`short STP_LMT: target ${p.target} must be below the limit cap ${cap}`);
        }
    }

    // --- Minimum price (penny-stock filter) ---
    if (entry < rules.min_price) {
        violations.push(`entry $${entry} is below the minimum price $${rules.min_price}`);
    }

    // --- Tick alignment: IBKR hard-rejects sub-penny prices on US stocks
    // ≥ $1 (error 110) — observed live 2026-08-11: ACHR entry 6.845 killed
    // the bracket AFTER acceptance, leaving an executed proposal with a
    // dead entry order. A mid-quote is not a placeable price; refuse with
    // the two valid neighbors instead of letting the broker refuse later.
    for (const [field, value] of [
        ['entry', entry],
        ['entryLimit', p.entryLimit ?? null],
        ['stop', p.stop],
        ['target', p.target],
    ] as const) {
        if (value == null || !(value >= 1)) continue; // sub-$1 ticks at $0.0001 — min_price refuses those anyway
        const cents = value * 100;
        if (Math.abs(cents - Math.round(cents)) > 1e-6) {
            const below = (Math.floor(cents) / 100).toFixed(2);
            const above = (Math.ceil(cents) / 100).toFixed(2);
            violations.push(
                `${field} $${value} is not on the $0.01 tick grid — use ${below} or ${above} ` +
                `(IBKR rejects sub-penny prices on stocks ≥ $1; a mid-quote is not a placeable price)`,
            );
        }
    }

    // --- Minimum risk/reward ---
    // Review 2026-08-21: for STP_LMT the WORST permitted fill is the LIMIT
    // cap, not the trigger — a fill at the cap widens the stop distance and
    // narrows the reward, so the geometry is judged at the cap (the fill
    // the trade can actually get). LMT/MKT keep `entry` as the basis (LMT
    // fills at-or-better; MKT drift is the accept-time chase gate's job).
    const riskBasis = p.entryType === 'STP_LMT' && p.entryLimit != null && p.entryLimit > 0
        ? p.entryLimit
        : entry;
    const risk = Math.abs(riskBasis - p.stop);
    const reward = Math.abs(p.target - riskBasis);
    const riskReward = risk > 0 ? Math.round((reward / risk) * 100) / 100 : null;
    const rrFailed = riskReward !== null && riskReward < rules.min_risk_reward;
    if (rrFailed) {
        violations.push(
            `risk/reward ${riskReward}:1 is below the minimum ${rules.min_risk_reward}:1` +
            (riskBasis !== entry ? ` (judged at the STP_LMT limit cap ${riskBasis} — the worst permitted fill)` : ''),
        );
    }

    // --- Take-at-x% exit policy (WP-EXIT): the intraday target IS the take
    // level. Active only in 'target' exit style — 'ratchet' keeps the free
    // target with the legacy reachability cap below. Runs even when the
    // side-coherence checks above already flagged the target (their
    // violations coexist; the take prescription names the exact price).
    const takeActive = tradeClass === 'intraday' && rules.exit_style === 'target';
    let take: TakeTargetCheck | null = null;
    if (takeActive) {
        take = checkTakeTarget({
            symbol: p.symbol,
            direction: p.direction,
            basis: riskBasis,
            target: p.target,
            dailyAtr: ctx.dailyAtr,
            takePctOverride: p.takePct,
            recentEarnings: ctx.recentEarnings === true,
        }, rules);
        violations.push(...take.violations);
        notes.push(...take.notes);
    }

    // --- Entry pricing vs the live tape (buy-now chase filter) ---
    // 72 of 79 executed entries were plain limits at the current quote,
    // median 47 seconds from placement to fill, 12% wins (2026-08-18 entry
    // audit): the proposal price WAS the chase — discovery scans only see
    // stocks that already moved, and pricing the entry at the quote buys
    // the top of the discovery move. An intraday entry must either REST
    // beyond the market on the pullback side (the market comes to us) or
    // DEMAND continuation via a STP_LMT trigger beyond noise. Same margin
    // both ways: max(0.1%, ENTRY_CONFIRM_FRACTION × stop distance) — the
    // chase-continuation trigger's own confirm arithmetic. Swing and
    // earnings-bet entries follow different doctrines (multi-day structure,
    // pre-print timing) and are exempt. Creation-time only: a resting
    // pullback limit that the market later reaches is the plan WORKING,
    // so the acceptance-time re-check must not see this. No live quote →
    // skipped honestly (delayed quotes are refused upstream).
    if (tradeClass === 'intraday' && ctx.lastPrice !== undefined && ctx.lastPrice > 0 && risk > 0) {
        const last = ctx.lastPrice;
        const margin = Math.max(0.001 * last, ENTRY_CONFIRM_FRACTION * risk);
        const pullbackBound = p.direction === 'long'
            ? Math.floor((last - margin) * 100) / 100
            : Math.ceil((last + margin) * 100) / 100;
        const triggerBound = p.direction === 'long'
            ? Math.ceil((last + margin) * 100) / 100
            : Math.floor((last - margin) * 100) / 100;
        const alternatives =
            `either rest a pullback LMT ${p.direction === 'long' ? 'at/below' : 'at/above'} ` +
            `$${pullbackBound.toFixed(2)}, or demand continuation with a STP_LMT triggered ` +
            `${p.direction === 'long' ? 'at/beyond' : 'at/below'} $${triggerBound.toFixed(2)} ` +
            `moving the WHOLE bracket with it (same stop distance, target re-derived), or skip`;
        if (p.entryType === 'MKT') {
            violations.push(
                `MKT is a buy-now entry with the market at ${last} — buying the discovery move at its top ` +
                `is the record's losing pattern; ${alternatives}`,
            );
        } else if (p.entryType === 'LMT') {
            const restsAway = p.direction === 'long' ? entry <= last - margin + 1e-9 : entry >= last + margin - 1e-9;
            if (!restsAway) {
                violations.push(
                    `LMT ${entry} with the market at ${last} is a buy-now entry (fills on the next tick — the ` +
                    `record's losing pattern: 72/79 entries, 12% wins); ${alternatives}`,
                );
            }
        } else if (p.entryType === 'STP_LMT') {
            const confirms = p.direction === 'long' ? entry >= last + margin - 1e-9 : entry <= last - margin + 1e-9;
            if (!confirms) {
                violations.push(
                    `STP_LMT trigger ${entry} sits inside noise of the market at ${last} — a first-uptick fill, ` +
                    `not continuation confirmation; trigger ${p.direction === 'long' ? 'at/beyond' : 'at/below'} ` +
                    `$${triggerBound.toFixed(2)} moving the WHOLE bracket with it (same stop distance), or skip`,
                );
            }
        }
    }

    // --- Stop distance vs daily ATR (noise-stop filter) ---
    // Every early live loss exited via stop: stops placed at 0.13–0.3× the
    // daily ATR sit inside ordinary intraday noise and get hit regardless
    // of whether the idea was right.
    let noiseStopFailed = false;
    if (ctx.dailyAtr !== undefined && ctx.dailyAtr > 0 && risk > 0) {
        const minStop = rules.min_stop_atr_fraction * ctx.dailyAtr;
        if (risk < minStop) {
            noiseStopFailed = true;
            violations.push(
                `stop is $${risk.toFixed(2)} from entry — inside intraday noise for a stock with daily ` +
                `ATR $${ctx.dailyAtr.toFixed(2)} (minimum ${rules.min_stop_atr_fraction}× ATR = $${minStop.toFixed(2)}). ` +
                `Place the stop at real structure at least that far away (and resize), or skip the trade`,
            );
        }
    }

    // --- Target reachability (fantasy-target filter, intraday class only) ---
    // The mirror of the noise-stop check. 82-trade audit (2026-08-18): 81%
    // of planned R:R sat pinned at ~2:1 with targets a median 6% from entry
    // — manufactured from the ratio, not read from structure — and only 10%
    // were ever reached (33% is breakeven at 2:1). A DAY trade's target must
    // sit where price can actually travel in a fraction of one session.
    // Swing (multi-day) and earnings-bet (gap-sized) classes legitimately
    // target further; a post-print repricing day gets the same waiver as the
    // extension guard (the pre-gap ATR is the wrong yardstick there too).
    let targetCapFailed = false;
    // Subsumed by the take-target check when the take policy is active
    // (reachability is folded into checkTakeTarget, REQ-EXIT-004) — this
    // legacy form remains the ratchet-mode reachability cap.
    const targetCapEligible = tradeClass === 'intraday' && !takeActive
        && ctx.dailyAtr !== undefined && ctx.dailyAtr > 0 && rules.max_target_atr > 0;
    const targetCapActive = targetCapEligible && ctx.recentEarnings !== true;
    if (targetCapEligible && ctx.dailyAtr !== undefined && reward > rules.max_target_atr * ctx.dailyAtr + 1e-9) {
        if (!targetCapActive) {
            notes.push(
                `target-reachability check waived for ${p.symbol}: target ${(reward / ctx.dailyAtr).toFixed(1)}× daily ATR ` +
                `from entry, but the symbol reported earnings within the last session (repricing day)`,
            );
        } else {
            targetCapFailed = true;
            violations.push(
                `target ${p.target} is $${reward.toFixed(2)} from entry — ${(reward / ctx.dailyAtr).toFixed(1)}× the daily ` +
                `ATR ($${ctx.dailyAtr.toFixed(2)}) on an intraday trade (max ${rules.max_target_atr}×). Price does not ` +
                `travel that far in a fraction of one session: pick a nearer HONEST objective and tighten the stop to ` +
                `keep ${rules.min_risk_reward}:1 (or make it a swing with swing-class vetting), or skip`,
            );
        }
    }

    // --- Prescriptive geometry on stop/R:R/target refusals ---
    // Live failure (Jul 30, MU +18%): each refusal message described only its
    // own constraint, so the model fixed the stop and broke R/R, then fixed
    // R/R and broke the stop — three incompatible retries, then surrender,
    // while the jointly-valid trade existed (and its target was hit). Hand
    // over the solved system — and lead with the SKIP branch: the old
    // one-sided "target at/beyond $X" prescription is how 81% of the
    // executed record ended up with ratio-manufactured targets (2026-08-18
    // audit). The honest-objective question comes first; the numbers only
    // matter if the answer is yes.
    if ((noiseStopFailed || rrFailed) && takeActive && take?.requiredTarget != null && ctx.dailyAtr !== undefined && ctx.dailyAtr > 0) {
        // Take-policy prescription (WP-EXIT): the target is FIXED — the only
        // free variable is the stop. Solve its band: the noise floor bounds
        // it from below, the take reward / min R:R from above (inner-rounded
        // so obeying verbatim passes both ends).
        const gEntry = riskBasis;
        const minStop = rules.min_stop_atr_fraction * ctx.dailyAtr;
        const maxStop = Math.abs(take.requiredTarget - gEntry) / rules.min_risk_reward;
        const nearBound = p.direction === 'long'
            ? Math.floor((gEntry - minStop) * 100) / 100
            : Math.ceil((gEntry + minStop) * 100) / 100;
        const farBound = p.direction === 'long'
            ? Math.ceil((gEntry - maxStop) * 100) / 100
            : Math.floor((gEntry + maxStop) * 100) / 100;
        violations.push(
            `VIABLE GEOMETRY for ${p.direction} ${p.symbol} at $${gEntry}${gEntry !== entry ? ' (the STP_LMT limit cap — the worst permitted fill)' : ''}: ` +
            `the target is FIXED at $${take.requiredTarget.toFixed(2)} by the take policy (${take.takePct?.toFixed(2)}%). ` +
            `Place the stop at real structure between $${farBound.toFixed(2)} and $${nearBound.toFixed(2)} ` +
            `(noise floor ${rules.min_stop_atr_fraction}×ATR to take/${rules.min_risk_reward} — ${rules.min_risk_reward}:1 at the take level). ` +
            `If no honest stop structure sits in that band, SKIP the symbol`,
        );
    } else if ((noiseStopFailed || rrFailed || targetCapFailed) && ctx.dailyAtr !== undefined && ctx.dailyAtr > 0) {
        // Review 2026-08-21: prescribe from the WORST-FILL basis (the
        // STP_LMT limit cap when present) — trigger-based guidance built
        // levels that failed again at the cap on the very next retry.
        const gEntry = riskBasis;
        const minStop = rules.min_stop_atr_fraction * ctx.dailyAtr;
        // Bounds rounded AWAY from entry, and the target derived from the
        // ROUNDED stop distance — following the prescription verbatim must
        // pass. (Observed live: SOXL min stop $11.744 prescribed as
        // "$119.26", the model obeyed exactly and was refused by 0.4¢ —
        // an unsatisfiable-looking gate teaches surrender.)
        const stopBound = p.direction === 'long'
            ? Math.floor((gEntry - minStop) * 100) / 100
            : Math.ceil((gEntry + minStop) * 100) / 100;
        const stopDist = Math.abs(gEntry - stopBound);
        const targetBound = p.direction === 'long'
            ? Math.ceil((gEntry + rules.min_risk_reward * stopDist) * 100) / 100
            : Math.floor((gEntry - rules.min_risk_reward * stopDist) * 100) / 100;
        if (targetCapActive && ctx.dailyAtr !== undefined) {
            // Both-bounded band: the reachability cap bounds the target from
            // above, which bounds the stop distance at cap/min_rr from below
            // (inner-rounded so obeying the band verbatim passes both ends).
            const maxReward = rules.max_target_atr * ctx.dailyAtr;
            const targetCap = p.direction === 'long'
                ? Math.floor((gEntry + maxReward) * 100) / 100
                : Math.ceil((gEntry - maxReward) * 100) / 100;
            const maxStop = maxReward / rules.min_risk_reward;
            const stopFarBound = p.direction === 'long'
                ? Math.ceil((gEntry - maxStop) * 100) / 100
                : Math.floor((gEntry + maxStop) * 100) / 100;
            violations.push(
                `VIABLE GEOMETRY for ${p.direction} ${p.symbol} at $${gEntry}${gEntry !== entry ? ' (the STP_LMT limit cap — the worst permitted fill)' : ''}: FIRST — does an honest objective ` +
                `(prior high/low, measured move, gap fill) sit between $${targetBound.toFixed(2)} and ` +
                `$${targetCap.toFixed(2)}? If not, SKIP the symbol; never stretch the target to manufacture ` +
                `${rules.min_risk_reward}:1. If yes: stop at real structure between $${stopFarBound.toFixed(2)} and ` +
                `$${stopBound.toFixed(2)}, target at/beyond ${rules.min_risk_reward}× the stop distance and never ` +
                `past $${targetCap.toFixed(2)} (${rules.max_target_atr}× daily ATR — the reachability cap). ` +
                `E.g. stop $${stopBound.toFixed(2)} → target $${targetBound.toFixed(2)}`,
            );
        } else {
            // No reachability cap for this class (swing / earnings-bet) or
            // day (post-print repricing): one-sided bounds, still skip-first.
            violations.push(
                `VIABLE GEOMETRY for ${p.direction} ${p.symbol} at $${gEntry}${gEntry !== entry ? ' (the STP_LMT limit cap — the worst permitted fill)' : ''}: FIRST — is there an honest objective ` +
                `at/beyond $${targetBound.toFixed(2)}? If not, SKIP the symbol; never stretch the target to ` +
                `manufacture ${rules.min_risk_reward}:1. If yes: stop at/beyond $${stopBound.toFixed(2)} AND target ` +
                `at/beyond $${targetBound.toFixed(2)} — both together (a wider stop needs a proportionally farther ` +
                `target for ${rules.min_risk_reward}:1)`,
            );
        }
    }

    // --- Extension guard (chasing filter) ---
    // Every early live loss was an extended mover bought at the top of its
    // run — and the price never saw the target again. Entering further than
    // max_extension_atr × ATR beyond the 10-day EMA is chasing a move that
    // statistically mean-reverts; wait for consolidation or skip.
    if (ctx.dailyAtr !== undefined && ctx.dailyAtr > 0 && ctx.ema10 !== undefined && ctx.ema10 > 0) {
        const extension = p.direction === 'long'
            ? (entry - ctx.ema10) / ctx.dailyAtr
            : (ctx.ema10 - entry) / ctx.dailyAtr;
        if (extension > rules.max_extension_atr) {
            // Earnings-gap exception: a symbol that just reported is being
            // repriced, not chased — the pre-gap EMA is the wrong yardstick.
            // Every OTHER gate still applies (noise stop on pre-gap ATR,
            // R/R, risk budget, chase gate at acceptance).
            if (ctx.recentEarnings === true) {
                notes.push(
                    `extension check waived for ${p.symbol}: ${extension.toFixed(1)}× ATR beyond EMA10, but the ` +
                    `symbol reported earnings within the last session (earnings-gap exception)`,
                );
            } else {
                violations.push(
                    `entry $${entry} is ${extension.toFixed(1)}× daily ATR ${p.direction === 'long' ? 'above' : 'below'} ` +
                    `the 10-day EMA ($${ctx.ema10.toFixed(2)}) — chasing an extended move (max ${rules.max_extension_atr}×). ` +
                    `Wait for a pullback/consolidation, or skip`,
                );
            }
        }
    }

    // --- Risk budget per trade (needs net liquidation) ---
    // Normalizes what the worst planned loss costs, per class: intraday and
    // swing pay quantity × stop distance against their class budget; an
    // earnings bet pays quantity × the assumed adverse GAP (a stop cannot
    // protect through a print) against earnings_bet_risk_pct.
    if (ctx.netLiquidation !== undefined && ctx.netLiquidation > 0 && risk > 0) {
        // REQ-RISK-009: the gate enforces the EFFECTIVE budget — min(yaml
        // ceiling, ladder rung) — so an explicit quantity sized above the
        // rung, or a row whose rung stepped down between creation and
        // accept, is refused rather than waved through at the ceiling.
        const budgetPct = classRiskPct(tradeClass, rules, ctx.rungPct ?? currentRung(), p.strategyId ?? undefined);
        const maxRisk = (budgetPct / 100) * ctx.netLiquidation;
        if (tradeClass === 'earnings-bet') {
            const entryPrice = entry;
            const perShare = gapRiskPerShare(entryPrice, ctx.worstCaseGapPct, rules);
            const assumedPct = Math.max(ctx.worstCaseGapPct ?? 0, rules.earnings_bet_gap_floor_pct);
            const worstCase = Math.round(p.quantity * perShare * 100) / 100;
            if (worstCase > maxRisk) {
                const maxShares = Math.floor(maxRisk / perShare);
                violations.push(
                    `a worst-case earnings gap (${assumedPct}%) would cost $${worstCase.toFixed(0)} ` +
                    `(${p.quantity} × $${perShare.toFixed(2)}) — over the ${budgetPct}% earnings-bet budget ` +
                    `($${maxRisk.toFixed(0)}); max ${maxShares} shares. The stop does not protect through the print`,
                );
            }
        } else {
            const riskDollars = Math.round(p.quantity * risk * 100) / 100;
            if (riskDollars > maxRisk) {
                const maxShares = Math.floor(maxRisk / risk);
                violations.push(
                    `a stop-out would cost $${riskDollars.toFixed(0)} (${p.quantity} × $${risk.toFixed(2)} stop distance) — ` +
                    `over the ${budgetPct}% ${tradeClass} risk budget ($${maxRisk.toFixed(0)}); max ${maxShares} shares at these levels`,
                );
            }
        }
    }

    // --- Daily-loss headroom (acceptance-time) ---
    // The kill-switch must never be breachable by the PLANNED stops alone:
    // a book whose intended stop-outs already exceed max_daily_loss_pct is
    // a halt waiting to latch, entered on purpose. The live profile made
    // this real (audit 2026-08-11): 3 slots × 1.0–1.5% budgets vs a 2%
    // halt. Wins never expand the budget (realized P&L clamps at 0);
    // realized losses shrink it.
    if (ctx.netLiquidation !== undefined && ctx.netLiquidation > 0
        && ctx.openPlannedRiskUsd !== undefined) {
        const thisRisk = plannedWorstLossUsd(
            { ...p, worstCaseGapPct: ctx.worstCaseGapPct ?? null },
            rules,
        );
        if (thisRisk !== null) {
            const limit = (rules.max_daily_loss_pct / 100) * ctx.netLiquidation;
            const realized = Math.min(0, ctx.realizedLossTodayUsd ?? 0);
            const headroom = Math.round((limit + realized - ctx.openPlannedRiskUsd) * 100) / 100;
            if (thisRisk > headroom) {
                violations.push(
                    `planned worst case $${thisRisk.toFixed(0)} exceeds the remaining daily-loss headroom ` +
                    `$${Math.max(0, headroom).toFixed(0)} (kill-switch ${rules.max_daily_loss_pct}% = $${limit.toFixed(0)}` +
                    (realized < 0 ? `, $${Math.abs(realized).toFixed(0)} already realized in losses today` : '') +
                    `, $${ctx.openPlannedRiskUsd.toFixed(0)} committed to the open book's planned stops) — ` +
                    `the book must never be able to stop out through the halt. Close or trim something first, or skip`,
                );
            }
        }
    }

    // --- Position size vs account (acceptance-time) ---
    // Same worst-fill basis as the R/R check (review 2026-08-21): an
    // STP_LMT filling at its cap carries the cap's notional.
    const positionValue = Math.round(p.quantity * riskBasis * 100) / 100;
    if (ctx.netLiquidation !== undefined && ctx.netLiquidation > 0) {
        const maxValue = (rules.max_position_pct / 100) * ctx.netLiquidation;
        if (positionValue > maxValue) {
            const maxShares = Math.floor(maxValue / riskBasis);
            violations.push(
                `position $${positionValue.toFixed(0)} (${p.quantity} × $${riskBasis}) exceeds ` +
                `${rules.max_position_pct}% of net liquidation ($${maxValue.toFixed(0)}) — max ${maxShares} shares`,
            );
        }

        // Aggregate PER SYMBOL: two individually-passing proposals on the
        // same name must not stack past the cap (filled + resting entries
        // both count — a resting average-down fills exactly when the
        // symbol is falling).
        const existing = ctx.existingSymbolExposure ?? 0;
        if (existing > 0 && positionValue + existing > maxValue) {
            violations.push(
                `$${existing.toFixed(0)} is already committed to ${p.symbol} by working/filled proposals — ` +
                `adding $${positionValue.toFixed(0)} totals $${(positionValue + existing).toFixed(0)}, over the ` +
                `${rules.max_position_pct}% single-symbol cap ($${maxValue.toFixed(0)})`,
            );
        }
    }

    // --- Overnight caps (acceptance-time, GTC proposals only) ---
    // A GTC bracket is a position MEANT to survive the close, so it is
    // vetted against the overnight limits when the order is accepted —
    // these two caps were config-declared but enforced nowhere until
    // 2026-08-11 (skills claimed risk_manager checked them; it did not).
    // DAY positions that get KEPT at the bell are a different path: the
    // EOD triage reports their cap usage (no forced trim — operator keep
    // policy), and the 🌙 conversion already announces the vetting gap.
    if (p.tif === 'GTC' && ctx.netLiquidation !== undefined && ctx.netLiquidation > 0) {
        const maxPosition = (rules.max_overnight_position_pct / 100) * ctx.netLiquidation;
        if (positionValue > maxPosition) {
            const maxShares = Math.floor(maxPosition / entry);
            violations.push(
                `overnight position $${positionValue.toFixed(0)} exceeds ${rules.max_overnight_position_pct}% of ` +
                `net liquidation ($${maxPosition.toFixed(0)}) — the overnight cap is tighter than the intraday one; ` +
                `max ${maxShares} shares, or make it a DAY trade`,
            );
        }
        if (ctx.overnightExposureUsd !== undefined) {
            const maxTotal = (rules.max_overnight_exposure_pct / 100) * ctx.netLiquidation;
            if (positionValue + ctx.overnightExposureUsd > maxTotal) {
                violations.push(
                    `$${ctx.overnightExposureUsd.toFixed(0)} is already committed to positions that survive the close — ` +
                    `adding $${positionValue.toFixed(0)} totals $${(positionValue + ctx.overnightExposureUsd).toFixed(0)}, over the ` +
                    `${rules.max_overnight_exposure_pct}% overnight book cap ($${maxTotal.toFixed(0)}). ` +
                    `Close or trim an overnight hold first, or skip`,
                );
            }
            // Gap-stress at ACCEPTANCE (review 2026-08-23): the notional cap
            // bounds size; this bounds the LOSS an adverse overnight gap
            // hands the whole surviving book — stops do not fill through a
            // gap. Earnings bets stress at their own assumed gap (already
            // their sizing basis); everything else at the configured shock.
            const stress = rules.overnight_gap_stress_pct;
            if (stress > 0 && rules.max_daily_loss_pct > 0) {
                const ownStressPct = tradeClass === 'earnings-bet'
                    ? Math.max(stress, Math.max(ctx.worstCaseGapPct ?? 0, rules.earnings_bet_gap_floor_pct))
                    : stress;
                // Prefer the caller's class-aware book stress (each existing
                // row at its own severity); base-rate fallback for callers
                // that only know the notional.
                const bookStressUsd = ctx.overnightStressedLossUsd ?? ctx.overnightExposureUsd * (stress / 100);
                const stressedUsd = positionValue * (ownStressPct / 100) + bookStressUsd;
                const budgetUsd = (rules.max_daily_loss_pct / 100) * ctx.netLiquidation;
                if (stressedUsd > budgetUsd) {
                    violations.push(
                        `an adverse overnight gap (${stress}% book, ${ownStressPct}% this position) on the surviving book ` +
                        `would cost $${stressedUsd.toFixed(0)} — over one daily-loss budget ` +
                        `(${rules.max_daily_loss_pct}% = $${budgetUsd.toFixed(0)}). Trim the overnight book or skip`,
                    );
                }
            }
        }
    }

    // --- Sector concentration (acceptance-time) ---
    // Breadth days concentrate the book in one theme; the cap bounds how
    // much of the account one sector's gap can hit. Unknown sector (ETF,
    // data miss) skips with a note — visible, never guessed.
    if (ctx.netLiquidation !== undefined && ctx.netLiquidation > 0
        && ctx.sameSectorExposureUsd !== undefined) {
        if (ctx.sector) {
            const maxSector = (rules.max_sector_exposure_pct / 100) * ctx.netLiquidation;
            if (positionValue + ctx.sameSectorExposureUsd > maxSector) {
                // D3 (WP6): 'UNKNOWN' is the shared bucket for unresolvable
                // sectors (ETFs, metadata misses) — capped like any sector,
                // so a blind spot cannot accumulate unbounded concentration.
                const label = ctx.sector === 'UNKNOWN'
                    ? `UNRESOLVED-sector names (the shared UNKNOWN bucket)`
                    : ctx.sector;
                violations.push(
                    `$${ctx.sameSectorExposureUsd.toFixed(0)} is already committed to ${label} — ` +
                    `adding $${positionValue.toFixed(0)} totals $${(positionValue + ctx.sameSectorExposureUsd).toFixed(0)}, over the ` +
                    `${rules.max_sector_exposure_pct}% sector cap ($${maxSector.toFixed(0)}). ` +
                    (ctx.sector === 'UNKNOWN'
                        ? `Resolve the sectors (or close an unresolved name) before adding more unclassifiable exposure`
                        : `On a sector-wide move prefer the breadth vehicle over one more correlated name`),
                );
            }
        } else {
            notes.push(`sector cap not evaluated for ${p.symbol}: sector unknown (ETF or data unavailable)`);
        }
    }

    // --- Max open positions (acceptance-time) ---
    if (ctx.openPositions !== undefined && ctx.openPositions >= rules.max_open_positions) {
        violations.push(`${ctx.openPositions} positions already open — max ${rules.max_open_positions}`);
    }

    // --- Max trades per day (acceptance-time) ---
    if (ctx.executedToday !== undefined && ctx.executedToday >= rules.max_daily_trades) {
        violations.push(`${ctx.executedToday} trades already executed today — max ${rules.max_daily_trades}`);
    }

    return {
        ok: violations.length === 0, violations, notes, riskReward, positionValue,
        takePct: take?.takePct ?? null,
        takePctSource: take?.takePctSource ?? null,
    };
}

// ---------------------------------------------------------------------------
// Acceptance-context gate (WP6, REMEDIATION-2026-08-20)
// ---------------------------------------------------------------------------

/**
 * Pure: at ACCEPT the market context is REQUIRED — a proposal created
 * during an ATR outage used to sail through acceptance with the
 * noise-stop, target-reachability, extension and chase checks silently
 * skipped (audit crit. 10). A missing piece refuses with everything
 * that's missing named at once; the refusal is transient by design —
 * gates re-run on the next accept. (Creation stays best-effort: creation
 * is advisory, acceptance is the contract.)
 */
export function assertAcceptContext(input: {
    symbol: string;
    dailyAtr: number | null;
    ema10: number | null;
    lastPrice: number | null;
}): void {
    const missing: string[] = [];
    if (input.dailyAtr === null || !(input.dailyAtr > 0)) missing.push('daily ATR (noise-stop, target-reachability, extension checks)');
    if (input.ema10 === null || !(input.ema10 > 0)) missing.push('EMA10 (extension check)');
    if (input.lastPrice === null || !(input.lastPrice > 0)) missing.push('live quote (chase/invalidation check)');
    if (missing.length > 0) {
        throw new Error(
            `[context-gate] ${input.symbol}: required market context unavailable — ${missing.join('; ')}. ` +
            `Accept refused FAIL-CLOSED: these checks must run before real orders. ` +
            `Transient — retry the accept when data is back.`,
        );
    }
}

// ---------------------------------------------------------------------------
// Microstructure gate (WP7, REMEDIATION-2026-08-20)
// ---------------------------------------------------------------------------

/**
 * Pure: can the market absorb this order? Before WP7 there was NO
 * deterministic spread, ADV, or borrow check anywhere — min_avg_volume
 * lived only in the advisory risk_manager tool, fed by the model's own
 * self-reported number (2026-08-06 "soft limits", the last sibling to
 * close). Spread and ADV are REQUIRED (fail-closed); shortability is
 * required for SHORTS only; the halt flag is best-effort v1 — a known
 * halt refuses, an unknown one is a note.
 */
export function checkMicrostructure(
    input: {
        symbol: string;
        direction: 'long' | 'short';
        quantity: number;
        bid: number | null;
        ask: number | null;
        avgDailyVolume20d: number | null;
        shortable: boolean | null;
        halted: boolean | null;
    },
    rules: RiskRules,
    /** REQ-RISK-008 (live-loop WP1): a pre-open accept of a DAY entry is
     *  quoted on the pre-market book, which does not price the fill that
     *  happens at the open. `preOpenDay` makes the spread check two-tier:
     *  over the cap but under cap × `hardMult` DEFERS (note + flag, the
     *  09:31 ET re-check decides); beyond the hard multiple refuses as a
     *  liquidity red flag. Regular-session accepts are unchanged. */
    opts: { preOpenDay?: boolean; hardMult?: number } = {},
): { violations: string[]; notes: string[]; spreadDeferred: boolean } {
    const violations: string[] = [];
    const notes: string[] = [];
    let spreadDeferred = false;

    if (input.bid === null || input.ask === null || !(input.bid > 0) || !(input.ask >= input.bid)) {
        violations.push(
            `bid/ask unavailable for ${input.symbol} — the spread cannot be verified (fail-closed; max_spread_pct ${rules.max_spread_pct}%)`,
        );
    } else {
        const mid = (input.bid + input.ask) / 2;
        const spreadPct = ((input.ask - input.bid) / mid) * 100;
        if (spreadPct > rules.max_spread_pct) {
            const hardMult = opts.hardMult ?? 3;
            const hardCap = rules.max_spread_pct * hardMult;
            if (opts.preOpenDay && spreadPct <= hardCap) {
                spreadDeferred = true;
                notes.push(
                    `spread-deferred: pre-market spread ${spreadPct.toFixed(2)}% is over max_spread_pct ${rules.max_spread_pct}% but ` +
                    `under the ${hardMult}x hard multiple (${hardCap.toFixed(2)}%) — the regular-session spread is re-checked at 09:31 ET; ` +
                    `an unfilled entry is cancelled if it still exceeds the cap`,
                );
            } else {
                violations.push(
                    `spread ${spreadPct.toFixed(2)}% of mid exceeds max_spread_pct ${rules.max_spread_pct}%` +
                    (opts.preOpenDay ? ` and the ${hardMult}x pre-market hard multiple (${hardCap.toFixed(2)}%) — a liquidity red flag, not a session artifact` : '') +
                    ` — the crossing cost is a tax the R/R math never priced`,
                );
            }
        }
    }

    if (input.avgDailyVolume20d === null || !(input.avgDailyVolume20d > 0)) {
        violations.push(
            `20-day average volume unavailable for ${input.symbol} — liquidity cannot be verified (fail-closed)`,
        );
    } else {
        if (input.avgDailyVolume20d < rules.min_avg_volume) {
            violations.push(
                `20-day ADV ${Math.round(input.avgDailyVolume20d).toLocaleString()} shares is under min_avg_volume ` +
                `${rules.min_avg_volume.toLocaleString()} — too thin to exit through a bad tape`,
            );
        }
        const advPct = (input.quantity / input.avgDailyVolume20d) * 100;
        if (advPct > rules.max_adv_pct) {
            violations.push(
                `order is ${advPct.toFixed(2)}% of the 20-day ADV (max_adv_pct ${rules.max_adv_pct}%) — ` +
                `size that moves the market fills at its own worst price`,
            );
        }
    }

    if (input.direction === 'short') {
        if (input.shortable === false) {
            violations.push(`${input.symbol} is not shortable — no borrow available`);
        } else if (input.shortable === null) {
            violations.push(
                `borrow status for ${input.symbol} could not be confirmed — a short with unconfirmed borrow is refused (fail-closed)`,
            );
        }
    }

    if (input.halted === true) {
        violations.push(`${input.symbol} is HALTED — no order survives contact with a reopening print`);
    } else if (input.halted === null) {
        notes.push(`halt state unverified for ${input.symbol} (best-effort tick) — proceeding`);
    }

    return { violations, notes, spreadDeferred };
}

// ---------------------------------------------------------------------------
// Price-run (chase/invalidation) check — used at ACCEPTANCE time with a
// live quote. Pure so it is unit-testable.
// ---------------------------------------------------------------------------

/** Fraction of the entry→target distance the price may consume before an
 *  accept counts as chasing. */
export const CHASE_FRACTION = 0.25;

/** Confirmation margin, as a fraction of the stop distance: an entry must
 *  sit at least max(0.1%, this × stop distance) away from the live price —
 *  resting below it (pullback) or triggering beyond it (continuation).
 *  Shared by the creation-time buy-now check and the chase-continuation
 *  trigger (formerly CONTINUATION_CONFIRM_FRACTION there): "beyond noise"
 *  is calibrated by the proposal's own stop, per-symbol for free. A flat
 *  4-cent margin turned "don't chase at X" into "chase at X + 4 cents" and
 *  paid a full 1R on every false breakout of a gap-fill day. */
export const ENTRY_CONFIRM_FRACTION = 0.25;

export interface PriceRunResult {
    ok: boolean;
    reason?: string;
    /** Why it failed: the setup died (through the stop) vs the price ran
     *  away (chasing) — callers tailor their advice on this. */
    kind?: 'invalidated' | 'chasing';
}

/**
 * Given a live price, decide whether accepting this proposal still makes
 * sense: refuse when the price has already consumed more than
 * CHASE_FRACTION of the edge (chasing), or has traded through the stop
 * (the setup is invalidated).
 */
export function checkPriceRun(
    p: Pick<RiskGateProposal, 'direction' | 'entry' | 'stop' | 'target'>,
    lastPrice: number,
): PriceRunResult {
    const entry = p.entry;
    if (entry == null || !(lastPrice > 0)) return { ok: true };

    if (p.direction === 'long') {
        if (lastPrice <= p.stop) {
            return { ok: false, kind: 'invalidated', reason: `setup invalidated: last ${lastPrice} is at/through the stop ${p.stop}` };
        }
        const chaseLine = entry + CHASE_FRACTION * (p.target - entry);
        if (lastPrice >= chaseLine) {
            return {
                ok: false,
                kind: 'chasing',
                reason: `price has run: last ${lastPrice} vs entry ${entry} — already past ` +
                    `${Math.round(CHASE_FRACTION * 100)}% of the way to target ${p.target} (chasing)`,
            };
        }
    } else {
        if (lastPrice >= p.stop) {
            return { ok: false, kind: 'invalidated', reason: `setup invalidated: last ${lastPrice} is at/through the stop ${p.stop}` };
        }
        const chaseLine = entry - CHASE_FRACTION * (entry - p.target);
        if (lastPrice <= chaseLine) {
            return {
                ok: false,
                kind: 'chasing',
                reason: `price has run: last ${lastPrice} vs entry ${entry} — already past ` +
                    `${Math.round(CHASE_FRACTION * 100)}% of the way to target ${p.target} (chasing)`,
            };
        }
    }
    return { ok: true };
}

/** Throw with all violations joined unless the proposal passes the gate.
 *  Returns the passing result so callers can persist derived values
 *  (take_pct / take_pct_source — WP-EXIT). */
export function assertProposalRisk(
    p: RiskGateProposal,
    ctx: RiskGateContext = {},
    rules: RiskRules = getRiskRules(),
): RiskGateResult {
    const result = checkProposalRisk(p, ctx, rules);
    for (const note of result.notes) {
        logger.info(`[risk-gate] ${note}`);
    }
    if (!result.ok) {
        throw new Error(`[risk-gate] REFUSED ${p.symbol}: ${result.violations.join('; ')}`);
    }
    return result;
}
