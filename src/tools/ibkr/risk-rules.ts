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
import { resolve } from 'path';

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
    profit_trail_arm_pct: number;
    profit_trail_pullback_pct: number;
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
    profit_trail_arm_pct: 5,
    profit_trail_pullback_pct: 1,
    sizing_full_score: 80,
    sizing_half_score: 60,
    sizing_half_mult: 0.6,
    sizing_low_mult: 0.35,
    min_risk_budget_usd: 0,
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
        const dir = resolve(import.meta.dirname ?? '.', '../../config');
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
