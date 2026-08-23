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

    test('release decision cancels only OUR LMT leg, never the stop, both directions (REQ-TRAIL-001)', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        // Long bracket exits: SELL LMT (target) + SELL STP (stop), both ours
        const longExits = [
            { orderId: 1, orderType: 'LMT', orderRef: 'P-1A2B:tp' },
            { orderId: 2, orderType: 'STP', orderRef: 'P-1A2B:stop' },
        ];
        const long = decideTargetRelease({ complete: true, orders: longExits });
        expect(long.cancelIds).toEqual([1]);
        expect(long.blockedReason).toBeNull();
        // Short auto-protect exits: BUY STP (stop above) + BUY LMT (target below)
        const shortExits = [
            { orderId: 3, orderType: 'STP', orderRef: 'protect-XYZ:stop' },
            { orderId: 4, orderType: 'LMT', orderRef: 'protect-XYZ:tp' },
        ];
        expect(decideTargetRelease({ complete: true, orders: shortExits }).cancelIds).toEqual([4]);
        // STP LMT stops (momentum-style) are never targets — nothing to cancel
        expect(decideTargetRelease({ complete: true, orders: [{ orderId: 5, orderType: 'STP LMT', orderRef: 'P-1A2B:stop' }] }).blockedReason)
            .toBe('no-targets');
    });

    test('a foreign (manual TWS) LMT is never a cancel candidate (REQ-TRAIL-001)', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        const d = decideTargetRelease({ complete: true, orders: [
            { orderId: 10, orderType: 'LMT', orderRef: null },            // manual TWS limit
            { orderId: 11, orderType: 'LMT', orderRef: 'my-own-note' },   // non-Dexter ref
            { orderId: 12, orderType: 'LMT', orderRef: 'P-9F00:tp' },     // ours
            { orderId: 13, orderType: 'STP', orderRef: 'P-9F00:stop' },
        ] });
        expect(d.cancelIds).toEqual([12]);
        expect(d.foreignRefs).toEqual(['#10 <no ref>', '#11 my-own-note']);
        expect(d.blockedReason).toBeNull();
    });

    test('a Dexter-owned LMT that is not a TARGET leg is never a candidate (REQ-TRAIL-003)', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        // An agent-authorized reduction limit shares the position's exit side
        // and our ownership — it is not the bracket target and must survive.
        const d = decideTargetRelease({ complete: true, orders: [
            { orderId: 30, orderType: 'LMT', orderRef: 'reduce-XYZ' },
            { orderId: 31, orderType: 'LMT', orderRef: 'P-9F04:tp' },
            { orderId: 32, orderType: 'STP', orderRef: 'P-9F04:stop' },
        ] });
        expect(d.cancelIds).toEqual([31]);
        expect(d.foreignRefs).toEqual([]); // ours — just not a target
        // Only a reduce- limit and our stop: no target to release at all.
        const onlyReduce = decideTargetRelease({ complete: true, orders: [
            { orderId: 33, orderType: 'LMT', orderRef: 'reduce-XYZ' },
            { orderId: 34, orderType: 'STP', orderRef: 'P-9F05:stop' },
        ] });
        expect(onlyReduce.blockedReason).toBe('no-targets');
        // The WP2 resized pair (:tp2/:stop2) is recognized on both sides.
        const resized = decideTargetRelease({ complete: true, orders: [
            { orderId: 35, orderType: 'LMT', orderRef: 'P-9F06:tp2' },
            { orderId: 36, orderType: 'STP', orderRef: 'P-9F06:stop2' },
        ] });
        expect(resized.cancelIds).toEqual([35]);
        // A reduce- STP is not bracket protection: release stays blocked.
        const reduceStop = decideTargetRelease({ complete: true, orders: [
            { orderId: 37, orderType: 'LMT', orderRef: 'P-9F07:tp' },
            { orderId: 38, orderType: 'STP', orderRef: 'reduce-XYZ' },
        ] });
        expect(reduceStop.blockedReason).toBe('no-own-stop');
    });

    test('no surviving Dexter STP leg blocks the release entirely (REQ-TRAIL-002)', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        // Our target but only a FOREIGN stop: releasing would hand protection
        // to an order we do not own — blocked.
        const foreignStop = decideTargetRelease({ complete: true, orders: [
            { orderId: 20, orderType: 'LMT', orderRef: 'P-9F01:tp' },
            { orderId: 21, orderType: 'STP', orderRef: null },
        ] });
        expect(foreignStop.blockedReason).toBe('no-own-stop');
        expect(foreignStop.cancelIds).toEqual([]);
        // No stop at all (partial book view, or stop already gone): blocked.
        const noStop = decideTargetRelease({ complete: true, orders: [
            { orderId: 22, orderType: 'LMT', orderRef: 'P-9F02:tp' },
        ] });
        expect(noStop.blockedReason).toBe('no-own-stop');
        // A Dexter STP LMT counts as the protective leg.
        const stpLmt = decideTargetRelease({ complete: true, orders: [
            { orderId: 23, orderType: 'LMT', orderRef: 'P-9F03:tp' },
            { orderId: 24, orderType: 'STP LMT', orderRef: 'P-9F03:stop' },
        ] });
        expect(stpLmt.blockedReason).toBeNull();
        expect(stpLmt.cancelIds).toEqual([23]);
    });
});

