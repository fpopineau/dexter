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
 * Long-only by construction: the gainer scan codes imply upside breadth.
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
    /** Watchlist symbols surfaced by gainer scanners this cycle. */
    movers: string[];
    /** The semiconductor subset of `movers`. */
    semis: string[];
    /** The sector vehicle to evaluate (SOXL / QQQ by default). */
    vehicle: string;
}

export function breadthMinWatched(): number {
    const n = Number(process.env.OPP_BREADTH_MIN_WATCHED);
    return Number.isFinite(n) && n > 0 ? n : 4;
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
    const movers = surfaced
        .filter((s) => watchlist.has(s.symbol.toUpperCase()))
        .filter((s) => s.sources.some((code) => GAINER_SCANS.has(code)))
        .map((s) => s.symbol.toUpperCase());
    if (movers.length < minMovers) return null;

    const semis = movers.filter((m) => SEMI_SYMBOLS.has(m));
    // Majority semis → the semis vehicle expresses the move with less dilution.
    const vehicle = semis.length * 2 >= movers.length
        ? (process.env.OPP_BREADTH_VEHICLE_SEMI ?? '').trim().toUpperCase() || 'SOXL'
        : (process.env.OPP_BREADTH_VEHICLE_BROAD ?? '').trim().toUpperCase() || 'QQQ';

    return { movers, semis, vehicle };
}
