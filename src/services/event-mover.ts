/**
 * Event movers — deterministic recognition of outsized day moves in the
 * candidate stream (MRNA post-mortem, 2026-08-19: +110% pre-market by
 * 07:50, yet compositeRank buried it mid-pack below two index ETFs — the
 * composite had NO term for the size of the move itself, and the TA
 * factors actively punish verticals: mean-reversion reads "overbought",
 * trend reads a stale regime).
 *
 * Two consumers, both transparent and knob-light:
 *   - significanceTerm (REQ-SCAN-004, live-loop WP1 — replaces the
 *     raw-percent eventMoverBoost): a bounded compositeRank additive in
 *     ATR MULTIPLES. Percent-ranked lists are cap-inverse — a 3x sector
 *     ETF moves ~3x its sector by construction and crowds every underlying
 *     off the list (2026-09-04: SOXL/SOXS seen 109x, six chipmakers 40x,
 *     none triggering on a +4-6% chip day). Normalising the move by the
 *     symbol's own daily ATR% ranks a +4% MU at 2.5 ATRs above a +12% SOXL
 *     at 1.2 ATRs: same information, honest weight. Constants live in ONE
 *     block below and are a fingerprint surface.
 *   - moverAlertEligible: the deterministic pre-market alert filter — one
 *     WhatsApp line per symbol per day, no LLM, no gates touched.
 *
 * dayMovePct is SIGNED TOWARD THE CANDIDATE'S DIRECTION (entry-context
 * convention): a long candidate up 40% and a short candidate down 40%
 * both carry +40. Misaligned moves are negative and never boost or alert.
 */

/** REQ-SCAN-004 constants — the significance term's whole configuration.
 *  minAtr: below one daily ATR a move is noise, not information;
 *  pointsPerAtr: 8 rank points per ATR multiple (2 ATRs ≈ the old +16 for
 *  a 16% raw move — same scale, different denominator);
 *  cap: 25, matching the retired boost so compositeRank keeps its range. */
export const SIGNIFICANCE = { minAtr: 1.0, pointsPerAtr: 8, cap: 25 } as const;

/**
 * Bounded compositeRank additive for an ALIGNED day move measured in the
 * symbol's daily ATR multiples. Zero for misaligned/unmeasured moves and
 * for an unusable ATR (null or non-positive — the term never guesses).
 */
export function significanceTerm(
    dayMovePct: number | null,
    dailyAtrPct: number | null,
    c: { minAtr: number; pointsPerAtr: number; cap: number } = SIGNIFICANCE,
): number {
    if (dayMovePct == null || !(dayMovePct > 0)) return 0;
    if (dailyAtrPct == null || !(dailyAtrPct > 0)) return 0;
    const sig = dayMovePct / dailyAtrPct;
    if (sig < c.minAtr) return 0;
    return Math.min(c.cap, Math.round(c.pointsPerAtr * sig));
}

/**
 * REQ-SCAN-005: promoting a candidate the extension gate will refuse only
 * burns an LLM evaluation, so the term is suppressed once the implied
 * extension (day move over ATR%) exceeds max_extension_atr — EXCEPT for a
 * reactor (fresh reporter) during the first 60 minutes of the regular
 * session: a post-print reaction is its own catalyst in hour one (QFIN
 * 2026-08-26: the trigger fired 3h late because the reaction was muted).
 * Pre-market (negative minutes) and unknown clocks get no exemption.
 */
export function significanceSuppressed(input: {
    impliedExtension: number | null;
    maxExtensionAtr: number;
    isReactor: boolean;
    minutesSinceOpen: number | null;
}): boolean {
    if (input.impliedExtension == null || !Number.isFinite(input.impliedExtension)) return false;
    const hourOne = input.minutesSinceOpen != null && input.minutesSinceOpen >= 0 && input.minutesSinceOpen < 60;
    if (input.isReactor && hourOne) return false;
    return input.impliedExtension > input.maxExtensionAtr;
}

export function moverAlertMinPct(): number {
    const n = Number(process.env.OPP_MOVER_ALERT_PCT);
    return Number.isFinite(n) && n > 0 ? n : 15;
}

export function moverAlertMinRvol(): number {
    const n = Number(process.env.OPP_MOVER_ALERT_RVOL);
    return Number.isFinite(n) && n >= 0 ? n : 2;
}

/** Scan-source tag for sentinel-admitted candidates — the watchlist lane
 *  (COIN +10% / MSTR +12% on 2026-08-19 never cracked a 25-row scan on a
 *  biotech-explosion day; watchlist membership granted zero admission). */
export const SENTINEL_SOURCE = 'WATCHLIST_SENTINEL';

export function sentinelMinPct(): number {
    const n = Number(process.env.OPP_SENTINEL_MOVE_PCT);
    return Number.isFinite(n) && n > 0 ? n : 5;
}

/**
 * Sentinel admission decision: RAW signed day move (not direction-signed —
 * the direction is the OUTPUT). Watchlist names are liquid mega/large caps,
 * so ±5% is already a declared-name event; null = no data, no admission.
 */
export function sentinelDirection(rawMovePct: number | null, minPct: number = sentinelMinPct()): 'long' | 'short' | null {
    if (rawMovePct == null || Math.abs(rawMovePct) < minPct) return null;
    return rawMovePct > 0 ? 'long' : 'short';
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
