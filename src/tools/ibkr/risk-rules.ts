/**
 * Risk rules — loading and types for src/config/risk-rules.yaml.
 *
 * Extracted from risk-manager.ts so that deterministic services (the
 * proposal risk gate, the daily-loss guard) can read the rules without
 * pulling in the LangChain tool machinery.
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
};

let cachedRules: RiskRules | null = null;

function loadRules(): RiskRules {
    if (cachedRules) return cachedRules;
    try {
        // Simple YAML parser — the file has only flat key: value pairs
        const raw = readFileSync(
            resolve(import.meta.dirname ?? '.', '../../config/risk-rules.yaml'),
            'utf-8',
        );
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
        cachedRules = { ...DEFAULT_RULES, ...parsed } as RiskRules;
    } catch {
        cachedRules = DEFAULT_RULES;
    }
    return cachedRules;
}

/** Public accessor for the risk rules. */
export function getRiskRules(): RiskRules {
    return loadRules();
}
