/**
 * Market regime — deterministic tape classification from ETF proxies.
 *
 * The 2026-08-18 review: the 08:00 brief web-searches futures/yields/VIX
 * and writes prose nobody deterministic consumes, while the losing pattern
 * (chased momentum longs, 12-16% wins) clusters exactly on mornings whose
 * direction was knowable at 08:00. This service derives the same headline
 * ("Nasdaq futures plunge as rising yields drive chip selloff") from four
 * PRE-MARKET ETF prints the account is already entitled to as plain stocks:
 *
 *   QQQ — Nasdaq direction        SPY — broad confirmation
 *   SMH — semis vs the index      TLT — long bonds (down = yields up)
 *
 * Prices are the signal; headlines stay visibility-only (the GDELT rule).
 * Consumers: the trigger threshold tilt (risk-off raises the bar for longs,
 * relieves shorts), the trigger-evaluation prompt's TAPE line, and the
 * breadth pre-arm (semis-led risk-off → evaluate the short vehicle without
 * waiting for scan accumulation).
 *
 * Fail-open: missing quotes → tag 'unknown' → every consumer stands down.
 *
 * Environment (all optional):
 *   REGIME_QQQ_SOLO_PCT      QQQ move that alone flips the tag (default 1.2)
 *   REGIME_QQQ_PCT           QQQ move needing confirmation (default 0.75)
 *   REGIME_TLT_PCT           TLT confirmation move (default 0.4)
 *   REGIME_SPY_PCT           SPY confirmation move (default 0.6)
 *   REGIME_SEMIS_SPREAD_PCT  SMH−QQQ spread for "semis-led" (default 0.5)
 *   REGIME_LONG_PENALTY      trigger-bar increase for longs on risk-off (default 10)
 *   REGIME_SHORT_RELIEF      trigger-bar decrease for shorts on risk-off (default 10)
 */

import { BarSizeSetting } from '@stoqey/ib';
import { fetchBars } from '@/tools/ibkr/signal-scorer.js';
import { fetchLastPrice } from './proposal-executor.js';
import { logger } from '@/utils';

export type RegimeTag = 'risk-off' | 'risk-on' | 'neutral' | 'unknown';

export interface RegimeInputs {
    /** % vs the prior completed close; null = quote or close unavailable. */
    qqqPct: number | null;
    spyPct: number | null;
    smhPct: number | null;
    tltPct: number | null;
}

export interface MarketRegime {
    tag: RegimeTag;
    /** SMH underperforming QQQ by the spread on a risk-off tape — the
     *  chip-selloff shape; routes the breadth pre-arm to the semis vehicle. */
    semisLed: boolean;
    /** TLT confirming (bonds down = yields up) on a risk-off tape. */
    yieldDriven: boolean;
    inputs: RegimeInputs;
    /** One-line summary for prompts and logs. */
    line: string;
}

export interface RegimeThresholds {
    qqqSoloPct: number;
    qqqPct: number;
    tltPct: number;
    spyPct: number;
    semisSpreadPct: number;
}

