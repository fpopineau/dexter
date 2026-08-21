/**
 * Deterministic scenario suite for the three trade classes.
 *
 * These are the executable spec of the class rules decided 2026-08-06
 * (.claude/clarify-session.md): per-class risk budgets, the swing cap,
 * the single earnings bet, worst-case-gap sizing, and the paper-only
 * lock on the earnings-bet class. Trade-decision *judgment* is measured
 * by the nightly benchmark ledger — this suite pins the machinery.
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES, type RiskRules } from '@/tools/ibkr/risk-rules.js';
import { classRiskPct, computeQuantity, gapRiskPerShare } from './position-sizer.js';
import { checkProposalRisk, type RiskGateProposal } from './proposal-risk-gate.js';

// Paper-profile shape with the earnings-bet class unlocked (risk-rules.yaml).
const PAPER_BETS: RiskRules = { ...DEFAULT_RULES, earnings_bet_enabled: true };

// Live small-account shape (risk-rules.live.yaml): bets locked out.
const LIVE_SMALL: RiskRules = {
    ...DEFAULT_RULES,
    max_position_pct: 20,
    max_open_positions: 3,
    max_risk_per_trade_pct: 1.0,
    swing_risk_pct: 1.5,
    min_risk_budget_usd: 15,
    earnings_bet_enabled: false,
    earnings_bet_risk_pct: 1.0,
};

function proposal(overrides: Partial<RiskGateProposal> = {}): RiskGateProposal {
    return {
        symbol: 'AAPL',
        direction: 'long',
        entryType: 'LMT',
        entry: 100,
        stop: 95,
        target: 110,
        quantity: 10,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Class budgets
// ---------------------------------------------------------------------------

describe('classRiskPct — each class has its own budget', () => {
    test('intraday / swing / earnings-bet map to their configured percentages', () => {
        expect(classRiskPct('intraday', PAPER_BETS)).toBe(0.25);
        expect(classRiskPct('swing', PAPER_BETS)).toBe(0.5);
        expect(classRiskPct('earnings-bet', PAPER_BETS)).toBe(0.25);
        expect(classRiskPct('swing', LIVE_SMALL)).toBe(1.5);
    });
});

// ---------------------------------------------------------------------------
// Sizer scenarios
// ---------------------------------------------------------------------------

describe('sizer — swing budget doubles the intraday size at the same stop', () => {
    test('$1M account, $10 stop distance, full confidence', () => {
        // Entry $50 keeps the cap (5% × 0.995 = $49,750 → 995 shares) clear
        // of the boundary — the test's subject is the RISK budget doubling,
        // and at entry $100 the swing size coincided with the raw cap.
        const base = { entry: 50, stop: 40, score: 85, netLiquidation: 1_000_000 };
        const intraday = computeQuantity({ ...base, tradeClass: 'intraday' }, PAPER_BETS);
        const swing = computeQuantity({ ...base, tradeClass: 'swing' }, PAPER_BETS);
        expect(intraday.quantity).toBe(250); // 0.25% = $2500 / $10
        expect(swing.quantity).toBe(500);    // 0.50% = $5000 / $10
    });

    test('omitting tradeClass sizes as intraday (backward compatible)', () => {
        const r = computeQuantity({ entry: 100, stop: 90, score: 85, netLiquidation: 1_000_000 }, PAPER_BETS);
        expect(r.quantity).toBe(250);
    });
});

describe('sizer — earnings bets size against the gap, not the stop', () => {
    const base = { entry: 100, stop: 95, score: 85, netLiquidation: 1_000_000, tradeClass: 'earnings-bet' as const };

    test('worst historical move above the floor is used as-is', () => {
        // 30% adverse gap on a $100 stock = $30/share; $2500 budget → 83 shares.
        const r = computeQuantity({ ...base, worstCaseGapPct: 30 }, PAPER_BETS);
        expect(r.quantity).toBe(83);
    });

    test('a benign history is floored at earnings_bet_gap_floor_pct', () => {
        // 5% history < 20% floor → assume $20/share → 125 shares.
        const r = computeQuantity({ ...base, worstCaseGapPct: 5 }, PAPER_BETS);
        expect(r.quantity).toBe(125);
    });

    test('unknown history assumes the floor alone', () => {
        const r = computeQuantity({ ...base }, PAPER_BETS);
        expect(r.quantity).toBe(125);
    });

    test('the stop distance is irrelevant to the bet size', () => {
        const tight = computeQuantity({ ...base, stop: 99, worstCaseGapPct: 30 }, PAPER_BETS);
        const wide = computeQuantity({ ...base, stop: 80, worstCaseGapPct: 30 }, PAPER_BETS);
        expect(tight.quantity).toBe(83);
        expect(wide.quantity).toBe(83);
    });

    test('disabled class refuses regardless of geometry', () => {
        const r = computeQuantity({ ...base, worstCaseGapPct: 30 }, LIVE_SMALL);
        expect(r.quantity).toBeNull();
        expect(r.reason).toContain('disabled');
        expect(r.reason).toContain('paper-only');
    });

    test('an unaffordable bet is refused, not shrunk into noise', () => {
        // €3.7K account, $400 stock: the 20% cap allows 1 share, but the
        // floor gap is $80/share vs a $37 budget → zero shares → refusal.
        const enabled: RiskRules = { ...LIVE_SMALL, earnings_bet_enabled: true };
        const r = computeQuantity(
            { entry: 400, stop: 380, score: 85, netLiquidation: 3700, tradeClass: 'earnings-bet' },
            enabled,
        );
        expect(r.quantity).toBeNull();
        expect(r.reason).toContain('worst-case gap');
    });
});

describe('gapRiskPerShare — the floor is a floor, not a default override', () => {
    test('max(history, floor) in dollars per share', () => {
        expect(gapRiskPerShare(100, 30, PAPER_BETS)).toBe(30);
        expect(gapRiskPerShare(100, 5, PAPER_BETS)).toBe(20);
        expect(gapRiskPerShare(100, null, PAPER_BETS)).toBe(20);
        expect(gapRiskPerShare(50, undefined, PAPER_BETS)).toBe(10);
    });
});

// ---------------------------------------------------------------------------
// Gate scenarios
// ---------------------------------------------------------------------------

describe('gate — earnings-bet master switch (paper-only until proven)', () => {
    test('disabled profile refuses the class outright', () => {
        const r = checkProposalRisk(proposal({ tradeClass: 'earnings-bet' }), {}, LIVE_SMALL);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('disabled');
    });

    test('enabled profile lets a coherent bet through', () => {
        const r = checkProposalRisk(proposal({ tradeClass: 'earnings-bet' }), {}, PAPER_BETS);
        expect(r.ok).toBe(true);
    });

    test('the switch does not touch the other classes', () => {
        expect(checkProposalRisk(proposal({ tradeClass: 'swing' }), {}, LIVE_SMALL).ok).toBe(true);
        expect(checkProposalRisk(proposal(), {}, LIVE_SMALL).ok).toBe(true);
    });
});

describe('gate — class caps', () => {
    test('one earnings bet at a time', () => {
        const p = proposal({ tradeClass: 'earnings-bet' });
        expect(checkProposalRisk(p, { openEarningsBets: 0 }, PAPER_BETS).ok).toBe(true);
        const r = checkProposalRisk(p, { openEarningsBets: 1 }, PAPER_BETS);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('max 1');
    });

    test('max 3 concurrent swings', () => {
        const p = proposal({ tradeClass: 'swing' });
        expect(checkProposalRisk(p, { openSwingPositions: 2 }, PAPER_BETS).ok).toBe(true);
        const r = checkProposalRisk(p, { openSwingPositions: 3 }, PAPER_BETS);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('max 3');
    });

    test('caps only bind their own class', () => {
        const r = checkProposalRisk(proposal(), { openSwingPositions: 5, openEarningsBets: 3 }, PAPER_BETS);
        expect(r.ok).toBe(true);
    });

    test('omitted counts skip the cap (context checks are opt-in)', () => {
        expect(checkProposalRisk(proposal({ tradeClass: 'swing' }), {}, PAPER_BETS).ok).toBe(true);
    });
});

describe('gate — per-class risk budgets', () => {
    test('the same trade can pass as swing and fail as intraday', () => {
        // $5 stop × 700 shares = $3500: over the 0.25% intraday budget
        // ($2500 on $1M), inside the 0.5% swing budget ($5000).
        const base = proposal({ entry: 50, stop: 45, target: 60, quantity: 700 });
        const intraday = checkProposalRisk(base, { netLiquidation: 1_000_000 }, PAPER_BETS);
        expect(intraday.ok).toBe(false);
        expect(intraday.violations.join(' ')).toContain('intraday risk budget');
        const swing = checkProposalRisk({ ...base, tradeClass: 'swing' }, { netLiquidation: 1_000_000 }, PAPER_BETS);
        expect(swing.ok).toBe(true);
    });

    test('earnings bets pay the assumed gap, not the stop distance', () => {
        // $1 stop on 300 shares is $300 of "stop risk" — trivially inside the
        // intraday budget. As an earnings bet the same position risks a 20%
        // gap: 300 × $20 = $6000 > $2500 → refused.
        const base = proposal({ entry: 100, stop: 99, target: 102, quantity: 300 });
        expect(checkProposalRisk(base, { netLiquidation: 1_000_000 }, PAPER_BETS).ok).toBe(true);
        const bet = checkProposalRisk(
            { ...base, tradeClass: 'earnings-bet' },
            { netLiquidation: 1_000_000 },
            PAPER_BETS,
        );
        expect(bet.ok).toBe(false);
        expect(bet.violations.join(' ')).toContain('worst-case earnings gap');
        expect(bet.violations.join(' ')).toContain('does not protect through the print');
    });

    test('the reported worst historical move raises the assumed gap', () => {
        // 83 shares × $30 (30% history) = $2490 ≤ $2500 → passes.
        // 90 shares × $30 = $2700 → refused.
        const ctx = { netLiquidation: 1_000_000, worstCaseGapPct: 30 };
        const ok = checkProposalRisk(
            proposal({ tradeClass: 'earnings-bet', quantity: 83 }), ctx, PAPER_BETS);
        expect(ok.ok).toBe(true);
        const over = checkProposalRisk(
            proposal({ tradeClass: 'earnings-bet', quantity: 90 }), ctx, PAPER_BETS);
        expect(over.ok).toBe(false);
        expect(over.violations.join(' ')).toContain('(30%)');
    });
});
