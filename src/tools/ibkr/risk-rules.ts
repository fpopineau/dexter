/**
 * Risk rules — loading and types for src/config/risk-rules.yaml.
 *
 * Extracted from risk-manager.ts so that deterministic services (the
 * proposal risk gate, the daily-loss guard) can read the rules without
 * pulling in the LangChain tool machinery.
 *
 * PROFILES: percentages tuned for the $1M paper account produce unusable
 * absolute numbers on a small real account (5% position = ~€185; 0.25%
 * risk = ~€9 — inside commission noise). When the connection verifies a
 * LIVE account, risk-rules.live.yaml overrides take effect on top of the
 * base file. The default profile is 'paper' — fail-safe: if profile
 * detection never runs, live trading sees the tiny paper percentages and
 * the sizer refuses everything rather than oversizing.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Trade classes — every proposal belongs to exactly one:
 *
 *   'intraday'     hours to a few nights; stop-distance sizing against
 *                  max_risk_per_trade_pct (the default class).
 *   'swing'        pattern trades (pullback, flat base, cup-and-handle);
 *                  GTC brackets held up to ~2 weeks; stop-distance sizing
 *                  against swing_risk_pct; capped at max_swing_positions.
 *   'earnings-bet' a deliberate hold THROUGH an earnings print. A stop
 *                  cannot protect through a gap, so sizing assumes the
 *                  position gaps to its worst historical post-print move
 *                  (floored at earnings_bet_gap_floor_pct) and that worst
 *                  case may not exceed earnings_bet_risk_pct of the
 *                  account. One at a time; disabled entirely unless
 *                  earnings_bet_enabled (paper-only until proven).
 */
export type TradeClass = 'intraday' | 'swing' | 'earnings-bet';

export const TRADE_CLASSES: readonly TradeClass[] = ['intraday', 'swing', 'earnings-bet'];

export interface RiskRules {
    max_position_pct: number;
    max_open_positions: number;
    max_daily_loss_pct: number;
    max_daily_trades: number;
    max_sector_exposure_pct: number;
    min_risk_reward: number;
    mandatory_stop_loss: boolean;
    max_overnight_exposure_pct: number;
    max_overnight_position_pct: number;
    min_price: number;
    min_avg_volume: number;
    stop_atr_multiplier: number;
    max_risk_per_trade_pct: number;
    min_stop_atr_fraction: number;
    max_extension_atr: number;
    /** Reachability cap: refuse intraday-class targets further than this ×
     *  daily ATR from entry. The mirror of min_stop_atr_fraction — that one
     *  stops the stop from sitting inside noise, this one stops the target
     *  from sitting where price does not go in a fraction of one session
     *  (82-trade audit 2026-08-18: ratio-manufactured targets at 2-3× ATR
     *  were hit 10% of the time vs the 33% breakeven at 2:1). Swing and
     *  earnings-bet classes are exempt; 0 disables. */
    max_target_atr: number;
    /** Fallback trail thresholds (absolute %), used only when the symbol's
     *  daily ATR is unavailable — with ATR known, the *_atr_mult keys below
     *  define the geometry. */
    profit_trail_arm_pct: number;
    profit_trail_pullback_pct: number;
    /** ATR-aware trail: arm once unrealized gain ≥ this × daily ATR (as %
     *  of basis). 2.5×ATR ≈ 1.67R against the standard 1.5×ATR stop — the
     *  trade has paid for itself before the target leg is released. */
    profit_trail_arm_atr_mult: number;
    /** Trail distance = this × daily ATR. With arm at 2.5, the worst exit
     *  after arming is (2.5 − 0.75)×ATR = 1.75×ATR ≈ 1.17R — arming can
     *  never turn a winner into a sub-1R exit, at ANY ATR regime (the old
     *  absolute 5%/1.5% pair was inert below ~1.7% ATR and exited high-ATR
     *  runners at ~0.5-0.8R after cancelling their 2R target). */
    profit_trail_pullback_atr_mult: number;
    /** Confidence-weighted sizing: score at/above which a proposal gets the
     *  FULL per-trade risk budget. */
    sizing_full_score: number;
    /** Score at/above which a proposal gets sizing_half_mult × budget. */
    sizing_half_score: number;
    sizing_half_mult: number;
    /** Multiplier for low-score and unscored proposals. */
    sizing_low_mult: number;
    /** Refuse trades whose confidence-weighted risk budget falls below this
     *  (USD). Guards small accounts against trades where commissions and
     *  spread eat the entire edge. 0 disables. */
    min_risk_budget_usd: number;
    /** Runner mode: when the profit trail ARMS (gain ≥ arm_pct), cancel the
     *  bracket's fixed target leg and let the trail manage the exit — hard
     *  targets cap exactly the winners that run (PLTR 2026-08-04: target
     *  banked +5.6% of a +29% move). The stop always stays. */
    profit_trail_replaces_target: boolean;
    /** Allow decimal share quantities (IBKR fractional trading, 0.0001
     *  resolution). Requires the Fractional Shares permission on the IBKR
     *  account — without it the broker rejects the orders. Essential on a
     *  small account where one share of most mega-caps exceeds the
     *  position cap. Brackets stay atomic: the sizer computes an explicit
     *  decimal quantity and all three legs carry it. */
    fractional_shares: boolean;
    // --- Trade classes (see TradeClass) ---
    /** Per-trade risk budget for the 'swing' class (% of net liquidation).
     *  Swings are fewer and wider-stopped than intraday trades. */
    swing_risk_pct: number;
    /** Max concurrent swing-class positions (executed + working). */
    max_swing_positions: number;
    /** Master switch for the 'earnings-bet' class. false = the gate refuses
     *  every earnings-bet proposal (used to keep the class paper-only until
     *  it has a track record). */
    earnings_bet_enabled: boolean;
    /** Max concurrent earnings-bet positions (executed + working). */
    max_earnings_bets: number;
    /** Worst-case risk budget for the 'earnings-bet' class (% of net
     *  liquidation). The worst case is a gap to the assumed adverse
     *  post-print move — not the stop distance. */
    earnings_bet_risk_pct: number;
    /** Minimum assumed adverse gap (%) for earnings-bet sizing. The sizer
     *  uses max(symbol's worst historical post-print move, this floor). */
    earnings_bet_gap_floor_pct: number;
}

