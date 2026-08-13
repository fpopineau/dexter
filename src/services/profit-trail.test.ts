import { describe, expect, test } from 'bun:test';
import { observeTrail, trailExemptClass, trailGeometry, type TrailEntry } from './profit-trail.js';

function long(basis = 100): TrailEntry {
    return { symbol: 'TEST', direction: 'long', basis, quantity: 10, best: basis, armed: false };
}

describe('trailGeometry (ATR-aware thresholds, uniform in R-space)', () => {
    const mults = { armAtrMult: 2.5, pullbackAtrMult: 0.75, armPctFallback: 5, pullbackPctFallback: 1.5 };

    test('mega-cap (0.8% ATR): trail arms BELOW the 3×ATR target — no longer inert', () => {
        const g = trailGeometry({ atrPct: 0.8, ...mults });
        expect(g.mode).toBe('atr');
        expect(g.armPct).toBe(2); // 2.5 × 0.8 — the old absolute 5% was never reached before the ~2.4% target
        expect(g.pullbackPct).toBe(0.6); // 0.75 × 0.8
        expect(g.armPct).toBeLessThan(3 * 0.8); // arms before the 2:1 target fills
    });

    test('high-ATR runner (4% ATR): trail distance clears single-bar noise', () => {
        const g = trailGeometry({ atrPct: 4, ...mults });
        expect(g.armPct).toBe(10); // 1.67R against a 6% (1.5×ATR) stop
        expect(g.pullbackPct).toBe(3); // the old absolute 1.5% was inside one bar's range
        // Worst exit after arming = arm − pullback = 7% = 1.17R — never sub-1R.
        expect(g.armPct - g.pullbackPct).toBeGreaterThan(1.5 * 4 * (2 / 3) * 0.999);
    });

    test('spread-noise floor: pullback never tighter than 0.35%', () => {
        const g = trailGeometry({ atrPct: 0.3, ...mults });
        expect(g.pullbackPct).toBe(0.35); // 0.75 × 0.3 = 0.225 → floored
        expect(g.armPct).toBe(0.75); // 2.5 × 0.3, still ≥ 2× pullback
    });

    test('misconfigured mults: arm is clamped to ≥ 2× pullback', () => {
        const g = trailGeometry({ atrPct: 2, armAtrMult: 1, pullbackAtrMult: 1.5, armPctFallback: 5, pullbackPctFallback: 1.5 });
        expect(g.pullbackPct).toBe(3);
        expect(g.armPct).toBe(6); // 1 × 2 = 2 would arm inside its own trail — clamped
    });

    test('ATR unavailable → the absolute fallback pair, never no-trail', () => {
        for (const atrPct of [null, 0, -1]) {
            const g = trailGeometry({ atrPct, ...mults });
            expect(g.mode).toBe('absolute');
            expect(g.armPct).toBe(5);
            expect(g.pullbackPct).toBe(1.5);
        }
    });
});

describe('trailExemptClass (thesis positions are not trailed)', () => {
    test('intraday and untracked positions keep the trail', () => {
        expect(trailExemptClass([])).toBe(false);
        expect(trailExemptClass(['intraday'])).toBe(false);
        expect(trailExemptClass(['intraday', 'intraday'])).toBe(false);
    });

    test('swing and earnings-bet exempt the whole position, even stacked with a scalp', () => {
        expect(trailExemptClass(['swing'])).toBe(true);
        expect(trailExemptClass(['earnings-bet'])).toBe(true);
        expect(trailExemptClass(['intraday', 'swing'])).toBe(true);
        expect(trailExemptClass(['intraday', 'earnings-bet'])).toBe(true);
    });
});

