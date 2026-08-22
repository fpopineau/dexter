import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES } from '@/tools/ibkr/risk-rules.js';
import {
    checkMicrostructure,
    assertAcceptContext,
    assertProposalRisk,
    checkPriceRun,
    checkProposalRisk,
    plannedBookWorstCasePct,
    plannedWorstLossUsd,
    type RiskGateProposal,
} from './proposal-risk-gate.js';

// min_rr 2.0, min_price 5, max_position 5%, max_open 10, max_daily 20.
// exit_style 'ratchet': these suites pin the FREE-TARGET geometry checks
// (side coherence, R/R, noise stop, legacy reachability cap, budgets…) —
// the mode that retains them. The take-at-x% policy (exit_style 'target',
// the production default) pins its own suite below ('take-at-x% policy').
const RULES = { ...DEFAULT_RULES, exit_style: 'ratchet' as const };

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

    test('per-symbol aggregate exposure is capped across proposals', () => {
        // The live pattern this kills: BANC 1520 filled + BANC 250 resting —
        // each passed alone; the stack must not.
        // New position $4,000 + $2,000 existing > 5% of $100k ($5,000).
        const r = checkProposalRisk(
            longProposal({ quantity: 40 }),
            { netLiquidation: 100_000, existingSymbolExposure: 2_000 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('already committed to AAPL');
        expect(r.violations.join(' ')).toContain('single-symbol cap');

        // Same proposal with room left passes…
        const ok = checkProposalRisk(
            longProposal({ quantity: 25 }),
            { netLiquidation: 100_000, existingSymbolExposure: 2_000 },
            RULES,
        );
        expect(ok.ok).toBe(true);
        // …and zero existing exposure never triggers the aggregate check.
        const solo = checkProposalRisk(
            longProposal({ quantity: 50 }),
            { netLiquidation: 100_000, existingSymbolExposure: 0 },
            RULES,
        );
        expect(solo.ok).toBe(true);
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

describe('buy-now entry-pricing filter (2026-08-18 entry audit)', () => {
    // Fixture geometry: stop distance 3 → margin = max(0.1% of last, 0.25×3) = 0.75.
    // The record this kills: 72/79 executed entries were LMT at the quote,
    // median 47s from placement to fill, 12% wins.
    test('LMT at the quote is refused with both structural alternatives priced', () => {
        const r = checkProposalRisk(longProposal({ stop: 97, target: 106 }), { lastPrice: 100 }, RULES);
        expect(r.ok).toBe(false);
        const all = r.violations.join(' ');
        expect(all).toContain('buy-now');
        expect(all).toContain('$99.25');  // pullback bound: floor(100 − 0.75)
        expect(all).toContain('$100.75'); // trigger bound: ceil(100 + 0.75)
    });

    test('a marketable LMT (limit above the market for a long) is refused too', () => {
        expect(checkProposalRisk(
            longProposal({ entry: 100, stop: 97, target: 106 }),
            { lastPrice: 99.5 },
            RULES,
        ).ok).toBe(false);
    });

    test('a pullback LMT resting a full margin below the market passes', () => {
        const r = checkProposalRisk(longProposal({ stop: 97, target: 106 }), { lastPrice: 100.75 }, RULES);
        expect(r.ok).toBe(true);
        expect(r.violations).toEqual([]);
    });

    test('STP_LMT trigger inside the margin is a first-uptick fill — refused; at the margin passes', () => {
        const refused = checkProposalRisk(
            longProposal({ entryType: 'STP_LMT', entry: 100.3, entryLimit: 100.6, stop: 97.3, target: 106.3 }),
            { lastPrice: 100 },
            RULES,
        );
        expect(refused.ok).toBe(false);
        expect(refused.violations.join(' ')).toContain('first-uptick');
        // Geometry judged at the CAP since review 2026-08-21: at 101.15 the
        // worst-fill risk is 3.40, so the confirmation margin is 0.85
        // (0.25 × 3.40) and the target must clear 2R from the cap.
        const ok = checkProposalRisk(
            longProposal({ entryType: 'STP_LMT', entry: 100.85, entryLimit: 101.15, stop: 97.75, target: 108.05 }),
            { lastPrice: 100 },
            RULES,
        );
        expect(ok.ok).toBe(true);
    });

    test('short mirrors: the pullback LMT rests ABOVE the market', () => {
        const refused = checkProposalRisk(
            longProposal({ direction: 'short', entry: 100, stop: 103, target: 94 }),
            { lastPrice: 100 },
            RULES,
        );
        expect(refused.ok).toBe(false);
        expect(refused.violations.join(' ')).toContain('buy-now');
        const ok = checkProposalRisk(
            longProposal({ direction: 'short', entry: 100.75, stop: 103.75, target: 94.75 }),
            { lastPrice: 100 },
            RULES,
        );
        expect(ok.ok).toBe(true);
    });

    test('MKT with a live quote is refused for intraday', () => {
        const r = checkProposalRisk(
            longProposal({ entryType: 'MKT', stop: 97, target: 106 }),
            { lastPrice: 100 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('MKT is a buy-now entry');
    });

    test('swing class is exempt; no live quote skips the check (fail-open)', () => {
        expect(checkProposalRisk(
            longProposal({ stop: 97, target: 106, tradeClass: 'swing' }),
            { lastPrice: 100 },
            RULES,
        ).ok).toBe(true);
        expect(checkProposalRisk(longProposal({ stop: 97, target: 106 }), {}, RULES).ok).toBe(true);
    });
});

describe('target reachability cap (fantasy-target filter, 2026-08-18 audit)', () => {
    // The record this kills: 81% of 80 executed trades had planned R:R
    // pinned at ~2:1 with targets a median 6% away — manufactured from the
    // ratio — and only 10% were ever reached (33% is breakeven at 2:1).
    test('an intraday target beyond 1.5× daily ATR is refused, with the multiple named', () => {
        // Fixture geometry: stop dist 3 (0.6× ATR, fine), target 12 away = 2.4× ATR.
        const r = checkProposalRisk(
            longProposal({ stop: 97, target: 112 }),
            { dailyAtr: 5 },
            RULES,
        );
        expect(r.ok).toBe(false);
        const all = r.violations.join(' ');
        expect(all).toContain('2.4× the daily ATR');
        expect(all).toContain('max 1.5×');
        expect(all).toContain('VIABLE GEOMETRY'); // the solved band comes along
    });

    test('short mirror: target 2.4× ATR below entry is refused', () => {
        const r = checkProposalRisk(
            longProposal({ direction: 'short', entry: 100, stop: 103, target: 88 }),
            { dailyAtr: 5 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('2.4× the daily ATR');
    });

    test('a target exactly at the cap passes (0.75× ATR stop, 2:1)', () => {
        const r = checkProposalRisk(
            longProposal({ stop: 96.25, target: 107.5 }),
            { dailyAtr: 5 },
            RULES,
        );
        expect(r.ok).toBe(true);
        expect(r.violations).toEqual([]);
    });

    test('swing and earnings-bet classes are exempt — multi-day/gap-sized targets are legitimate', () => {
        const swing = checkProposalRisk(
            longProposal({ stop: 97, target: 112, tradeClass: 'swing' }),
            { dailyAtr: 5 },
            RULES,
        );
        expect(swing.ok).toBe(true);
        const bet = checkProposalRisk(
            longProposal({ stop: 97, target: 112, tradeClass: 'earnings-bet' }),
            { dailyAtr: 5 },
            { ...RULES, earnings_bet_enabled: true },
        );
        expect(bet.ok).toBe(true);
    });

    test('a post-print repricing day waives the cap with a visible note (extension-guard parity)', () => {
        const r = checkProposalRisk(
            longProposal({ stop: 97, target: 112 }),
            { dailyAtr: 5, recentEarnings: true },
            RULES,
        );
        expect(r.ok).toBe(true);
        expect(r.notes.join(' ')).toContain('target-reachability check waived');
    });

    test('no ATR skips the check; max_target_atr 0 disables it', () => {
        expect(checkProposalRisk(longProposal({ stop: 97, target: 112 }), {}, RULES).ok).toBe(true);
        expect(checkProposalRisk(
            longProposal({ stop: 97, target: 112 }),
            { dailyAtr: 5 },
            { ...RULES, max_target_atr: 0 },
        ).ok).toBe(true);
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
        // 2 ATR above the mean — within the 3× allowance. Stop/target kept
        // inside the ATR-5 geometry band (the fixture's 95/110 pair is a
        // 2×ATR target — a reachability refusal, tested in its own suite).
        const inBand = { stop: 97, target: 106 };
        const ok = checkProposalRisk(longProposal(inBand), { dailyAtr: 5, ema10: 90 }, RULES);
        expect(ok.ok).toBe(true);
        // ATR present but no EMA → check skipped (fail-open)
        const skipped = checkProposalRisk(longProposal(inBand), { dailyAtr: 5 }, RULES);
        expect(skipped.ok).toBe(true);
    });

    test('a pullback entry BELOW the mean is never "extended" for a long', () => {
        const r = checkProposalRisk(longProposal({ stop: 97, target: 106 }), { dailyAtr: 5, ema10: 120 }, RULES);
        expect(r.ok).toBe(true); // entry 100 under EMA 120 → negative extension
    });
});

describe('checkPriceRun refusal kinds', () => {
    test('distinguishes chasing from invalidation (advice differs downstream)', () => {
        const p = { direction: 'long' as const, entry: 100, stop: 95, target: 110 };
        expect(checkPriceRun(p, 104).kind).toBe('chasing');       // past the 102.5 chase line
        expect(checkPriceRun(p, 94).kind).toBe('invalidated');    // through the stop
        expect(checkPriceRun(p, 101).kind).toBeUndefined();       // ok
        const s = { direction: 'short' as const, entry: 100, stop: 105, target: 90 };
        expect(checkPriceRun(s, 96).kind).toBe('chasing');
        expect(checkPriceRun(s, 106).kind).toBe('invalidated');
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
    test('valid long stop-limit entry passes (geometry at the limit cap)', () => {
        // Judged at the CAP (worst permitted fill, review 2026-08-21):
        // risk 2.8 (102.8−100.0), reward 5.65 (108.45−102.8) → R/R 2.02 ≥ 2.0
        const r = checkProposalRisk(
            longProposal({ entryType: 'STP_LMT', entry: 102.2, entryLimit: 102.8, stop: 100.0, target: 108.45 }),
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

describe('prescriptive refusal geometry (Jul 30 MU failure)', () => {
    // MU-shaped case: ATR 85.85 → min stop 34.34, and 2:1 on that stop
    // demands a target 68.68 away. Each refusal must hand over BOTH bounds.
    test('noise-stop refusal includes the jointly-valid stop AND target bounds', () => {
        const r = checkProposalRisk(
            longProposal({ entry: 790, stop: 784, target: 825, quantity: 1 }),
            { dailyAtr: 85.85 },
            RULES,
        );
        expect(r.ok).toBe(false);
        const all = r.violations.join(' ');
        expect(all).toContain('VIABLE GEOMETRY');
        expect(all).toContain('$755.66'); // 790 − 0.4×85.85
        expect(all).toContain('$858.68'); // 790 + 2×0.4×85.85
        expect(all).toContain('SKIP');
    });

    test('the intraday prescription is a BAND, skip-first: reachability cap and widest stop included', () => {
        const r = checkProposalRisk(
            longProposal({ entry: 790, stop: 784, target: 825, quantity: 1 }),
            { dailyAtr: 85.85 },
            RULES,
        );
        const all = r.violations.join(' ');
        // The honest-objective question leads; the numbers follow.
        expect(all).toContain('FIRST');
        expect(all).toContain('$918.77'); // target cap: 790 + 1.5×85.85, floor
        expect(all).toContain('$725.62'); // widest stop: 790 − 1.5×85.85/2, ceil
    });

    test('obeying the band edges verbatim passes (widest stop + its 2× target)', () => {
        // Stop at the far edge $725.62 (dist 64.38), target 2× that = $918.76
        // — inside the $918.77 cap. Inner rounding must make this pass.
        const r = checkProposalRisk(
            longProposal({ entry: 790, stop: 725.62, target: 918.76, quantity: 1 }),
            { dailyAtr: 85.85 },
            RULES,
        );
        expect(r.ok).toBe(true);
        expect(r.violations).toEqual([]);
    });

    test('R/R-only refusal also gets the solved geometry when ATR is known', () => {
        // Stop is wide enough (37 > 34.34) but target gives 1.0:1.
        const r = checkProposalRisk(
            longProposal({ entry: 788, stop: 751, target: 825, quantity: 1 }),
            { dailyAtr: 85.85 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('VIABLE GEOMETRY');
    });

    test('short direction mirrors the bounds', () => {
        const r = checkProposalRisk(
            longProposal({ direction: 'short', entry: 100, stop: 101, target: 95, quantity: 1 }),
            { dailyAtr: 10 },
            RULES,
        );
        expect(r.ok).toBe(false);
        const all = r.violations.join(' ');
        // short: stop bound = entry + minStop = 104, target bound = entry − 2×minStop = 92
        expect(all).toContain('$104.00');
        expect(all).toContain('$92.00');
    });

    test('following the prescription verbatim always passes (SOXL 0.4¢ regression)', () => {
        // SOXL live case: ATR 29.36 → min stop 11.744. Naive rounding
        // prescribed 119.26 (too tight by 0.4¢); away-from-entry rounding
        // must prescribe 119.25 / 154.50 — and that exact geometry passes.
        const refused = checkProposalRisk(
            longProposal({ symbol: 'SOXL', entry: 131, stop: 128, target: 140, quantity: 1 }),
            { dailyAtr: 29.36 },
            RULES,
        );
        expect(refused.ok).toBe(false);
        const all = refused.violations.join(' ');
        expect(all).toContain('$119.25');
        expect(all).toContain('$154.50');

        const obeyed = checkProposalRisk(
            longProposal({ symbol: 'SOXL', entry: 131, stop: 119.25, target: 154.5, quantity: 1 }),
            { dailyAtr: 29.36 },
            RULES,
        );
        expect(obeyed.ok).toBe(true);
        expect(obeyed.violations).toEqual([]);
    });

    test('no prescriptive line without ATR (nothing to solve with)', () => {
        const r = checkProposalRisk(longProposal({ target: 104 }), {}, RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).not.toContain('VIABLE GEOMETRY');
    });

    test('a passing proposal has no prescriptive line', () => {
        const r = checkProposalRisk(
            longProposal({ entry: 790, stop: 750, target: 880, quantity: 1 }),
            { dailyAtr: 85.85 },
            RULES,
        );
        expect(r.ok).toBe(true);
        expect(r.violations).toEqual([]);
    });
});

describe('earnings-gap exception (Jul 30 MSFT failure)', () => {
    // MSFT-shaped case: entry 434, EMA10 390, ATR 12 → 3.7× extension.
    const extended = { entry: 434, stop: 428, target: 450, quantity: 1 };

    test('extended entry is refused without the earnings flag', () => {
        const r = checkProposalRisk(
            longProposal(extended),
            { dailyAtr: 12, ema10: 390 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('chasing an extended move');
    });

    test('recent earnings waives the extension check with a visible note', () => {
        const r = checkProposalRisk(
            longProposal(extended),
            { dailyAtr: 12, ema10: 390, recentEarnings: true },
            RULES,
        );
        expect(r.ok).toBe(true);
        expect(r.violations).toEqual([]);
        expect(r.notes.join(' ')).toContain('earnings-gap exception');
    });

    test('the waiver does NOT weaken the other gates (noise stop still bites)', () => {
        const r = checkProposalRisk(
            longProposal({ entry: 434, stop: 433, target: 450, quantity: 1 }),
            { dailyAtr: 12, ema10: 390, recentEarnings: true },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('intraday noise');
    });

    test('recentEarnings false or absent keeps the guard strict', () => {
        const r = checkProposalRisk(
            longProposal(extended),
            { dailyAtr: 12, ema10: 390, recentEarnings: false },
            RULES,
        );
        expect(r.ok).toBe(false);
    });
});

describe('fractional quantities at the gate', () => {
    const FRAC_RULES = { ...RULES, fractional_shares: true }; // ratchet: sizing math, not exit policy

    test('decimal quantity refused under whole-share rules (paper default)', () => {
        const r = checkProposalRisk(longProposal({ quantity: 1.48 }), {}, RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('positive integer');
    });

    test('0.0001-resolution decimals pass when fractional_shares is on', () => {
        const r = checkProposalRisk(longProposal({ quantity: 1.48 }), {}, FRAC_RULES);
        expect(r.ok).toBe(true);
        expect(r.positionValue).toBeCloseTo(148, 5);
    });

    test('sub-resolution dust is refused even in fractional mode', () => {
        const r = checkProposalRisk(longProposal({ quantity: 1.234567 }), {}, FRAC_RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('0.0001');
    });

    test('risk budget and position caps compute correctly on fractional quantities', () => {
        // 1.48 × $100 = $148 position; stop distance 5 → $7.40 at risk.
        const r = checkProposalRisk(
            longProposal({ quantity: 1.48 }),
            { netLiquidation: 3700 },
            { ...FRAC_RULES, max_position_pct: 20, max_risk_per_trade_pct: 1.0 },
        );
        expect(r.ok).toBe(true);
    });
});

describe('plannedWorstLossUsd (per-proposal planned worst case)', () => {
    test('stop-protected classes pay quantity × stop distance', () => {
        expect(plannedWorstLossUsd({ quantity: 10, entry: 100, stop: 95 }, DEFAULT_RULES)).toBe(50);
        expect(plannedWorstLossUsd(
            { quantity: 10, entry: 100, stop: 105, tradeClass: 'swing' }, DEFAULT_RULES,
        )).toBe(50); // shorts: |basis − stop|
    });

    test('a filled entry re-prices the risk from the actual fill', () => {
        expect(plannedWorstLossUsd(
            { quantity: 10, entry: 100, entryFillPrice: 101, stop: 95 }, DEFAULT_RULES,
        )).toBe(60); // fill 101, not the planned 100
    });

    test('earnings bets pay the assumed adverse gap, never the stop', () => {
        // 20% floor on a $100 basis = $20/share — the $5 stop is irrelevant
        // because a stop cannot protect through a print.
        expect(plannedWorstLossUsd(
            { quantity: 10, entry: 100, stop: 95, tradeClass: 'earnings-bet', worstCaseGapPct: 12 },
            DEFAULT_RULES,
        )).toBe(200);
    });

    test('rows without a usable basis are null (not zero risk)', () => {
        expect(plannedWorstLossUsd({ quantity: 10, entry: null, stop: 95 }, DEFAULT_RULES)).toBeNull();
        expect(plannedWorstLossUsd({ quantity: 0, entry: 100, stop: 95 }, DEFAULT_RULES)).toBeNull();
        expect(plannedWorstLossUsd({ quantity: 10, entry: 100, stop: 100 }, DEFAULT_RULES)).toBeNull();
    });

    test('entryLimit is the last-resort basis for unfilled STP_LMT rows', () => {
        expect(plannedWorstLossUsd({ quantity: 10, entry: null, entryLimit: 102, stop: 97 }, DEFAULT_RULES)).toBe(50);
    });
});

describe('daily-loss headroom gate (the kill-switch is a budget, not a tripwire)', () => {
    // Live-profile shaped numbers: €3.7K account, 3% halt = $111 limit.
    const LIVE_ISH = { ...RULES, max_daily_loss_pct: 3, max_risk_per_trade_pct: 1.0, max_position_pct: 20 }; // ratchet: headroom math, not exit policy

    test('a book whose planned stops would breach the halt is refused', () => {
        // Open book already commits $80 of planned stops; this trade plans
        // $35 more (7 × $5 stop distance) — $115 > the $111 limit. Position
        // value $700 stays under the 20% cap so ONLY the headroom fires.
        const r = checkProposalRisk(
            longProposal({ quantity: 7 }),
            { netLiquidation: 3700, openPlannedRiskUsd: 80 },
            LIVE_ISH,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('daily-loss headroom');
        expect(r.violations.join(' ')).toContain('stop out through the halt');
    });

    test('the same trade passes when the book leaves room', () => {
        const r = checkProposalRisk(
            longProposal({ quantity: 7 }),
            { netLiquidation: 3700, openPlannedRiskUsd: 60 }, // 35 + 60 ≤ 111
            LIVE_ISH,
        );
        expect(r.ok).toBe(true);
    });

    test('realized losses today shrink the headroom', () => {
        const r = checkProposalRisk(
            longProposal({ quantity: 7 }),
            { netLiquidation: 3700, openPlannedRiskUsd: 60, realizedLossTodayUsd: -20 },
            LIVE_ISH, // 111 − 20 − 60 = 31 < 35 → refused
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('already realized in losses today');
    });

    test('wins never expand the planned-stop budget (clamped at zero)', () => {
        // Wider per-trade budget (3%) so only the headroom can refuse:
        // 7 × $10 stop distance = $70 planned vs headroom 111 − 60 = 51.
        const r = checkProposalRisk(
            longProposal({ quantity: 7, stop: 90, target: 120 }),
            { netLiquidation: 3700, openPlannedRiskUsd: 60, realizedLossTodayUsd: 250 },
            { ...LIVE_ISH, max_risk_per_trade_pct: 3 }, // +250 must NOT stretch 51 to fit 70
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('daily-loss headroom');
    });

    test('without book context the check does not run (creation-time unchanged)', () => {
        const r = checkProposalRisk(
            longProposal({ quantity: 7 }),
            { netLiquidation: 3700 },
            LIVE_ISH,
        );
        expect(r.ok).toBe(true);
    });

    test('earnings bets are priced by their gap in the headroom sum', () => {
        const rules = { ...LIVE_ISH, earnings_bet_enabled: true, earnings_bet_risk_pct: 10 };
        // 5 shares × $20 gap (20% floor on $100) = $100 planned > $111 − $60.
        const r = checkProposalRisk(
            longProposal({ quantity: 5, tradeClass: 'earnings-bet' }),
            { netLiquidation: 3700, openPlannedRiskUsd: 60, worstCaseGapPct: 12 },
            rules,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('daily-loss headroom');
    });
});

describe('plannedBookWorstCasePct (config coherence)', () => {
    test('live profile: 3 slots of 1.5% swings = 4.5% — the audited contradiction', () => {
        const live = {
            ...DEFAULT_RULES,
            max_open_positions: 3,
            max_risk_per_trade_pct: 1.0,
            swing_risk_pct: 1.5,
            max_swing_positions: 3,
            earnings_bet_enabled: false,
        };
        expect(plannedBookWorstCasePct(live)).toBe(4.5);
    });

    test('paper profile: 3 swings + 7 intraday = 3.25%', () => {
        // DEFAULT_RULES: 10 slots, swing 3 × 0.5%, intraday 0.25%.
        expect(plannedBookWorstCasePct(DEFAULT_RULES)).toBe(3.25);
    });

    test('swing cap larger than the book is bounded by max_open_positions', () => {
        const rules = { ...DEFAULT_RULES, max_open_positions: 2, max_swing_positions: 3, swing_risk_pct: 1 };
        expect(plannedBookWorstCasePct(rules)).toBe(2);
    });
});

describe('overnight caps (GTC proposals — formerly phantom)', () => {
    // Paper numbers: overnight position 3%, overnight book 30% of $100k.
    test('a GTC position above max_overnight_position_pct is refused', () => {
        // 40 × $100 = $4,000 = 4% > 3% overnight cap (but under the 5% intraday cap).
        const r = checkProposalRisk(
            longProposal({ quantity: 40, tif: 'GTC' }),
            { netLiquidation: 100_000 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('overnight position');
        expect(r.violations.join(' ')).toContain('max 30 shares');
    });

    test('the same size passes as a DAY trade — the overnight cap is GTC-only', () => {
        const r = checkProposalRisk(
            longProposal({ quantity: 40, tif: 'DAY' }),
            { netLiquidation: 100_000 },
            RULES,
        );
        expect(r.ok).toBe(true);
    });

    test('the total overnight book cap refuses stacking past max_overnight_exposure_pct', () => {
        // $2,500 new + $28,000 already surviving the close > 30% ($30,000).
        const r = checkProposalRisk(
            longProposal({ quantity: 25, tif: 'GTC' }),
            { netLiquidation: 100_000, overnightExposureUsd: 28_000 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('overnight book cap');

        const ok = checkProposalRisk(
            longProposal({ quantity: 25, tif: 'GTC' }),
            { netLiquidation: 100_000, overnightExposureUsd: 27_000 },
            RULES,
        );
        expect(ok.ok).toBe(true);
    });
});

describe('sector concentration cap (formerly phantom)', () => {
    test('stacking a fourth correlated name past max_sector_exposure_pct is refused', () => {
        // $2,500 new + $18,000 already in Technology > 20% of $100k.
        const r = checkProposalRisk(
            longProposal({ quantity: 25 }),
            { netLiquidation: 100_000, sector: 'Technology', sameSectorExposureUsd: 18_000 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('Technology');
        expect(r.violations.join(' ')).toContain('sector cap');
        expect(r.violations.join(' ')).toContain('breadth vehicle');
    });

    test('inside the cap passes; applies to DAY and GTC alike', () => {
        const r = checkProposalRisk(
            longProposal({ quantity: 25, tif: 'GTC' }),
            { netLiquidation: 100_000, sector: 'Technology', sameSectorExposureUsd: 15_000 },
            RULES,
        );
        expect(r.ok).toBe(true);
    });

    test('unknown sector (ETF, data miss) skips with a visible note, never guesses', () => {
        const r = checkProposalRisk(
            longProposal({ quantity: 25 }),
            { netLiquidation: 100_000, sector: null, sameSectorExposureUsd: 50_000 },
            RULES,
        );
        expect(r.ok).toBe(true);
        expect(r.notes.join(' ')).toContain('sector cap not evaluated');
    });
});

describe('earnings-bet LIVE-GATE (the evidence bar stops being advisory)', () => {
    const BET_RULES = { ...DEFAULT_RULES, earnings_bet_enabled: true, earnings_bet_risk_pct: 10 };
    const goodEvidence = {
        reportsWithinWindow: true as boolean | null,
        meetsBar: true as boolean | null,
        nPrints: 9,
        consistencyPct: 78,
        recordWorstAdversePct: 12 as number | null,
    };
    const bet = (worstCaseGapPct?: number) => longProposal({ quantity: 5, tradeClass: 'earnings-bet', tif: 'GTC' as const });

    test('a qualifying bet passes: window verified, bar met, gap not understated', () => {
        const r = checkProposalRisk(bet(), { earningsBetEvidence: goodEvidence, worstCaseGapPct: 20 }, BET_RULES);
        expect(r.ok).toBe(true);
    });

    test('no verifiable print → refused (a mislabeled class does not dodge the intraday rules)', () => {
        const r = checkProposalRisk(bet(), { earningsBetEvidence: { ...goodEvidence, reportsWithinWindow: false } }, BET_RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('no verifiable print');
    });

    test('calendar unavailable → refused, fail-closed (an unconfirmed date kills the bet)', () => {
        const r = checkProposalRisk(bet(), { earningsBetEvidence: { ...goodEvidence, reportsWithinWindow: null } }, BET_RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('could not be verified');
    });

    test('a record below the bar is refused with its own numbers', () => {
        const r = checkProposalRisk(bet(), {
            earningsBetEvidence: { ...goodEvidence, meetsBar: false, nPrints: 6, consistencyPct: 66 },
        }, BET_RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('6 prints, 66% consistency');
        expect(r.violations.join(' ')).toContain('need ≥8 prints and ≥75%');
    });

    test('no record at all → refused (no evidence base, no bet)', () => {
        const r = checkProposalRisk(bet(), {
            earningsBetEvidence: { reportsWithinWindow: true, meetsBar: null, nPrints: null, consistencyPct: null, recordWorstAdversePct: null },
        }, BET_RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('no evidence base');
    });

    test('a flattering worstCaseGapPct is refused against the record (the 45%-gap undersizing hole)', () => {
        const r = checkProposalRisk(bet(), {
            earningsBetEvidence: { ...goodEvidence, recordWorstAdversePct: 45 },
            worstCaseGapPct: 20,
        }, BET_RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('gapped 45%');
        expect(r.violations.join(' ')).toContain('worstCaseGapPct ≥ 45');
        // Omitting worstCaseGapPct entirely (floor 20 assumed) is refused the same way.
        const omitted = checkProposalRisk(bet(), {
            earningsBetEvidence: { ...goodEvidence, recordWorstAdversePct: 45 },
        }, BET_RULES);
        expect(omitted.ok).toBe(false);
    });

    test('a MORE conservative gap than the record passes; a benign record defers to the floor', () => {
        const conservative = checkProposalRisk(bet(), {
            earningsBetEvidence: { ...goodEvidence, recordWorstAdversePct: 45 },
            worstCaseGapPct: 50,
        }, { ...BET_RULES, earnings_bet_risk_pct: 15 });
        expect(conservative.ok).toBe(true);
        // Record worst 12% < the 20% floor: the floor governs, nothing refused.
        const benign = checkProposalRisk(bet(), { earningsBetEvidence: goodEvidence }, BET_RULES);
        expect(benign.ok).toBe(true);
    });

    test('without evidence context the checks skip — old callers and non-bet classes unaffected', () => {
        const r = checkProposalRisk(bet(), {}, BET_RULES);
        expect(r.ok).toBe(true);
    });
});

describe('tick alignment (the ACHR 6.845 live rejection, 2026-08-11)', () => {
    test('a sub-penny entry is refused with the two placeable neighbors', () => {
        const r = checkProposalRisk(longProposal({ entry: 6.845, stop: 6.68, target: 7.18, quantity: 100 }), {}, RULES);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('entry $6.845 is not on the $0.01 tick grid');
        expect(r.violations.join(' ')).toContain('use 6.84 or 6.85');
    });

    test('sub-penny stops, targets and entryLimits are refused too', () => {
        const r = checkProposalRisk(
            longProposal({ entryType: 'STP_LMT', entry: 10, entryLimit: 10.025, stop: 9.505, target: 11.005 }),
            {},
            RULES,
        );
        expect(r.ok).toBe(false);
        const all = r.violations.join(' ');
        expect(all).toContain('entryLimit $10.025');
        expect(all).toContain('stop $9.505');
        expect(all).toContain('target $11.005');
    });

    test('cent-aligned prices pass untouched (float dust tolerated)', () => {
        // 6.84 is not exactly representable in binary — the check must not
        // refuse honest cent prices over float noise.
        const r = checkProposalRisk(longProposal({ entry: 6.84, stop: 6.67, target: 7.18, quantity: 100 }), {}, RULES);
        expect(r.violations.join(' ')).not.toContain('tick grid');
    });
});

describe('assertAcceptContext (WP6 — the accept-time context is REQUIRED)', () => {
    const FULL = { symbol: 'NVDA', dailyAtr: 3.2, ema10: 180, lastPrice: 182.5 };

    test('complete context passes silently', () => {
        expect(() => assertAcceptContext(FULL)).not.toThrow();
    });

    test('each missing piece refuses, naming the checks it starves', () => {
        expect(() => assertAcceptContext({ ...FULL, dailyAtr: null })).toThrow(/daily ATR.*noise-stop/);
        expect(() => assertAcceptContext({ ...FULL, ema10: null })).toThrow(/EMA10.*extension/);
        expect(() => assertAcceptContext({ ...FULL, lastPrice: null })).toThrow(/live quote.*chase/);
    });

    test('all failures are named at once — one retry fixes everything visible', () => {
        try {
            assertAcceptContext({ symbol: 'X', dailyAtr: null, ema10: null, lastPrice: null });
            throw new Error('should have refused');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            expect(msg).toContain('[context-gate]');
            expect(msg).toContain('daily ATR');
            expect(msg).toContain('EMA10');
            expect(msg).toContain('live quote');
            expect(msg).toContain('FAIL-CLOSED');
        }
    });

    test('zero or negative values are as missing as null (NaN-poisoning family)', () => {
        expect(() => assertAcceptContext({ ...FULL, dailyAtr: 0 })).toThrow(/daily ATR/);
        expect(() => assertAcceptContext({ ...FULL, lastPrice: -1 })).toThrow(/live quote/);
    });
});

describe('UNKNOWN sector bucket (WP6, decision D3)', () => {
    test('unresolved-sector exposure past the cap refuses with the bucket named', () => {
        const r = checkProposalRisk(
            longProposal({ quantity: 25 }),
            { netLiquidation: 100_000, sector: 'UNKNOWN', sameSectorExposureUsd: 18_000 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('UNKNOWN bucket');
        expect(r.violations.join(' ')).toContain('unclassifiable exposure');
    });

    test('the bucket is capped like any sector — inside it passes', () => {
        const r = checkProposalRisk(
            longProposal({ quantity: 25 }),
            { netLiquidation: 100_000, sector: 'UNKNOWN', sameSectorExposureUsd: 5_000 },
            RULES,
        );
        expect(r.ok).toBe(true);
    });
});

describe('checkMicrostructure (WP7 — the market must be able to absorb the order)', () => {
    const RULES7 = { ...DEFAULT_RULES, max_spread_pct: 0.5, max_adv_pct: 1.0, min_avg_volume: 500_000 };
    const GOOD = {
        symbol: 'NVDA', direction: 'long' as const, quantity: 100,
        bid: 99.95, ask: 100.05, avgDailyVolume20d: 5_000_000,
        shortable: true, halted: false,
    };

    test('liquid, tight, unhalted long passes clean', () => {
        const r = checkMicrostructure(GOOD, RULES7);
        expect(r.violations).toEqual([]);
    });

    test('wide spread is refused with the percentage named', () => {
        const r = checkMicrostructure({ ...GOOD, bid: 99, ask: 100 }, RULES7); // ~1% spread
        expect(r.violations.join(' ')).toContain('spread');
        expect(r.violations.join(' ')).toContain('max_spread_pct');
    });

    test('missing quote sides are fail-closed, never skipped', () => {
        expect(checkMicrostructure({ ...GOOD, bid: null }, RULES7).violations.join(' ')).toContain('fail-closed');
        expect(checkMicrostructure({ ...GOOD, ask: null }, RULES7).violations.join(' ')).toContain('fail-closed');
    });

    test('min_avg_volume is finally deterministic (the 2026-08-06 soft-limit item)', () => {
        const r = checkMicrostructure({ ...GOOD, avgDailyVolume20d: 200_000 }, RULES7);
        expect(r.violations.join(' ')).toContain('min_avg_volume');
    });

    test('order above max_adv_pct of ADV is refused (market-impact bound)', () => {
        // 100k shares vs 5M ADV = 2% > 1% cap.
        const r = checkMicrostructure({ ...GOOD, quantity: 100_000 }, RULES7);
        expect(r.violations.join(' ')).toContain('ADV');
    });

    test('ADV unavailable is fail-closed', () => {
        expect(checkMicrostructure({ ...GOOD, avgDailyVolume20d: null }, RULES7).violations.length).toBeGreaterThan(0);
    });

    test('shorts require CONFIRMED borrow: not-shortable and unknown both refuse; longs never ask', () => {
        const short = { ...GOOD, direction: 'short' as const };
        expect(checkMicrostructure({ ...short, shortable: false }, RULES7).violations.join(' ')).toContain('shortable');
        expect(checkMicrostructure({ ...short, shortable: null }, RULES7).violations.join(' ')).toContain('borrow');
        expect(checkMicrostructure({ ...GOOD, shortable: null }, RULES7).violations).toEqual([]);
    });

    test('a halt refuses; unknown halt state is a NOTE, not a refusal (best-effort v1)', () => {
        expect(checkMicrostructure({ ...GOOD, halted: true }, RULES7).violations.join(' ')).toContain('HALTED');
        const unknown = checkMicrostructure({ ...GOOD, halted: null }, RULES7);
        expect(unknown.violations).toEqual([]);
        expect(unknown.notes.join(' ')).toContain('halt');
    });
});

describe('STP_LMT worst-fill risk basis (review 2026-08-21)', () => {
    test('geometry that passes at the trigger but fails at the limit cap is refused', () => {
        // Trigger 100, cap 104, stop 95, target 112: at the trigger R/R is
        // 12/5 = 2.4 (passes); at the cap — the worst permitted fill — it
        // is 8/9 ≈ 0.89. The trade the broker can actually give us fails.
        const r = checkProposalRisk(
            longProposal({ entryType: 'STP_LMT', entry: 100, entryLimit: 104, stop: 95, target: 112 }),
            {},
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('limit cap');
    });

    test('position value and share caps are judged at the cap too', () => {
        // 50 shares at cap 104 = $5,200 > 5% of $100k; at the trigger it
        // would have squeaked under.
        const r = checkProposalRisk(
            longProposal({ entryType: 'STP_LMT', entry: 100, entryLimit: 104, stop: 92, target: 130, quantity: 50 }),
            { netLiquidation: 100_000 },
            RULES,
        );
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('exceeds');
    });

    test('plannedWorstLossUsd prices unfilled STP_LMT rows at the worse basis', () => {
        // Long: cap 104 is farther from stop 95 than trigger 100 → 9/share.
        expect(plannedWorstLossUsd(
            { quantity: 10, entry: 100, entryLimit: 104, stop: 95 },
            RULES,
        )).toBe(90);
    });
});

describe('take-at-x% policy (WP-EXIT — the intraday target IS the take level)', () => {
    // Production default rules: exit_style 'target', take 1.5×ATR% in [3, 10],
    // max_target_atr 1.5, min_stop 0.4×ATR, min_rr 2.
    const TAKE = { ...DEFAULT_RULES };
    // 4%-ATR name at $100: x = clamp(1.5×4, 3, 10) = 6 → target 106.
    const base = (over: Partial<RiskGateProposal> = {}): RiskGateProposal => ({
        symbol: 'MOVR', direction: 'long', entryType: 'LMT',
        entry: 100, stop: 97.5, target: 106, quantity: 10, ...over,
    });

    test('formula target passes and the result carries the enforced x (REQ-EXIT-001)', () => {
        const r = checkProposalRisk(base(), { dailyAtr: 4 }, TAKE);
        expect(r.ok).toBe(true);
        expect(r.takePct).toBeCloseTo(6, 10);
        expect(r.takePctSource).toBe('formula');
    });

    test('a target off the take level is refused with the exact required price (REQ-EXIT-003)', () => {
        const r = checkProposalRisk(base({ target: 110 }), { dailyAtr: 4 }, TAKE);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('use target $106.00');
    });

    test('model take_pct override moves the required target; out-of-band overrides are refused (REQ-EXIT-002)', () => {
        // Override 8% at ATR 6 (cap allows up to 9%) → target 108; stop ≤ 4 for 2:1.
        const ok = checkProposalRisk(base({ takePct: 8, target: 108, stop: 96.5 }), { dailyAtr: 6 }, TAKE);
        expect(ok.ok).toBe(true);
        expect(ok.takePct).toBe(8);
        expect(ok.takePctSource).toBe('model');
        const low = checkProposalRisk(base({ takePct: 2 }), { dailyAtr: 4 }, TAKE);
        expect(low.ok).toBe(false);
        expect(low.violations.join(' ')).toContain('outside the take band');
        const high = checkProposalRisk(base({ takePct: 12 }), { dailyAtr: 4 }, TAKE);
        expect(high.ok).toBe(false);
        expect(high.violations.join(' ')).toContain('outside the take band');
    });

    test('an in-band override past the reachability cap is refused with the max x (REQ-EXIT-004)', () => {
        // ATR 4: the 1.5×ATR cap allows at most x = 6 — an 8% override asks
        // for travel the session does not have.
        const r = checkProposalRisk(base({ takePct: 8, target: 108, stop: 96.5 }), { dailyAtr: 4 }, TAKE);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('exceeds reachability');
        expect(r.violations.join(' ')).toContain('6.0%');
    });

    test('low-ATR symbol is intraday-ineligible — the cap wins over the floor, no prescription ping-pong (REQ-EXIT-004)', () => {
        // 1.2%-ATR mega-cap: formula x floors at 3% = 2.5×ATR > 1.5×ATR cap.
        const r = checkProposalRisk(
            base({ symbol: 'MEGA', stop: 99.4, target: 103 }),
            { dailyAtr: 1.2 }, TAKE,
        );
        expect(r.ok).toBe(false);
        const msg = r.violations.join(' ');
        expect(msg).toContain('intraday-ineligible');
        expect(msg).not.toContain('use target $');
    });

    test('missing daily ATR fails closed for intraday (REQ-EXIT-005)', () => {
        const r = checkProposalRisk(base(), {}, TAKE);
        expect(r.ok).toBe(false);
        expect(r.violations.join(' ')).toContain('daily ATR unavailable');
    });

    test('the 2:1 gate at the take level forces stops to x/2 (REQ-EXIT-006)', () => {
        // Stop 5 away with a 6% take: R/R 1.2 — refused, with the fixed-target
        // prescription solving the stop band instead of inviting a farther target.
        const r = checkProposalRisk(base({ stop: 95 }), { dailyAtr: 4 }, TAKE);
        expect(r.ok).toBe(false);
        const msg = r.violations.join(' ');
        expect(msg).toContain('risk/reward');
        expect(msg).toContain('target is FIXED at $106.00');
        expect(msg).not.toContain('target at/beyond');
    });

    test('swing and earnings-bet classes are exempt (REQ-EXIT-009)', () => {
        const swing = checkProposalRisk(
            base({ tradeClass: 'swing', target: 110, tif: 'GTC' }),
            { dailyAtr: 4, openSwingPositions: 0 }, TAKE,
        );
        expect(swing.ok).toBe(true);
        expect(swing.takePct).toBeNull();
    });

    test('STP_LMT: the take target is priced from the LIMIT CAP (worst permitted fill)', () => {
        // Cap 100.5, x = 6 → target = round(100.5 × 1.06) = 106.53.
        const r = checkProposalRisk(base({
            entryType: 'STP_LMT', entry: 100.2, entryLimit: 100.5,
            stop: 98.0, target: 106.53,
        }), { dailyAtr: 4 }, TAKE);
        expect(r.ok).toBe(true);
        expect(r.takePct).toBeCloseTo(6, 1);
    });

    test('accept-time stability: the stored x rides as the override, so ATR drift cannot move the target', () => {
        // Created at ATR 4 (x=6, target 106); re-checked at drifted ATR 4.2
        // with the stored override → still requires exactly 106, still passes.
        const r = checkProposalRisk(base({ takePct: 6 }), { dailyAtr: 4.2 }, TAKE);
        expect(r.ok).toBe(true);
        expect(r.takePct).toBe(6);
        // An ATR COLLAPSE re-judges reachability and refuses (fail-closed):
        // at ATR 3.5 the cap allows only 5.25% — the stored 6% no longer fits.
        const collapsed = checkProposalRisk(base({ takePct: 6 }), { dailyAtr: 3.5 }, TAKE);
        expect(collapsed.ok).toBe(false);
        expect(collapsed.violations.join(' ')).toContain('exceeds reachability');
    });

    test('ratchet mode leaves targets free (legacy checks bind instead)', () => {
        const r = checkProposalRisk(base({ target: 105 }), { dailyAtr: 4 }, RULES);
        expect(r.ok).toBe(true);
        expect(r.takePct).toBeNull();
    });
});
