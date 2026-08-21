import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES } from './risk-rules.js';
import { validateTrade } from './risk-manager.js';

function input(overrides: Record<string, unknown> = {}) {
    return {
        ticker: 'AAPL',
        direction: 'long' as const,
        entryPrice: 100,
        stopPrice: 95,
        targetPrice: 110,
        holdOvernight: false,
        ...overrides,
    };
}

describe('risk_manager sizing delegates to the real sizer (the 2× fix)', () => {
    test('full-confidence suggestion matches the executor sizer, not the old doubled formula', () => {
        // Sizer: 0.25% of $100k = $250 budget ÷ $5 stop distance = 50 shares.
        // The pre-2026-08-11 formula (25% of the 2% daily limit = $500)
        // suggested 100 — exactly 2× what the gate would accept.
        const r = validateTrade(input({ score: 85 }), 100_000, DEFAULT_RULES);
        expect(r.suggestedShares).toBe(50);
        expect(r.checks.find((c) => c.rule === 'position_size')?.detail).toContain('same math');
    });

    test('an unscored candidate sizes FLAT by default; banding is opt-in config', () => {
        // Production defaults are FLAT until the frozen sample proves
        // decile monotonicity (VALIDATION-PROTOCOL.md, review 2026-08-21):
        // unscored gets the same $250 budget ÷ $5 = 50 shares…
        const flat = validateTrade(input(), 100_000, DEFAULT_RULES);
        expect(flat.suggestedShares).toBe(50);
        // …and the banding MECHANISM still works when configured:
        // $250 × 0.35 = $87.50 ÷ $5 = 17 shares.
        const banded = validateTrade(input(), 100_000, { ...DEFAULT_RULES, sizing_low_mult: 0.35 });
        expect(banded.suggestedShares).toBe(17);
    });

    test('earnings bets size against the gap, and a disabled class is refused like the gate', () => {
        const disabled = validateTrade(
            input({ tradeClass: 'earnings-bet', worstCaseGapPct: 25 }),
            100_000,
            DEFAULT_RULES, // earnings_bet_enabled: false
        );
        expect(disabled.verdict).toBe('FAIL');
        expect(disabled.checks.find((c) => c.rule === 'position_size')?.detail).toContain('sizer refuses');

        const enabled = validateTrade(
            input({ tradeClass: 'earnings-bet', worstCaseGapPct: 25 }),
            100_000,
            { ...DEFAULT_RULES, earnings_bet_enabled: true },
        );
        // 0.25% × $100k (flat multiplier) = $250 ÷ $25 gap/share = 10 shares.
        expect(enabled.suggestedShares).toBe(10);
    });

    test('the position-value cap still bounds the suggestion (inside the sizer)', () => {
        // Wide budget (1%) on a tight $1 stop: $350 ÷ $1 = 350 shares by
        // risk, but 5% of $100k ÷ $100 = 50 shares by cap — the sizer's own
        // min(byRisk, byCap) applies, no lookalike math in this tool.
        const r = validateTrade(
            input({ stopPrice: 99, targetPrice: 102, score: 40 }),
            100_000,
            { ...DEFAULT_RULES, max_risk_per_trade_pct: 1.0 },
        );
        expect(r.suggestedShares).toBe(50);
    });
});

describe('no placeholder account — unverifiable means SKIPPED, never validated', () => {
    test('null account value skips the account-relative checks visibly', () => {
        const r = validateTrade(input({ holdOvernight: true }), null, DEFAULT_RULES);
        expect(r.suggestedShares).toBeNull();
        expect(r.positionValuePct).toBeNull();
        expect(r.skipped.join(' ')).toContain('SKIPPED');
        expect(r.skipped.join(' ')).toContain('does NOT cover');
        expect(r.checks.some((c) => c.rule === 'position_size')).toBe(false);
        expect(r.checks.some((c) => c.rule === 'max_overnight_position_pct')).toBe(false);
        // The account-independent checks still ran.
        expect(r.checks.some((c) => c.rule === 'min_risk_reward')).toBe(true);
    });

    test('with a real account the skip list is empty and overnight is checked', () => {
        const ok = validateTrade(input({ shares: 10, holdOvernight: true }), 100_000, DEFAULT_RULES);
        expect(ok.skipped).toEqual([]);
        expect(ok.checks.find((c) => c.rule === 'max_overnight_position_pct')?.passed).toBe(true);

        const over = validateTrade(input({ shares: 10, holdOvernight: true }), 20_000, DEFAULT_RULES);
        expect(over.verdict).toBe('FAIL'); // $1,000 = 5% > 3% overnight cap
        expect(over.checks.find((c) => c.rule === 'max_overnight_position_pct')?.passed).toBe(false);
    });

    test('without a stop the allocation number is labeled a CEILING, not a size', () => {
        const r = validateTrade(input({ stopPrice: undefined, targetPrice: undefined }), 100_000,
            { ...DEFAULT_RULES, mandatory_stop_loss: false });
        expect(r.checks.find((c) => c.rule === 'position_size')?.detail).toContain('CEILING');
    });
});