describe('profit trail state machine', () => {
    test('arms at +5% and closes on a 1% pullback from the peak', () => {
        const e = long(100);
        expect(observeTrail(e, 102, 5, 1)).toBeNull();   // +2% — not armed
        expect(e.armed).toBe(false);
        expect(observeTrail(e, 105, 5, 1)).toBeNull();   // +5% — arms, no pullback yet
        expect(e.armed).toBe(true);
        expect(observeTrail(e, 107, 5, 1)).toBeNull();   // new peak 107
        expect(observeTrail(e, 106.3, 5, 1)).toBeNull(); // −0.65% from peak — holds
        const d = observeTrail(e, 105.9, 5, 1);          // −1.03% from 107 — close
        expect(d?.action).toBe('close');
        expect(d?.gainAtBestPct).toBe(7);                // peak was +7%
    });

    test('the operator scenario: MU-style +12% runner is captured near the top', () => {
        const e = long(865);
        for (const px of [880, 900, 930, 960, 970]) observeTrail(e, px, 5, 1);
        expect(e.armed).toBe(true);
        const d = observeTrail(e, 960.2, 5, 1);          // 1.01% off the 970 peak
        expect(d?.action).toBe('close');
        expect(d!.gainAtBestPct).toBeGreaterThan(12);
    });

    test('never fires below the arm threshold, even on big pullbacks', () => {
        const e = long(100);
        observeTrail(e, 104, 5, 1);                      // peak +4%
        expect(observeTrail(e, 100.5, 5, 1)).toBeNull(); // −3.4% pullback — still unarmed
        expect(e.armed).toBe(false);
    });

    test('short positions arm on drops and close on bounces', () => {
        const e: TrailEntry = { symbol: 'TEST', direction: 'short', basis: 100, quantity: 10, best: 100, armed: false };
        expect(observeTrail(e, 96, 5, 1)).toBeNull();    // +4% gain — not armed
        expect(observeTrail(e, 94, 5, 1)).toBeNull();    // +6% — armed, peak 94
        expect(e.armed).toBe(true);
        const d = observeTrail(e, 94.95, 5, 1);          // bounce +1.01% off the low
        expect(d?.action).toBe('close');
    });

    test('once armed it stays armed even if gain dips below the threshold', () => {
        const e = long(100);
        observeTrail(e, 105, 5, 1);                      // arm at exactly +5%
        const d = observeTrail(e, 103.9, 5, 1);          // −1.05% from peak (gain now +3.9%)
        expect(d?.action).toBe('close');
    });

    test('bad inputs are ignored', () => {
        const e = long(100);
        expect(observeTrail(e, 0, 5, 1)).toBeNull();
        expect(observeTrail(e, NaN, 5, 1)).toBeNull();
    });

    test('records the live mark: last follows every observation, best only ratchets', () => {
        const e = long(100);
        observeTrail(e, 106, 5, 10);                     // arm, peak 106 (wide 10% trail — stays open)
        expect(observeTrail(e, 100.4, 5, 10)).toBeNull(); // round-trips almost to entry, still watched
        expect(e.best).toBe(106);                        // peak gain would still read +6%
        expect(e.last).toBe(100.4);                      // instant gain is +0.4% — what the dashboard shows
    });

    test('bad inputs do not clobber the recorded mark', () => {
        const e = long(100);
        observeTrail(e, 103, 5, 1);
        observeTrail(e, NaN, 5, 1);
        observeTrail(e, 0, 5, 1);
        expect(e.last).toBe(103);
    });
});

describe('runner mode direction mapping (shorts covered)', () => {
    test('exit side: long exits SELL, short exits BUY', async () => {
        const { exitActionFor } = await import('./profit-trail.js');
        const { OrderAction } = await import('@stoqey/ib');
        expect(exitActionFor('long')).toBe(OrderAction.SELL);
        expect(exitActionFor('short')).toBe(OrderAction.BUY);
    });

    test('target selection picks the LMT leg and never the stop, both directions', async () => {
        const { selectTargetLegs } = await import('./profit-trail.js');
        // Long bracket exits: SELL LMT (target) + SELL STP (stop)
        const longExits = [
            { orderId: 1, orderType: 'LMT', tif: 'GTC' },
            { orderId: 2, orderType: 'STP', tif: 'GTC' },
        ];
        expect(selectTargetLegs(longExits).map((o) => o.orderId)).toEqual([1]);
        // Short bracket exits: BUY LMT (target below) + BUY STP (stop above)
        const shortExits = [
            { orderId: 3, orderType: 'STP', tif: 'GTC' },
            { orderId: 4, orderType: 'LMT', tif: 'GTC' },
        ];
        expect(selectTargetLegs(shortExits).map((o) => o.orderId)).toEqual([4]);
        // STP LMT stops (momentum-style) are never targets
        expect(selectTargetLegs([{ orderId: 5, orderType: 'STP LMT', tif: 'GTC' }])).toEqual([]);
    });
});
