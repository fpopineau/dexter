import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES } from '@/tools/ibkr/risk-rules.js';
import { assertProposalRisk, checkProposalRisk, type RiskGateProposal } from './proposal-risk-gate.js';

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
