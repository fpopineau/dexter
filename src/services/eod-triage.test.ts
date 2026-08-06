import { describe, expect, test } from 'bun:test';
import { applyEarningsGuard, decideEodAction, decideGtcEarningsGuard, isUpcomingPrint } from './eod-triage.js';

const TODAY = '2026-08-05';

describe('EOD triage decision', () => {
    test('losing AND fading → close (the operator rule)', () => {
        const d = decideEodAction({ direction: 'long', entryFill: 193.11, last: 191.2, hourAgo: 192.4 });
        expect(d.action).toBe('close');
        expect(d.reason).toContain('losing');
        expect(d.reason).toContain('fading');
    });

    test('losing but stabilizing/recovering → keep', () => {
        const d = decideEodAction({ direction: 'long', entryFill: 193.11, last: 191.2, hourAgo: 190.5 });
        expect(d.action).toBe('keep');
        expect(d.reason).toContain('stabilizing');
    });

    test('winning → keep, regardless of momentum', () => {
        expect(decideEodAction({ direction: 'long', entryFill: 193.11, last: 196, hourAgo: 197 }).action).toBe('keep');
        expect(decideEodAction({ direction: 'long', entryFill: 193.11, last: 196, hourAgo: 195 }).action).toBe('keep');
    });

    test('short positions mirror: losing = price above fill, fading = still rising', () => {
        expect(decideEodAction({ direction: 'short', entryFill: 100, last: 101.5, hourAgo: 100.8 }).action).toBe('close');
        expect(decideEodAction({ direction: 'short', entryFill: 100, last: 101.5, hourAgo: 102.2 }).action).toBe('keep');
        expect(decideEodAction({ direction: 'short', entryFill: 100, last: 98.5, hourAgo: 98 }).action).toBe('keep');
    });

    test('unknown momentum or bad prices never close — doubt favors holding', () => {
        expect(decideEodAction({ direction: 'long', entryFill: 100, last: 98, hourAgo: null }).action).toBe('keep');
        expect(decideEodAction({ direction: 'long', entryFill: 100, last: 0, hourAgo: 99 }).action).toBe('keep');
    });

    test('exactly breakeven counts as winning (kept)', () => {
        expect(decideEodAction({ direction: 'long', entryFill: 100, last: 100, hourAgo: 101 }).action).toBe('keep');
    });
});

describe('earnings guard (the SNDK rule: never hold a print unintentionally)', () => {
    test('a WINNING keep is overridden to close when the symbol reports', () => {
        const base = decideEodAction({ direction: 'long', entryFill: 100, last: 104, hourAgo: 103 });
        expect(base.action).toBe('keep'); // winning — would hold overnight
        const guarded = applyEarningsGuard(base, { date: '2026-08-05', time: 'after-hours' }, TODAY);
        expect(guarded.action).toBe('close');
        expect(guarded.reason).toContain('earnings guard');
        expect(guarded.reason).toContain('would otherwise keep');
    });

    test('a losing-and-fading close stays a close, reason becomes the guard', () => {
        const base = decideEodAction({ direction: 'long', entryFill: 100, last: 97, hourAgo: 98 });
        expect(base.action).toBe('close');
        const guarded = applyEarningsGuard(base, { date: '2026-08-06', time: 'pre-market' }, TODAY);
        expect(guarded.action).toBe('close');
        expect(guarded.reason).toContain('flat before the print');
    });

    test('no earnings → base decision passes through untouched', () => {
        const base = decideEodAction({ direction: 'short', entryFill: 100, last: 98, hourAgo: 99 });
        expect(applyEarningsGuard(base, null, TODAY)).toEqual(base);
    });

    test('unknown report timing still closes, without printing "unknown"', () => {
        const guarded = applyEarningsGuard(
            { action: 'keep', reason: 'winning' },
            { date: '2026-08-05', time: 'unknown' },
            TODAY,
        );
        expect(guarded.action).toBe('close');
        expect(guarded.reason).not.toContain('unknown');
    });
});

describe('past-print exemption (the reaction-trade rule)', () => {
    test('a BMO print TODAY already happened — the guard must not fire', () => {
        // The post-print reaction day-trade: symbol reported this morning,
        // position opened on the reaction. Yesterday this was force-closed
        // with "flat before the print" — the print was 7 hours in the past.
        const base = decideEodAction({ direction: 'long', entryFill: 100, last: 104, hourAgo: 103 });
        const guarded = applyEarningsGuard(base, { date: TODAY, time: 'pre-market' }, TODAY);
        expect(guarded).toEqual(base); // untouched — holds overnight, protected
    });

    test('a print TODAY after-hours is still ahead — guard fires', () => {
        expect(isUpcomingPrint({ date: TODAY, time: 'after-hours' }, TODAY)).toBe(true);
    });

    test('unknown timing TODAY stays conservative — guard fires', () => {
        expect(isUpcomingPrint({ date: TODAY, time: 'unknown' }, TODAY)).toBe(true);
    });

    test('a pre-market print TOMORROW is ahead — guard fires', () => {
        expect(isUpcomingPrint({ date: '2026-08-06', time: 'pre-market' }, TODAY)).toBe(true);
    });

    test('only today + pre-market is a past print', () => {
        expect(isUpcomingPrint({ date: TODAY, time: 'pre-market' }, TODAY)).toBe(false);
    });
});

describe('GTC earnings guard (rule 4 made deterministic for swings)', () => {
    const tomorrowAmc = { date: '2026-08-06', time: 'after-hours' as const };

    test('a swing with a print inside the window is forced flat', () => {
        const d = decideGtcEarningsGuard('swing', tomorrowAmc, TODAY);
        expect(d?.action).toBe('close');
        expect(d?.reason).toContain('swing position must be flat before the print');
        expect(d?.reason).toContain('explicit earnings-bet');
    });

    test('a GTC overnight setup (intraday class) gets the same guard', () => {
        const d = decideGtcEarningsGuard('intraday', tomorrowAmc, TODAY);
        expect(d?.action).toBe('close');
    });

    test('an earnings bet is NEVER touched — holding the print is the point', () => {
        expect(decideGtcEarningsGuard('earnings-bet', tomorrowAmc, TODAY)).toBeNull();
        expect(decideGtcEarningsGuard('earnings-bet', { date: TODAY, time: 'after-hours' }, TODAY)).toBeNull();
    });

    test('no print, or a past BMO print today → nothing to do', () => {
        expect(decideGtcEarningsGuard('swing', null, TODAY)).toBeNull();
        expect(decideGtcEarningsGuard('swing', { date: TODAY, time: 'pre-market' }, TODAY)).toBeNull();
    });
});
