import { afterAll, describe, expect, test } from 'bun:test';
import { getAccountProfile, getRiskRules, setAccountProfile } from './risk-rules.js';

afterAll(() => setAccountProfile('paper'));

describe('risk-rules profiles (small live account prep)', () => {
    test('default profile is paper with the base numbers', () => {
        setAccountProfile('paper');
        expect(getAccountProfile()).toBe('paper');
        const r = getRiskRules();
        expect(r.max_position_pct).toBe(5);
        expect(r.max_risk_per_trade_pct).toBe(0.25);
        expect(r.min_risk_budget_usd).toBe(0);
    });

    test('live profile applies risk-rules.live.yaml overrides on top of base', () => {
        setAccountProfile('live');
        const r = getRiskRules();
        expect(r.max_position_pct).toBe(20);
        expect(r.max_risk_per_trade_pct).toBe(1.0);
        expect(r.max_open_positions).toBe(3);
        expect(r.min_risk_budget_usd).toBe(15);
        // inherited from the base file, not overridden
        expect(r.min_risk_reward).toBe(2.0);
        expect(r.min_stop_atr_fraction).toBe(0.4);
    });

    test('switching back to paper restores base rules (per-profile cache)', () => {
        setAccountProfile('live');
        getRiskRules();
        setAccountProfile('paper');
        expect(getRiskRules().max_position_pct).toBe(5);
    });
});