export const DEFAULT_RULES: RiskRules = {
    max_position_pct: 5,
    max_open_positions: 10,
    max_daily_loss_pct: 2,
    max_daily_trades: 20,
    max_sector_exposure_pct: 20,
    min_risk_reward: 2.0,
    mandatory_stop_loss: true,
    max_overnight_exposure_pct: 30,
    max_overnight_position_pct: 3,
    min_price: 5.0,
    min_avg_volume: 500_000,
    stop_atr_multiplier: 1.5,
    max_risk_per_trade_pct: 0.25,
    min_stop_atr_fraction: 0.4,
    max_extension_atr: 3,
    max_target_atr: 1.5,
    profit_trail_arm_pct: 5,
    // 1.5 matches risk-rules.yaml — this fallback diverging at 1 meant a
    // YAML load failure silently tightened the trail by 33% (audit 2026-08-11).
    profit_trail_pullback_pct: 1.5,
    profit_trail_arm_atr_mult: 2.5,
    profit_trail_pullback_atr_mult: 0.75,
    sizing_full_score: 80,
    sizing_half_score: 60,
    sizing_half_mult: 0.6,
    sizing_low_mult: 0.35,
    min_risk_budget_usd: 0,
    profit_trail_replaces_target: true,
    fractional_shares: false,
    swing_risk_pct: 0.5,
    max_swing_positions: 3,
    earnings_bet_enabled: false,
    max_earnings_bets: 1,
    earnings_bet_risk_pct: 0.25,
    earnings_bet_gap_floor_pct: 20,
};

export type AccountProfile = 'paper' | 'live';

let activeProfile: AccountProfile = 'paper';
const cachedByProfile = new Map<AccountProfile, RiskRules>();

function parseFlatYaml(path: string): Record<string, unknown> {
    // Simple YAML parser — the files have only flat key: value pairs
    const raw = readFileSync(path, 'utf-8');
    const parsed: Record<string, unknown> = {};
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [key, ...rest] = trimmed.split(':');
        const valueStr = rest.join(':').split('#')[0].trim(); // strip inline comments
        if (!key || valueStr === '') continue;
        const k = key.trim();
        if (valueStr === 'true') parsed[k] = true;
        else if (valueStr === 'false') parsed[k] = false;
        else {
            const num = Number(valueStr);
            parsed[k] = isNaN(num) ? valueStr : num;
        }
    }
    return parsed;
}

function loadRules(profile: AccountProfile): RiskRules {
    const hit = cachedByProfile.get(profile);
    if (hit) return hit;
    let rules: RiskRules;
    try {
        // import.meta.dirname is undefined under jest's ESM VM — derive from
        // import.meta.url, which both bun and jest support. Getting this
        // wrong is silent: everything falls back to DEFAULT_RULES and the
        // live overrides never load.
        const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../config');
        const base = parseFlatYaml(resolve(dir, 'risk-rules.yaml'));
        let overrides: Record<string, unknown> = {};
        if (profile === 'live') {
            try {
                overrides = parseFlatYaml(resolve(dir, 'risk-rules.live.yaml'));
            } catch { /* no live override file → live runs on base rules */ }
        }
        rules = { ...DEFAULT_RULES, ...base, ...overrides } as RiskRules;
    } catch {
        rules = DEFAULT_RULES;
    }
    cachedByProfile.set(profile, rules);
    return rules;
}

/**
 * Select the active rules profile. Called by the IBKR connection when the
 * managed accounts are verified: all-paper accounts ('D…') → 'paper',
 * anything else → 'live'. Idempotent.
 */
export function setAccountProfile(profile: AccountProfile): void {
    activeProfile = profile;
}

export function getAccountProfile(): AccountProfile {
    return activeProfile;
}

/** Public accessor for the risk rules (active profile). */
export function getRiskRules(): RiskRules {
    return loadRules(activeProfile);
}
