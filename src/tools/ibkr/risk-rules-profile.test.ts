import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { getAccountProfile, getRiskRules, setAccountProfile } from './risk-rules.js';

// The operator's shell/.env carries DEXTER_RISK_PROFILE=live (shadow-live);
// bun re-injects .env per test file AFTER the global preload, so the leak
// must be cleared HERE — these suites test the account-derived default and
// set the override explicitly where they mean to (review 2026-08-23).
delete process.env.DEXTER_RISK_PROFILE;

beforeEach(() => { delete process.env.DEXTER_RISK_PROFILE; });
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
        // First-tranche revision (2026-08-23, REVIEW-marked): 15% × 4 slots,
        // halved risk budgets, classes fail-closed.
        expect(r.max_position_pct).toBe(15);
        expect(r.max_risk_per_trade_pct).toBe(0.5);
        expect(r.max_daily_loss_pct).toBe(1.5);
        expect(r.max_open_positions).toBe(4);
        expect(r.min_risk_budget_usd).toBe(15);
        expect(r.swing_enabled).toBe(false); // fail-closed until its own shadow record passes
        expect(r.earnings_bet_enabled).toBe(false);
        // inherited from the base file, not overridden
        expect(r.min_risk_reward).toBe(2.0);
        expect(r.min_stop_atr_fraction).toBe(0.4);
        expect(r.exit_style).toBe('target'); // the take policy rides both profiles
    });

    test('switching back to paper restores base rules (per-profile cache)', () => {
        setAccountProfile('live');
        getRiskRules();
        setAccountProfile('paper');
        expect(getRiskRules().max_position_pct).toBe(5);
    });
});

describe('shadow-live override (WP-SHADOW, REQ-SHADOW-001/002)', () => {
    test('resolveProfileOverride: only the paper→live escalation exists', async () => {
        const { resolveProfileOverride } = await import('./risk-rules.js');
        expect(resolveProfileOverride('paper', undefined)).toEqual({ profile: 'paper', shadow: false, ignored: null });
        expect(resolveProfileOverride('paper', 'live')).toEqual({ profile: 'live', shadow: true, ignored: null });
        expect(resolveProfileOverride('paper', 'paper')).toEqual({ profile: 'paper', shadow: false, ignored: null });
        // A live account NEVER de-escalates onto paper rules.
        const refused = resolveProfileOverride('live', 'paper');
        expect(refused.profile).toBe('live');
        expect(refused.shadow).toBe(false);
        expect(refused.ignored).toContain('refused');
        // live+live is a harmless no-op; garbage is reported and ignored.
        expect(resolveProfileOverride('live', 'live')).toEqual({ profile: 'live', shadow: false, ignored: null });
        expect(resolveProfileOverride('paper', 'shadow')!.ignored).toContain('unknown value');
    });

    test('shadow-live serves the live rules with the two class-enable deviations', async () => {
        const prev = process.env.DEXTER_RISK_PROFILE;
        process.env.DEXTER_RISK_PROFILE = 'live';
        try {
            setAccountProfile('paper'); // account truth: paper → escalates
            expect(getAccountProfile()).toBe('live');
            const { isShadowLive } = await import('./risk-rules.js');
            expect(isShadowLive()).toBe(true);
            const r = getRiskRules();
            expect(r.max_risk_per_trade_pct).toBe(0.5); // live first-tranche numbers
            // The deviations: fail-closed classes trade in SHADOW so the
            // ≥30-trade records their enable decisions need can accrue.
            expect(r.earnings_bet_enabled).toBe(true);
            expect(r.swing_enabled).toBe(true);
        } finally {
            if (prev === undefined) delete process.env.DEXTER_RISK_PROFILE;
            else process.env.DEXTER_RISK_PROFILE = prev;
            setAccountProfile('paper');
        }
    });

    test('REQ-LIVE-006: a LIVE account never gets the shadow forcing — the raw live yaml governs the class switches', async () => {
        const prev = process.env.DEXTER_RISK_PROFILE;
        process.env.DEXTER_RISK_PROFILE = 'live';
        try {
            setAccountProfile('live'); // account truth: live → no shadow, whatever the env says
            const { isShadowLive, liveDisabledClasses } = await import('./risk-rules.js');
            expect(isShadowLive()).toBe(false);
            const r = getRiskRules();
            expect(r.swing_enabled).toBe(false);
            expect(r.earnings_bet_enabled).toBe(false);
            expect(liveDisabledClasses()).toEqual(['swing', 'earnings-bet']);
        } finally {
            if (prev === undefined) delete process.env.DEXTER_RISK_PROFILE;
            else process.env.DEXTER_RISK_PROFILE = prev;
            setAccountProfile('paper');
        }
    });

    test('without the env the paper account keeps paper rules and bets stay yaml-governed', async () => {
        setAccountProfile('paper');
        const { isShadowLive } = await import('./risk-rules.js');
        expect(isShadowLive()).toBe(false);
        expect(getRiskRules().max_risk_per_trade_pct).toBe(0.25);
    });
});
