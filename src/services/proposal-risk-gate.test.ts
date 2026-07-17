import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES } from '@/tools/ibkr/risk-rules.js';
import { assertProposalRisk, checkPriceRun, checkProposalRisk, type RiskGateProposal } from './proposal-risk-gate.js';

const RULES = { ...DEFAULT_RULES }; // min_rr 2.0, min_price 5, max_position 5%, max_open 10, max_daily 20

function longProposal(overrides: Partial<RiskGateProposal> = {}): RiskGateProposal {
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

describe('proposal risk gate — static checks', () => {
    test('valid long proposal passes with computed R/R', () => {
        const r = checkProposalRisk(longProposal(), {}, RULES);
        expect(r.ok).toBe(true);
        expect(r.violations).toEqual([]);
        expect(r.riskReward).toBe(2);
        expect(r.positionValue).toBe(1000);
    });

    test('valid short proposal passes', () => {
        const r = checkProposalRisk(
            longProposal({ direction: 'short', entry: 100, stop: 105, target: 90 }),
            {},
            RULES,
        );
        expect(r.ok).toBe(true);
        expect(r.riskReward).toBe(2);
    });

    test('missing entry is refused, even for MKT proposals', () => {
        const r = checkProposalRisk(longProposal({ entryType: 'MKT', entry: null }), {}, RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('entry price is required');
    });

    test('risk/reward below the minimum is refused', () => {
        // risk 5, reward 4 → 0.8:1
        const r = checkProposalRisk(longProposal({ target: 104 }), {}, RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('risk/reward');
    });

    test('entry below min_price is refused', () => {
        const r = checkProposalRisk(longProposal({ entry: 4, stop: 3.8, target: 4.5 }), {}, RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('minimum price');
    });

    test('stop on the wrong side of a long entry is refused', () => {
        const r = checkProposalRisk(longProposal({ stop: 105 }), {}, RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('stop 105 must be below entry');
    });

    test('target on the wrong side of a short entry is refused', () => {
        // short with entry 100: target must be BELOW entry — 102 is not
        const r = checkProposalRisk(
            longProposal({ direction: 'short', stop: 105, target: 102 }),
            {},
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('target 102 must be below entry');
    });

    test('non-integer quantity is refused', () => {
        const r = checkProposalRisk(longProposal({ quantity: 10.5 }), {}, RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('positive integer');
    });
});

describe('proposal risk gate — account context checks', () => {
    test('position above max_position_pct of net liquidation is refused', () => {
        // 100 shares × $100 = $10,000 > 5% of $100,000 ($5,000)
        const r = checkProposalRisk(longProposal({ quantity: 100 }), { netLiquidation: 100_000 }, RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('exceeds');
        expect(r.violations.join(' ')).toContain('max 50 shares');
    });

    test('position at exactly the cap passes', () => {
        const r = checkProposalRisk(longProposal({ quantity: 50 }), { netLiquidation: 100_000 }, RULES);
        expect(r.ok).toBe(true);
    });

    test('max_open_positions reached is refused', () => {
        const r = checkProposalRisk(longProposal(), { openPositions: 10 }, RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('positions already open');
    });

    test('below max_open_positions passes', () => {
        const r = checkProposalRisk(longProposal(), { openPositions: 9 }, RULES);
        expect(r.ok).toBe(true);
    });

    test('max_daily_trades reached is refused', () => {
        const r = checkProposalRisk(longProposal(), { executedToday: 20 }, RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('executed today');
    });

    test('context checks are skipped when context is not provided', () => {
        const r = checkProposalRisk(longProposal({ quantity: 100_000 }), {}, RULES);
        expect(r.ok).toBe(true); // no netLiquidation → no sizing check at creation
    });
});

describe('noise-stop filter (daily ATR)', () => {
    test('stop inside 0.4× daily ATR is refused with the required distance', () => {
        // The live pattern this kills: AMZN entry 256.62, stop 256 — a $0.62
        // stop on a stock whose daily ATR is ~$5 (0.12× ATR).
        const r = checkProposalRisk(
            longProposal({ entry: 256.62, stop: 256, target: 257.87, quantity: 19 }),
            { dailyAtr: 5 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('intraday noise');
        expect(r.violations.join(' ')).toContain('$2.00'); // 0.4 × 5
    });

    test('stop at/beyond the ATR floor passes', () => {
        // fixture stop distance $5 vs floor 0.4 × $10 = $4
        const r = checkProposalRisk(longProposal(), { dailyAtr: 10 }, RULES);
        expect(r.ok).toBe(true);
    });

    test('no ATR available → check skipped (fail-open)', () => {
        const r = checkProposalRisk(longProposal({ entry: 256.62, stop: 256, target: 257.87 }), {}, RULES);
        expect(r.ok).toBe(true);
    });
});

describe('extension guard (chasing filter)', () => {
    test('long entry far above the 10-day EMA is refused', () => {
        // The live pattern this kills: AEHR bought at 101.87 after doubling —
        // ~5× ATR above its 10-day mean; price never saw the target again.
        const r = checkProposalRisk(
            longProposal({ entry: 101.87, stop: 95, target: 116 }),
            { dailyAtr: 8, ema10: 60 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('chasing an extended move');
        expect(r.violations.join(' ')).toContain('5.2× daily ATR above');
    });

    test('short mirror: entry far below the EMA is refused', () => {
        const r = checkProposalRisk(
            longProposal({ direction: 'short', entry: 40, stop: 44, target: 30 }),
            { dailyAtr: 2, ema10: 50 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('below');
    });

    test('modest extension passes; missing context skips the check', () => {
        // 2 ATR above the mean — within the 3× allowance
        const ok = checkProposalRisk(longProposal(), { dailyAtr: 5, ema10: 90 }, RULES);
        expect(ok.ok).toBe(true);
        // ATR present but no EMA → check skipped (fail-open)
        const skipped = checkProposalRisk(longProposal(), { dailyAtr: 5 }, RULES);
        expect(skipped.ok).toBe(true);
    });

    test('a pullback entry BELOW the mean is never "extended" for a long', () => {
        const r = checkProposalRisk(longProposal(), { dailyAtr: 5, ema10: 120 }, RULES);
        expect(r.ok).toBe(true); // entry 100 under EMA 120 → negative extension
    });
});

describe('per-trade risk budget', () => {
    test('a stop-out costing more than max_risk_per_trade_pct is refused with a share cap', () => {
        // The live pattern this kills: RAM 3154 shares × $0.81 stop ≈ $2.5k
        // risked on one trade while another risked $32.
        const r = checkProposalRisk(
            longProposal({ entry: 16.61, stop: 15.8, target: 18.23, quantity: 3154 }),
            { netLiquidation: 100_000 },
            RULES,
        );
        expect(r.ok).toBe(false);
        const msg = r.violations.join(' ');
        expect(msg).toContain('risk budget');
        expect(msg).toContain(`max ${Math.floor(250 / 0.81)} shares`);
    });

    test('risk-budget-sized quantity passes both sizing checks', () => {
        // 308 × $0.81 ≈ $249.5 risk ≤ $250; position $5.1k... exceeds 5%? no: 308 × 16.61 ≈ $5116 > $5000 — use 300
        const r = checkProposalRisk(
            longProposal({ entry: 16.61, stop: 15.8, target: 18.23, quantity: 300 }),
            { netLiquidation: 100_000 },
            RULES,
        );
        expect(r.ok).toBe(true);
    });
});

describe('STP_LMT (momentum) entries', () => {
    test('valid long stop-limit entry passes', () => {
        // risk 2.2 (102.2−100.0), reward 4.6 (106.8−102.2) → R/R 2.09 ≥ 2.0
        const r = checkProposalRisk(
            longProposal({ entryType: 'STP_LMT', entry: 102.2, entryLimit: 102.8, stop: 100.0, target: 106.8 }),
            {},
            RULES,
        );
        expect(r.ok).toBe(true);
    });

    test('STP_LMT without entryLimit is refused', () => {
        const r = checkProposalRisk(longProposal({ entryType: 'STP_LMT', entry: 102.2 }), {}, RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('entryLimit');
    });

    test('long STP_LMT with cap below the trigger is refused', () => {
        const r = checkProposalRisk(
            longProposal({ entryType: 'STP_LMT', entry: 102.2, entryLimit: 101.9, stop: 99.4, target: 106.8 }),
            {},
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('at or above the trigger');
    });
});

describe('checkPriceRun (chase/invalidation gate)', () => {
    const p = { direction: 'long' as const, entry: 101.87, stop: 99.44, target: 106.8 };

    test('price near entry → ok', () => {
        expect(checkPriceRun(p, 102.1).ok).toBe(true);
    });

    test('price past 25% of the way to target → chasing refused', () => {
        // chase line = 101.87 + 0.25 × (106.80 − 101.87) = 103.10
        const r = checkPriceRun(p, 104.0); // the actual AEHR case
        expect(r.ok).toBe(false);
        expect(r.reason).toContain('price has run');
    });

    test('price through the stop → invalidated', () => {
        const r = checkPriceRun(p, 99.1);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain('invalidated');
    });

    test('short direction is mirrored', () => {
        const s = { direction: 'short' as const, entry: 100, stop: 105, target: 90 };
        expect(checkPriceRun(s, 99).ok).toBe(true);
        expect(checkPriceRun(s, 97).ok).toBe(false);  // past 25% toward target
        expect(checkPriceRun(s, 105.5).ok).toBe(false); // through the stop
    });

    test('no entry or bad price → permissive', () => {
        expect(checkPriceRun({ ...p, entry: null }, 104).ok).toBe(true);
        expect(checkPriceRun(p, 0).ok).toBe(true);
    });
});

describe('assertProposalRisk', () => {
    test('throws with all violations joined', () => {
        expect(() =>
            assertProposalRisk(longProposal({ target: 104, entry: 4, stop: 3.9, quantity: 2.5 }), {}, RULES),
        ).toThrow(/risk-gate.*REFUSED/);
    });

    test('does not throw on a valid proposal', () => {
        expect(() => assertProposalRisk(longProposal(), {}, RULES)).not.toThrow();
    });
});
