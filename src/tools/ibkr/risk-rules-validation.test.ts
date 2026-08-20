import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { crossFieldIssues, DEFAULT_RULES, parseFlatYaml, validateRuleSet } from './risk-rules.js';

// WP0.1 (REMEDIATION-2026-08-20): the YAML is a risk-control surface — a
// typo must refuse to load, never silently fall back to defaults or run a
// string through a numeric cap (NaN poisoning disables every comparison).

const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../config');

describe('validateRuleSet (schema layer)', () => {
    test('valid keys of the right kind pass', () => {
        const v = validateRuleSet({ max_position_pct: 5, mandatory_stop_loss: true }, 'test.yaml');
        expect(v.errors).toEqual([]);
    });

    test('unknown key is an error (typos must not silently no-op)', () => {
        const v = validateRuleSet({ max_postion_pct: 5 }, 'test.yaml');
        expect(v.errors.some((e) => e.includes('max_postion_pct'))).toBe(true);
    });

    test('string where a number belongs is an error (NaN poisoning)', () => {
        // parseFlatYaml keeps non-numeric strings as strings; 'NaN' among them
        const v = validateRuleSet({ max_position_pct: 'lots', max_daily_loss_pct: 'NaN' }, 'test.yaml');
        expect(v.errors.length).toBe(2);
    });

    test("truthy string is not a boolean ('yes' must not enable a class)", () => {
        const v = validateRuleSet({ earnings_bet_enabled: 'yes' }, 'test.yaml');
        expect(v.errors.some((e) => e.includes('earnings_bet_enabled'))).toBe(true);
    });

    test('non-finite and out-of-range numbers are errors', () => {
        expect(validateRuleSet({ max_position_pct: Infinity }, 't').errors.length).toBe(1);
        expect(validateRuleSet({ max_position_pct: -5 }, 't').errors.length).toBe(1);
        expect(validateRuleSet({ max_daily_loss_pct: 0 }, 't').errors.length).toBe(1); // 0 would disable the kill-switch
        expect(validateRuleSet({ sizing_half_mult: 1.5 }, 't').errors.length).toBe(1);
    });

    test('count keys must be integers', () => {
        expect(validateRuleSet({ max_open_positions: 2.5 }, 't').errors.length).toBe(1);
        expect(validateRuleSet({ max_open_positions: 3 }, 't').errors).toEqual([]);
    });
});

describe('crossFieldIssues (merged-rules layer)', () => {
    test('inverted sizing scores are an error', () => {
        const bad = { ...DEFAULT_RULES, sizing_half_score: 90, sizing_full_score: 80 };
        expect(crossFieldIssues(bad).errors.length).toBeGreaterThan(0);
    });

    test('trail pullback >= arm is an error (worst exit would be <= 0R)', () => {
        const bad = { ...DEFAULT_RULES, profit_trail_pullback_atr_mult: 3, profit_trail_arm_atr_mult: 2.5 };
        expect(crossFieldIssues(bad).errors.length).toBeGreaterThan(0);
    });

    test('planned book worst-case beyond the daily halt is a WARNING (known true today)', () => {
        // 10 slots x 0.25% = 2.5% > 2% halt — the current paper profile.
        const v = crossFieldIssues(DEFAULT_RULES);
        expect(v.errors).toEqual([]);
        expect(v.warnings.some((w) => w.includes('worst-case'))).toBe(true);
    });
});

describe('repo config files (drift guard)', () => {
    test('risk-rules.yaml parses and validates clean', () => {
        const parsed = parseFlatYaml(resolve(CONFIG_DIR, 'risk-rules.yaml'));
        expect(validateRuleSet(parsed, 'risk-rules.yaml').errors).toEqual([]);
    });

    test('risk-rules.live.yaml parses and validates clean', () => {
        const parsed = parseFlatYaml(resolve(CONFIG_DIR, 'risk-rules.live.yaml'));
        expect(validateRuleSet(parsed, 'risk-rules.live.yaml').errors).toEqual([]);
    });
});
