/**
 * Simulator fill model (REQ-SIM-002, live-loop WP2) — PESSIMISTIC BY
 * CONSTRUCTION. Every ambiguity resolves against the simulated trade, so a
 * shadow variant can never look better than the real bracket would have:
 *
 *   entry   LMT fills only when a bar trades THROUGH the limit (strict),
 *           at the limit — never at a better open; STP_LMT follows the
 *           replayBracket band logic (benchmark.ts) and fills at the LIMIT
 *           cap, the worst permitted price; MKT fills at the NEXT bar's
 *           open after creation. The creation bar never fills anything.
 *           Past `entryDeadline` (proposal expiry + the sweeper's grace) an
 *           unfilled entry is 'unfilled'.
 *   exit    a stop fills at the stop, or at the bar's OPEN when the bar
 *           opens through it (gap-aware, worse); a target needs a strict
 *           trade-through; stop and target inside one bar → STOP; the fill
 *           bar itself may resolve the exit.
 *   ratchet (exit-ratchet variant, REQ-EXIT-008 geometry) no fixed target:
 *           once the peak reaches +armPct the stop ratchets to
 *           max(lock level, peak − trailAbs); a pullback exit above the
 *           fill is classed 'target', below it 'stop'.
 *   flat    DAY rows still open at `flatAt` (the 15:52 ET triage bar) close
 *           at that bar's close as 'eod-flat' (flat-by-close policy); GTC
 *           rows stay 'open' when bars run out and settle another night.
 *
 * All times are ET-frame ms (outcome-tracker's barTimeFrameMs/etFrameMs
 * convention) so bars and proposal stamps compare directly.
 */

