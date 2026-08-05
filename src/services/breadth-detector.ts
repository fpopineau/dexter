/**
 * Breadth detector — recognizes sector-wide melt-ups from the engine's own
 * scan results, with zero extra API calls.
 *
 * Live failure (Jul 30): nine watchlist mega-caps ripped together (MU +18%,
 * MSFT +15%, AMD +13%, INTC +11%, ...). The single-name trigger pipeline
 * (top-3 per cycle, 10/day cap) exhausted by midday — "trigger cap reached"
 * logged 29× — and AMD/INTC/DELL/TSM/ARM were never even evaluated. On a
 * correlated move the right expression is ONE liquid sector vehicle, not N
 * refused single names.
 *
 * Detection: count watchlist symbols surfaced by GAINER scanners this cycle.
 * At/above the threshold it is a regime day → route to a sector vehicle
 * (semis-dominated → SOXL, otherwise QQQ) and let the engine relieve the
 * single-name trigger cap.
 *
 * Direction-aware: gainer scans imply upside breadth (long the vehicle),
 * loser scans imply a correlated selloff (short the vehicle); the dominant
 * side wins, ties go long.
 *
 * Environment:
 *   OPP_BREADTH_MIN_WATCHED    watchlist movers to declare breadth (default 4)
 *   OPP_BREADTH_MAX_PER_DAY    vehicle evaluations per day (default 2)
 *   OPP_BREADTH_COOLDOWN_MIN   per-vehicle cooldown, minutes (default 120)
 *   OPP_BREADTH_CAP_BONUS      extra single-name triggers on breadth days (default 5)
 *   OPP_BREADTH_VEHICLE_SEMI   semis vehicle (default SOXL)
 *   OPP_BREADTH_VEHICLE_BROAD  broad vehicle (default QQQ)
 */

/** Scan codes that imply "up big today" — presence in these is a directional
 *  fact; MOST_ACTIVE / HOT_BY_VOLUME / TOP_TRADE_RATE are direction-blind. */
const GAINER_SCANS = new Set(['TOP_PERC_GAIN', 'TOP_OPEN_PERC_GAIN', 'HIGH_OPEN_GAP']);

/** Mirror for "down big today" — a correlated selloff is a breadth event
 *  too, expressed by SHORTING the sector vehicle. */
const LOSER_SCANS = new Set(['TOP_PERC_LOSE', 'TOP_OPEN_PERC_LOSE']);

/** Semiconductor complex — routes a semis-dominated breadth day to the
 *  semis vehicle instead of the broad one. Static by design: this is a
 *  routing hint for an LLM evaluation, not a tradable universe. */
const SEMI_SYMBOLS = new Set([
    'NVDA', 'AMD', 'INTC', 'MU', 'TSM', 'ARM', 'ASML', 'SMCI', 'AVGO', 'QCOM',
    'MRVL', 'LRCX', 'AMAT', 'KLAC', 'MPWR', 'ON', 'TXN', 'ADI', 'NXPI', 'STM',
    'GFS', 'COHR', 'WDC', 'STX', 'SNDK', 'TER', 'ENTG', 'MCHP', 'SWKS', 'QRVO',
]);

/** Names watched even without UNIVERSE_EXTRA_SYMBOLS — the liquid mega-caps
 *  whose correlated move IS the market. */
const CORE_WATCHLIST = new Set([
    'AAPL', 'MSFT', 'GOOG', 'GOOGL', 'AMZN', 'META', 'TSLA', 'NFLX', 'DELL',
    'ORCL', 'CRM', 'IBM', 'HPQ', 'HPE', 'ANET', 'PLTR', 'COIN', 'MSTR',
    ...SEMI_SYMBOLS,
]);

export interface BreadthEvent {
    /** Trade direction for the vehicle: 'long' on a correlated melt-up,
     *  'short' on a correlated selloff. */
    direction: 'long' | 'short';
    /** Watchlist symbols surfaced by directional scanners this cycle. */
    movers: string[];
    /** The semiconductor subset of `movers`. */
    semis: string[];
    /** The sector vehicle to evaluate (SMH/SOXL / QQQ per env). */
    vehicle: string;
}

export function breadthMinWatched(): number {
    const n = Number(process.env.OPP_BREADTH_MIN_WATCHED);
    return Number.isFinite(n) && n > 0 ? n : 4;
}

/** Trigger-threshold relief for WATCHLIST names while a breadth day is
 *  active: SNAP ranked top-3 at composite 68 on 2026-08-04 (+14% day) and
 *  the flat 75 threshold never let it trigger. Watchlist membership plus
 *  breadth context justifies a lower bar; quiet days are unaffected. */
export function breadthThresholdRelief(): number {
    const n = Number(process.env.OPP_BREADTH_THRESHOLD_RELIEF);
    return Number.isFinite(n) && n >= 0 ? n : 10;
}

/** The watchlist breadth is measured against: UNIVERSE_EXTRA_SYMBOLS plus
 *  the built-in mega-cap/semis core. */
export function breadthWatchlist(): Set<string> {
    const extra = (process.env.UNIVERSE_EXTRA_SYMBOLS ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    return new Set([...CORE_WATCHLIST, ...extra]);
}

/**
 * Detect a breadth event from one cycle's surfaced scan symbols.
 * Pure: watchlist and threshold are injected (env-derived defaults at the
 * call site). Null = ordinary tape.
 */
export function detectBreadth(
    surfaced: Array<{ symbol: string; sources: string[] }>,
    watchlist: Set<string> = breadthWatchlist(),
    minMovers: number = breadthMinWatched(),
): BreadthEvent | null {
    const watched = surfaced.filter((s) => watchlist.has(s.symbol.toUpperCase()));
    const up = watched
        .filter((s) => s.sources.some((code) => GAINER_SCANS.has(code)))
        .map((s) => s.symbol.toUpperCase());
    const down = watched
        .filter((s) => s.sources.some((code) => LOSER_SCANS.has(code)))
        .map((s) => s.symbol.toUpperCase());

    // Dominant side wins; ties go long (upside breadth has the better
    // follow-through record, and shorting into a mixed tape is the worst
    // of both). Neither side at threshold → ordinary tape.
    const direction: 'long' | 'short' = down.length > up.length ? 'short' : 'long';
    const movers = direction === 'long' ? up : down;
    if (movers.length < minMovers) return null;

    const semis = movers.filter((m) => SEMI_SYMBOLS.has(m));
    // Majority semis → the semis vehicle expresses the move with less dilution.
    const vehicle = semis.length * 2 >= movers.length
        ? (process.env.OPP_BREADTH_VEHICLE_SEMI ?? '').trim().toUpperCase() || 'SOXL'
        : (process.env.OPP_BREADTH_VEHICLE_BROAD ?? '').trim().toUpperCase() || 'QQQ';

    return { direction, movers, semis, vehicle };
}
