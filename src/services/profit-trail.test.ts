import { describe, expect, test } from 'bun:test';
import { observeTrail, type TrailEntry } from './profit-trail.js';

function long(basis = 100): TrailEntry {
    return { symbol: 'TEST', direction: 'long', basis, quantity: 10, best: basis, armed: false };
}

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
});
