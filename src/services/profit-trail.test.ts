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

    test('a single coherent pair releases its target — brackets, protect pairs, resized pairs (REQ-TRAIL-001/003)', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        const leg = (orderId: number, orderType: string, orderRef: string, over: object = {}) =>
            ({ orderId, orderType, orderRef, ocaGroup: 'G1', account: 'DU1', quantity: 10, ...over });
        const v = (orders: unknown[], complete = true) => ({ orders: orders as never[], complete });

        const bracket = decideTargetRelease(v([leg(1, 'LMT', 'P-1A2B:tp'), leg(2, 'STP', 'P-1A2B:stop')]), 10);
        expect(bracket.cancelIds).toEqual([1]);
        expect(bracket.blockedReason).toBeNull();
        const protect = decideTargetRelease(v([leg(3, 'STP', 'protect-XYZ:stop'), leg(4, 'LMT', 'protect-XYZ:tp')]), 10);
        expect(protect.cancelIds).toEqual([4]);
        const resized = decideTargetRelease(v([leg(5, 'LMT', 'P-9F06:tp2'), leg(6, 'STP LMT', 'P-9F06:stop2')]), 10);
        expect(resized.cancelIds).toEqual([5]);
        // STP LMT alone is a stop, never a target.
        expect(decideTargetRelease(v([leg(7, 'STP LMT', 'P-1A2B:stop')]), 10).blockedReason).toBe('no-targets');
    });

    test('ANY foreign exit-side order blocks the release (REQ-TRAIL-001 + round-10 close doctrine)', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        const leg = (orderId: number, orderType: string, orderRef: string | null, over: object = {}) =>
            ({ orderId, orderType, orderRef, ocaGroup: 'G1', account: 'DU1', quantity: 10, ...over });
        const v = (orders: unknown[]) => ({ orders: orders as never[], complete: true });
        // closePosition refuses to exit around foreign orders — runner mode
        // must not enter a state its own exit path refuses.
        const d = decideTargetRelease(v([
            leg(10, 'LMT', null),
            leg(12, 'LMT', 'P-9F00:tp'),
            leg(13, 'STP', 'P-9F00:stop'),
        ]), 10);
        expect(d.blockedReason).toBe('foreign-orders');
        expect(d.cancelIds).toEqual([]);
        expect(d.foreignRefs).toEqual(['#10 LMT <no ref>']);
    });

    test('cross-bracket stops, generation mismatches and orphan legs never authorize a release (REQ-TRAIL-003/004)', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        const leg = (orderId: number, orderType: string, orderRef: string, over: object = {}) =>
            ({ orderId, orderType, orderRef, ocaGroup: 'G1', account: 'DU1', quantity: 10, ...over });
        const v = (orders: unknown[]) => ({ orders: orders as never[], complete: true });
        // A stop from ANOTHER bracket is not this target's protection.
        expect(decideTargetRelease(v([leg(20, 'LMT', 'P-AAAA:tp'), leg(21, 'STP', 'P-BBBB:stop')]), 10).blockedReason)
            .toBe('no-own-stop');
        // Generations never cross-pair.
        expect(decideTargetRelease(v([leg(22, 'LMT', 'P-AAAA:tp'), leg(23, 'STP', 'P-AAAA:stop2')]), 10).blockedReason)
            .toBe('no-own-stop');
        // A reduce- limit next to the pair is an extra OUR leg — incoherent.
        expect(decideTargetRelease(v([
            leg(24, 'LMT', 'reduce-XYZ'), leg(25, 'LMT', 'P-9F04:tp'), leg(26, 'STP', 'P-9F04:stop'),
        ]), 10).blockedReason).toBe('incoherent-book');
        // A complete pair PLUS an orphan stop is not a single pair.
        expect(decideTargetRelease(v([
            leg(27, 'LMT', 'P-AAAA:tp'), leg(28, 'STP', 'P-AAAA:stop'), leg(29, 'STP', 'P-CCCC:stop'),
        ]), 10).blockedReason).toBe('stacked-brackets');
        // Two full pairs (stacked theses, or a transitional resize book).
        expect(decideTargetRelease(v([
            leg(30, 'LMT', 'P-AAAA:tp'), leg(31, 'STP', 'P-AAAA:stop'),
            leg(32, 'LMT', 'P-BBBB:tp'), leg(33, 'STP', 'P-BBBB:stop'),
        ]), 10).blockedReason).toBe('stacked-brackets');
    });

    test('OCA-group, account and quantity identity are required — unknowns fail closed (review 2026-08-23 P2)', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        const leg = (orderId: number, orderType: string, orderRef: string, over: object = {}) =>
            ({ orderId, orderType, orderRef, ocaGroup: 'G1', account: 'DU1', quantity: 10, ...over });
        const v = (orders: unknown[]) => ({ orders: orders as never[], complete: true });
        // Different OCA groups: the legs are not each other's siblings.
        expect(decideTargetRelease(v([
            leg(40, 'LMT', 'P-AA10:tp'), leg(41, 'STP', 'P-AA10:stop', { ocaGroup: 'G2' }),
        ]), 10).blockedReason).toBe('incoherent-book');
        // Unknown group or account: identity unproven.
        expect(decideTargetRelease(v([
            leg(42, 'LMT', 'P-AA20:tp', { ocaGroup: null }), leg(43, 'STP', 'P-AA20:stop'),
        ]), 10).blockedReason).toBe('incoherent-book');
        expect(decideTargetRelease(v([
            leg(44, 'LMT', 'P-AA30:tp'), leg(45, 'STP', 'P-AA30:stop', { account: 'DU2' }),
        ]), 10).blockedReason).toBe('incoherent-book');
        // The stop must cover the position; unknown quantity fails closed.
        expect(decideTargetRelease(v([
            leg(46, 'LMT', 'P-AA40:tp'), leg(47, 'STP', 'P-AA40:stop', { quantity: 5 }),
        ]), 10).blockedReason).toBe('stop-undersized');
        expect(decideTargetRelease(v([
            leg(48, 'LMT', 'P-AA50:tp'), leg(49, 'STP', 'P-AA50:stop', { quantity: null }),
        ]), 10).blockedReason).toBe('stop-undersized');
    });

    test('an INCOMPLETE broker view releases nothing', async () => {
        const { decideTargetRelease } = await import('./profit-trail.js');
        const d = decideTargetRelease({ complete: false, orders: [
            { orderId: 60, orderType: 'LMT', orderRef: 'P-AAAA:tp', ocaGroup: 'G1', account: 'DU1', quantity: 10 },
            { orderId: 61, orderType: 'STP', orderRef: 'P-AAAA:stop', ocaGroup: 'G1', account: 'DU1', quantity: 10 },
        ] }, 10);
        expect(d.blockedReason).toBe('incomplete-book');
        expect(d.cancelIds).toEqual([]);
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
