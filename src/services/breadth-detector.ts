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
 *  fact; MOST_ACTIVE / HOT_BY_VOLUME / TOP_TRADE_RATE are direction-blind.
 *  Exported since 2026-08-19: the event-mover boost and pre-market alert
 *  compute day moves only for directionally-scanned candidates. */
export const GAINER_SCANS = new Set(['TOP_PERC_GAIN', 'TOP_OPEN_PERC_GAIN', 'HIGH_OPEN_GAP']);

/** Mirror for "down big today" — a correlated selloff is a breadth event
 *  too, expressed by SHORTING the sector vehicle. */
export const LOSER_SCANS = new Set(['TOP_PERC_LOSE', 'TOP_OPEN_PERC_LOSE']);

/** Semiconductor complex — routes a semis-dominated breadth day to the
 *  semis vehicle instead of the broad one. Static by design: this is a
 *  routing hint for an LLM evaluation, not a tradable universe. */
const SEMI_SYMBOLS = new Set([
    'NVDA', 'AMD', 'INTC', 'MU', 'TSM', 'ARM', 'ASML', 'SMCI', 'AVGO', 'QCOM',
    'MRVL', 'LRCX', 'AMAT', 'KLAC', 'MPWR', 'ON', 'TXN', 'ADI', 'NXPI', 'STM',
    'GFS', 'COHR', 'WDC', 'STX', 'SNDK', 'TER', 'ENTG', 'MCHP', 'SWKS', 'QRVO',
]);

/** Crypto proxy complex — a correlated move here is a crypto regime event,
 *  expressed via the crypto vehicle (2026-08-19: COIN +10% / MSTR +12% on a
 *  BTC rally, invisible to scans and unroutable by breadth: two names could
 *  never reach the 4-mover bar, and no crypto vehicle existed). */
export const CRYPTO_SYMBOLS = new Set([
    'COIN', 'MSTR', 'HOOD', 'RIOT', 'MARA', 'CLSK', 'BITF', 'HUT', 'CORZ', 'IREN',
]);

/** Names watched even without UNIVERSE_EXTRA_SYMBOLS — the liquid mega-caps
 *  whose correlated move IS the market. */
const CORE_WATCHLIST = new Set([
    'AAPL', 'MSFT', 'GOOG', 'GOOGL', 'AMZN', 'META', 'TSLA', 'NFLX', 'DELL',
    'ORCL', 'CRM', 'IBM', 'HPQ', 'HPE', 'ANET', 'PLTR',
    ...SEMI_SYMBOLS,
    ...CRYPTO_SYMBOLS,
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
    const crypto = movers.filter((m) => CRYPTO_SYMBOLS.has(m));
    // Majority cluster → its vehicle expresses the move with less dilution.
    const vehicle = semis.length * 2 >= movers.length ? semiVehicle()
        : crypto.length * 2 >= movers.length ? cryptoVehicle()
        : broadVehicle();

    return { direction, movers, semis, vehicle };
}

export function semiVehicle(): string {
    return (process.env.OPP_BREADTH_VEHICLE_SEMI ?? '').trim().toUpperCase() || 'SOXL';
}

export function broadVehicle(): string {
    return (process.env.OPP_BREADTH_VEHICLE_BROAD ?? '').trim().toUpperCase() || 'QQQ';
}

export function cryptoVehicle(): string {
    return (process.env.OPP_BREADTH_VEHICLE_CRYPTO ?? '').trim().toUpperCase() || 'IBIT';
}

/**
 * Crypto pre-arm (2026-08-19): a crypto-led tape (IBIT moving hard and
 * DIVERGING from QQQ — its own event, not index beta) is a breadth event
 * the scans cannot assemble: the crypto cluster rarely lands 4 names in
 * one scan window. Direction follows the IBIT sign — a crypto-led rally
 * pre-arms the vehicle LONG, a crypto rout pre-arms it SHORT. Same
 * pre-arm cap/cooldown machinery as the semis short.
 */
export function cryptoBreadthEvent(regime: { cryptoLed: boolean; inputs: { ibitPct: number | null } }): BreadthEvent | null {
    if (!regime.cryptoLed || regime.inputs.ibitPct == null) return null;
    return {
        direction: regime.inputs.ibitPct > 0 ? 'long' : 'short',
        movers: [],
        semis: [],
        vehicle: cryptoVehicle(),
    };
}

/**
 * Regime pre-arm (2026-08-18): a semis-led risk-off tape IS the breadth
 * event — QQQ down with confirmation and SMH underperforming says the chip
 * complex is selling off together — but scan-driven detection needs RTH
 * cycles to accumulate movers, so it wakes ~09:35+ on knowledge the ETF
 * proxies printed at 08:00. Synthesize the short-vehicle evaluation
 * directly from the regime. Movers list is empty by construction (no scan
 * evidence yet — the prompt says so); the caller's cap/cooldown machinery
 * still applies, and this NEVER declares a full breadth day (cap bonus and
 * threshold relief stay scan-earned).
 */
export function regimeBreadthEvent(regime: { tag: string; semisLed: boolean }): BreadthEvent | null {
    if (regime.tag !== 'risk-off' || !regime.semisLed) return null;
    return { direction: 'short', movers: [], semis: [], vehicle: semiVehicle() };
}

/**
 * May a breadth-vehicle evaluation fire now? Pure decision over the two
 * firing kinds (2026-08-18 lesson: one shared cooldown let the 08:12
 * pre-market pre-arm push the scan-CONFIRMED 09:42 evaluation to 10:15 —
 * past the 09:45-09:55 breakdown window that paid):
 *
 *   'scan'    — real movers in the ranks. Respects only the last SCAN
 *               firing: a tape-only pre-arm look must never delay
 *               scan-confirmed evidence.
 *   'pre-arm' — tape regime only. Shorter cooldown, own daily cap, and it
 *               respects BOTH stamps (a fresh scan evaluation makes a
 *               tape-only repeat redundant).
 */
export function breadthFireAllowed(input: {
    kind: 'scan' | 'pre-arm';
    now: number;
    /** Last firing timestamps for this vehicle+direction; 0 = never. */
    lastScanAt: number;
    lastPreArmAt: number;
    scanFiresToday: number;
    preArmsToday: number;
    scanCooldownMs: number;
    preArmCooldownMs: number;
    scanMaxPerDay: number;
    preArmMaxPerDay: number;
}): boolean {
    if (input.kind === 'scan') {
        if (input.scanFiresToday >= input.scanMaxPerDay) return false;
        return input.now - input.lastScanAt >= input.scanCooldownMs;
    }
    if (input.preArmsToday >= input.preArmMaxPerDay) return false;
    return input.now - Math.max(input.lastScanAt, input.lastPreArmAt) >= input.preArmCooldownMs;
}