export interface SimBar {
    /** ET-frame ms of the bar's OPEN. */
    t: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

export type SimOutcome = 'target' | 'stop' | 'eod-flat' | 'open' | 'unfilled' | 'unknown';

export interface RatchetSpec {
    /** Arm once the peak reaches +armPct from the fill. */
    armPct: number;
    /** Once armed, the stop never sits below +lockPct from the fill. */
    lockPct: number;
    /** Once armed, the stop trails the peak by this absolute distance. */
    trailAbs: number;
}

export interface SimSpec {
    direction: 'long' | 'short';
    entryType: 'LMT' | 'MKT' | 'STP_LMT';
    /** LMT: the limit; STP_LMT: the trigger; MKT: ignored (may be null). */
    entry: number | null;
    /** STP_LMT: the limit cap (worst permitted fill). */
    entryLimit: number | null;
    stop: number;
    /** Fixed take level; null = runner (ratchet must be set). */
    target: number | null;
    /** ET-frame ms of the proposal; bars at or before it never fill. */
    createdAt: number;
    /** ET-frame ms after which an unfilled entry is dead. */
    entryDeadline: number;
    /** ET-frame ms of the flat-by-close bar (DAY rows); null = GTC carry. */
    flatAt: number | null;
    ratchet?: RatchetSpec;
}

export interface SimResult {
    outcome: SimOutcome;
    fillAt: number | null;
    fillPrice: number | null;
    exitAt: number | null;
    exitPrice: number | null;
    /** Max favorable / adverse excursion after the fill, % of the fill (≥ 0). */
    mfePct: number | null;
    maePct: number | null;
    note?: string;
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

function validBar(b: SimBar): boolean {
    return b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0 && b.high >= b.low;
}

/** Pure: replay one bracket spec over chronological bars. */
export function simulateBracket(barsIn: SimBar[], spec: SimSpec): SimResult {
    const bars = barsIn.filter(validBar).sort((a, b) => a.t - b.t);
    const long = spec.direction === 'long';
    const none: SimResult = { outcome: 'unfilled', fillAt: null, fillPrice: null, exitAt: null, exitPrice: null, mfePct: null, maePct: null };

    let filled = false;
    let fillAt: number | null = null;
    let fillPrice: number | null = null;
    let triggered = false;
    let bestFav = 0;
    let bestAdv = 0;
    let peak: number | null = null; // ratchet: best price since the fill
    let armed = false;

    const finish = (outcome: SimOutcome, exitAt: number | null, exitPrice: number | null, note?: string): SimResult => ({
        outcome,
        fillAt,
        fillPrice,
        exitAt,
        exitPrice,
        mfePct: fillPrice !== null ? round4((bestFav / fillPrice) * 100) : null,
        maePct: fillPrice !== null ? round4((bestAdv / fillPrice) * 100) : null,
        ...(note ? { note } : {}),
    });

    for (const b of bars) {
        if (b.t <= spec.createdAt) continue; // the creation bar never fills

        if (!filled) {
            if (b.t > spec.entryDeadline) return none;
            switch (spec.entryType) {
                case 'MKT':
                    filled = true; fillAt = b.t; fillPrice = b.open;
                    break;
                case 'LMT': {
                    if (spec.entry === null) return { ...none, outcome: 'unknown', note: 'LMT without a limit price' };
                    const through = long ? b.low < spec.entry : b.high > spec.entry;
                    if (!through) continue;
                    filled = true; fillAt = b.t; fillPrice = spec.entry; // never better than the limit
                    break;
                }
                case 'STP_LMT': {
                    if (spec.entry === null) return { ...none, outcome: 'unknown', note: 'STP_LMT without a trigger' };
                    const cap = spec.entryLimit ?? spec.entry;
                    if (!triggered) {
                        triggered = long ? b.high >= spec.entry : b.low <= spec.entry;
                        if (!triggered) continue;
                        const bandAtOpen = long ? b.open <= cap : b.open >= cap;
                        const crossedWithin = long ? b.open < spec.entry : b.open > spec.entry;
                        if (!(crossedWithin || bandAtOpen)) continue; // gapped past the band — wait for a trade back in
                        filled = true; fillAt = b.t; fillPrice = cap;
                    } else {
                        const backIn = long ? b.low <= cap : b.high >= cap;
                        if (!backIn) continue;
                        filled = true; fillAt = b.t; fillPrice = cap;
                    }
                    break;
                }
                default: {
                    const _exhaustive: never = spec.entryType;
                    throw new Error(`unhandled entry type ${String(_exhaustive)}`);
                }
            }
            peak = fillPrice;
            // fall through: the fill bar can resolve the exit
        }

        const fp = fillPrice!;
        bestFav = Math.max(bestFav, long ? b.high - fp : fp - b.low);
        bestAdv = Math.max(bestAdv, long ? fp - b.low : b.high - fp);

        // Effective stop for THIS bar = the ratchet as it stood ENTERING the
        // bar. The peak that lifts the stop prints during the bar, and the
        // same bar's low may precede it — testing the low against a stop
        // raised by that very high would flatter the sim (intrabar order is
        // unknown; the pessimistic read is "the new stop applies from the
        // next bar").
        let stopLevel = spec.stop;
        if (spec.ratchet && armed && peak !== null) {
            const lock = long ? fp * (1 + spec.ratchet.lockPct / 100) : fp * (1 - spec.ratchet.lockPct / 100);
            const trail = long ? peak - spec.ratchet.trailAbs : peak + spec.ratchet.trailAbs;
            stopLevel = long ? Math.max(spec.stop, lock, trail) : Math.min(spec.stop, lock, trail);
        }

        const hitStop = long ? b.low <= stopLevel : b.high >= stopLevel;
        const hitTarget = spec.target !== null && (long ? b.high > spec.target : b.low < spec.target);
        if (hitStop) {
            // Gap-aware: an open through the stop fills at the open (worse).
            const gapped = long ? b.open < stopLevel : b.open > stopLevel;
            const px = gapped ? b.open : stopLevel;
            if (armed && spec.ratchet) {
                const win = long ? px > fp : px < fp;
                return finish(win ? 'target' : 'stop', b.t, round4(px), `ratchet exit at ${round4(px)} (armed)`);
            }
            return finish('stop', b.t, round4(px));
        }
        if (hitTarget) return finish('target', b.t, spec.target);
        if (spec.flatAt !== null && b.t >= spec.flatAt) return finish('eod-flat', b.t, b.close);

        // Ratchet state for the NEXT bar: track the peak, arm at +armPct.
        if (spec.ratchet) {
            peak = long ? Math.max(peak ?? fp, b.high) : Math.min(peak ?? fp, b.low);
            const armLevel = long ? fp * (1 + spec.ratchet.armPct / 100) : fp * (1 - spec.ratchet.armPct / 100);
            if (!armed && (long ? peak >= armLevel : peak <= armLevel)) armed = true;
        }
    }

    if (!filled) return none;
    return finish('open', null, null);
}

export interface CommissionConfig {
    perShareUsd: number;
    minUsd: number;
}

/** IBKR fixed-tier assumption: per side max(min, qty × per-share). */
export function commissionsFor(quantity: number, sides: number, cfg: CommissionConfig): number {
    if (!(quantity > 0) || !(sides > 0)) return 0;
    return Math.round(sides * Math.max(cfg.minUsd, quantity * cfg.perShareUsd) * 100) / 100;
}

/** REQ-SIM-005: net USD over the planned risk (|entry − stop| × qty). */
export function netR(input: { netUsd: number; entry: number; stop: number; quantity: number }): number | null {
    const risk = Math.abs(input.entry - input.stop) * input.quantity;
    if (!(risk > 0)) return null;
    return input.netUsd / risk;
}
