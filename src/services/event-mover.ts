/**
 * Event movers — deterministic recognition of outsized day moves in the
 * candidate stream (MRNA post-mortem, 2026-08-19: +110% pre-market by
 * 07:50, yet compositeRank buried it mid-pack below two index ETFs — the
 * composite had NO term for the size of the move itself, and the TA
 * factors actively punish verticals: mean-reversion reads "overbought",
 * trend reads a stale regime).
 *
 * Two consumers, both transparent and knob-light:
 *   - eventMoverBoost: a bounded compositeRank additive so a multi-sigma
 *     mover cannot be out-ranked by an index ETF drifting 1%. This is a
 *     STRUCTURAL fix, not a weight recalibration — the proper reweighting
 *     stays deferred until the archive holds enough labeled days.
 *   - moverAlertEligible: the deterministic pre-market alert filter — one
 *     WhatsApp line per symbol per day, no LLM, no gates touched.
 *
 * dayMovePct is SIGNED TOWARD THE CANDIDATE'S DIRECTION (entry-context
 * convention): a long candidate up 40% and a short candidate down 40%
 * both carry +40. Misaligned moves are negative and never boost or alert.
 */

export function eventBoostMinPct(): number {
    const n = Number(process.env.OPP_EVENT_BOOST_MIN_PCT);
    return Number.isFinite(n) && n > 0 ? n : 10;
}

export function moverAlertMinPct(): number {
    const n = Number(process.env.OPP_MOVER_ALERT_PCT);
    return Number.isFinite(n) && n > 0 ? n : 15;
}

export function moverAlertMinRvol(): number {
    const n = Number(process.env.OPP_MOVER_ALERT_RVOL);
    return Number.isFinite(n) && n >= 0 ? n : 2;
}

/**
 * Bounded additive for compositeRank: +1 point per % of aligned day move,
 * active from `minPct`, capped at +25. Monotone, explainable in one line,
 * and impossible to confuse with the TA factors it corrects for.
 */
export function eventMoverBoost(dayMovePct: number | null, minPct: number = eventBoostMinPct()): number {
    if (dayMovePct == null || dayMovePct < minPct) return 0;
    return Math.min(25, Math.round(dayMovePct));
}

/**
 * Should this candidate fire the one-per-day deterministic mover alert?
 * Aligned move ≥ minPct, with an RVOL floor when RVOL is known (the
 * scanner's own volume filter is the backstop when it is not). The phase
 * check keeps this a PRE-market channel — after the open, the trigger
 * pipeline is the notification path.
 */
export function moverAlertEligible(input: {
    dayMovePct: number | null;
    rvol: number | null;
    phase: string;
    alreadyAlerted: boolean;
    minPct?: number;
    minRvol?: number;
}): boolean {
    if (input.alreadyAlerted) return false;
    if (input.phase !== 'pre-open') return false;
    if (input.dayMovePct == null || input.dayMovePct < (input.minPct ?? moverAlertMinPct())) return false;
    if (input.rvol != null && input.rvol < (input.minRvol ?? moverAlertMinRvol())) return false;
    return true;
}