describe('ratchet mode geometry (REQ-EXIT-008, exit_style: ratchet)', () => {
    test('arms at the take level and gives back ~1 point of it', async () => {
        const { ratchetGeometry, observeTrail } = await import('./profit-trail.js');
        const g = ratchetGeometry(6);
        expect(g.mode).toBe('ratchet');
        expect(g.armPct).toBe(6);
        // Giveback solves (1.06)(1 − g/100) = 1.05 → ≈ 0.94%.
        expect(g.pullbackPct).toBeCloseTo(0.94, 2);
        // Worst post-arm exit right at the peak locks ≈ +5%.
        const worst = (1 + g.armPct / 100) * (1 - g.pullbackPct / 100) - 1;
        expect(worst * 100).toBeCloseTo(5, 1);

        // End-to-end through the state machine: long from 100, runs to the
        // arm at 106, then fades — closes at the lock, not at breakeven.
        const e = { symbol: 'RTCH', direction: 'long' as const, basis: 100, quantity: 10, best: 100, armed: false };
        expect(observeTrail(e, 105.9, g.armPct, g.pullbackPct)).toBeNull(); // below arm
        expect(e.armed).toBe(false);
        expect(observeTrail(e, 106, g.armPct, g.pullbackPct)).toBeNull(); // arms, no pullback yet
        expect(e.armed).toBe(true);
        const d = observeTrail(e, 105, g.armPct, g.pullbackPct); // gave back the point
        expect(d).not.toBeNull();
        expect(d!.action).toBe('close');
    });

    test('a tight take never trails inside the noise floor', async () => {
        const { ratchetGeometry } = await import('./profit-trail.js');
        // x = 3: exact giveback would be ~0.97% — fine; x extremely small is
        // clamped by the spread-noise floor.
        expect(ratchetGeometry(0.5).pullbackPct).toBeGreaterThanOrEqual(0.35);
    });
});

describe('bracket-atomic release (review 2026-08-23 P1)', () => {
    test('a stop from ANOTHER bracket does not authorize this target', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        const d = decideTargetRelease({ complete: true, orders: [
            { orderId: 40, orderType: 'LMT', orderRef: 'P-AAAA:tp' },
            { orderId: 41, orderType: 'STP', orderRef: 'P-BBBB:stop' },
        ] });
        expect(d.blockedReason).toBe('no-own-stop');
        expect(d.cancelIds).toEqual([]);
    });

    test('generations never cross-pair: :tp needs :stop, :tp2 needs :stop2', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        const d = decideTargetRelease({ complete: true, orders: [
            { orderId: 42, orderType: 'LMT', orderRef: 'P-AAAA:tp' },
            { orderId: 43, orderType: 'STP', orderRef: 'P-AAAA:stop2' },
        ] });
        expect(d.blockedReason).toBe('no-own-stop');
    });

    test('stacked brackets refuse the release — the multi-OCA book closePosition refuses must never be built', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        const d = decideTargetRelease({ complete: true, orders: [
            { orderId: 50, orderType: 'LMT', orderRef: 'P-AAAA:tp' },
            { orderId: 51, orderType: 'STP', orderRef: 'P-AAAA:stop' },
            { orderId: 52, orderType: 'LMT', orderRef: 'P-BBBB:tp' },
            { orderId: 53, orderType: 'STP', orderRef: 'P-BBBB:stop' },
        ] });
        expect(d.blockedReason).toBe('stacked-brackets');
        expect(d.cancelIds).toEqual([]);
        // A transitional resize book (old pair + new pair, same base) is
        // equally two OCA groups — equally refused.
        const resizing = decideTargetRelease({ complete: true, orders: [
            { orderId: 54, orderType: 'LMT', orderRef: 'P-AAAA:tp' },
            { orderId: 55, orderType: 'STP', orderRef: 'P-AAAA:stop' },
            { orderId: 56, orderType: 'LMT', orderRef: 'P-AAAA:tp2' },
            { orderId: 57, orderType: 'STP', orderRef: 'P-AAAA:stop2' },
        ] });
        expect(resizing.blockedReason).toBe('stacked-brackets');
    });

    test('an INCOMPLETE broker view releases nothing', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        const d = decideTargetRelease({ complete: false, orders: [
            { orderId: 60, orderType: 'LMT', orderRef: 'P-AAAA:tp' },
            { orderId: 61, orderType: 'STP', orderRef: 'P-AAAA:stop' },
        ] });
        expect(d.blockedReason).toBe('incomplete-book');
        expect(d.cancelIds).toEqual([]);
    });
});