function envNum(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function regimeThresholds(): RegimeThresholds {
    return {
        qqqSoloPct: envNum('REGIME_QQQ_SOLO_PCT', 1.2),
        qqqPct: envNum('REGIME_QQQ_PCT', 0.75),
        tltPct: envNum('REGIME_TLT_PCT', 0.4),
        spyPct: envNum('REGIME_SPY_PCT', 0.6),
        semisSpreadPct: envNum('REGIME_SEMIS_SPREAD_PCT', 0.5),
    };
}

/** 0 is a valid setting for the tilt knobs (disables that side). */
function envNumOrZero(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function regimeLongPenalty(): number {
    return envNumOrZero('REGIME_LONG_PENALTY', 10);
}

export function regimeShortRelief(): number {
    return envNumOrZero('REGIME_SHORT_RELIEF', 10);
}

const fmt = (x: number | null) => (x === null ? '?' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);

/** Pure classification. QQQ is the anchor: without it the tape is unknown
 *  (never guessed from the others alone). */
export function classifyRegime(inputs: RegimeInputs, t: RegimeThresholds = regimeThresholds()): MarketRegime {
    const { qqqPct: qqq, spyPct: spy, smhPct: smh, tltPct: tlt } = inputs;
    let tag: RegimeTag = 'unknown';
    if (qqq !== null) {
        const confirmedOff = qqq <= -t.qqqPct && ((tlt !== null && tlt <= -t.tltPct) || (spy !== null && spy <= -t.spyPct));
        const confirmedOn = qqq >= t.qqqPct && ((tlt !== null && tlt >= t.tltPct) || (spy !== null && spy >= t.spyPct));
        tag = qqq <= -t.qqqSoloPct || confirmedOff ? 'risk-off'
            : qqq >= t.qqqSoloPct || confirmedOn ? 'risk-on'
            : 'neutral';
    }
    const semisLed = tag === 'risk-off' && smh !== null && qqq !== null && smh - qqq <= -t.semisSpreadPct;
    const yieldDriven = tag === 'risk-off' && tlt !== null && tlt <= -t.tltPct;
    const flavor = [semisLed ? 'semis-led' : null, yieldDriven ? 'yield-driven' : null].filter(Boolean).join(', ');
    const line = tag === 'unknown'
        ? 'TAPE unknown (index quotes unavailable)'
        : `TAPE ${tag}${flavor ? ` (${flavor})` : ''}: QQQ ${fmt(qqq)}, SPY ${fmt(spy)}, SMH ${fmt(smh)}, TLT ${fmt(tlt)}`;
    return { tag, semisLed, yieldDriven, inputs, line };
}

/**
 * Pure: the trigger-threshold adjustment for one candidate. Risk-off only —
 * the defensive tilt has the record behind it (long chases bleed on down
 * tapes); a symmetric short-penalty on risk-on days has no evidence yet.
 */
export function regimeThresholdAdjust(
    tag: RegimeTag,
    direction: 'long' | 'short',
    penalty: number = regimeLongPenalty(),
    relief: number = regimeShortRelief(),
): number {
    if (tag !== 'risk-off') return 0;
    return direction === 'long' ? penalty : -relief;
}

// ---------------------------------------------------------------------------
// Snapshot fetch (cached)
// ---------------------------------------------------------------------------

const PROXIES = { qqq: 'QQQ', spy: 'SPY', smh: 'SMH', tlt: 'TLT' } as const;
const TTL_MS = 5 * 60_000;

const UNKNOWN: MarketRegime = classifyRegime({ qqqPct: null, spyPct: null, smhPct: null, tltPct: null });

let cached: { value: MarketRegime; at: number } | null = null;
let lastLoggedLine = '';

/** Prior completed daily close (today's in-progress bar excluded — the
 *  same discipline as the ATR context: today never references itself). */
async function prevClose(symbol: string): Promise<number | null> {
    try {
        const bars = await Promise.race([
            fetchBars(symbol, BarSizeSetting.DAYS_ONE, '1 W', true),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout after 6s')), 6_000)),
        ]);
        const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const todayEt = `${et.getFullYear()}${String(et.getMonth() + 1).padStart(2, '0')}${String(et.getDate()).padStart(2, '0')}`;
        for (let i = bars.length - 1; i >= 0; i--) {
            const b = bars[i];
            if ((b.time ?? '').slice(0, 8) === todayEt) continue;
            if (typeof b.close === 'number' && b.close > 0) return b.close;
        }
        return null;
    } catch {
        return null;
    }
}

async function pctVsPrevClose(symbol: string): Promise<number | null> {
    const [prev, last] = await Promise.all([prevClose(symbol), fetchLastPrice(symbol)]);
    if (prev === null || last === null || !(prev > 0)) return null;
    return Math.round(((last - prev) / prev) * 1000) / 10;
}

/** Current regime, at most 5 minutes stale. Tests and data failures get
 *  'unknown' — consumers must treat unknown as "no tilt", never as neutral
 *  conviction. */
export async function getMarketRegime(): Promise<MarketRegime> {
    if (process.env.NODE_ENV === 'test') return UNKNOWN;
    if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
    const [qqqPct, spyPct, smhPct, tltPct] = await Promise.all([
        pctVsPrevClose(PROXIES.qqq),
        pctVsPrevClose(PROXIES.spy),
        pctVsPrevClose(PROXIES.smh),
        pctVsPrevClose(PROXIES.tlt),
    ]);
    const regime = classifyRegime({ qqqPct, spyPct, smhPct, tltPct });
    cached = { value: regime, at: Date.now() };
    // Log transitions, not every 5-minute refresh — the tape line should be
    // findable in the day's log exactly when it changed.
    if (regime.line !== lastLoggedLine) {
        lastLoggedLine = regime.line;
        logger.info(`[market-regime] ${regime.line}`);
    }
    return regime;
}
