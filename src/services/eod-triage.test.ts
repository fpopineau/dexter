import { describe, expect, test } from 'bun:test';
import { applyEarningsGuard, decideEodAction, decideGtcEarningsGuard, decideUnfilledEntryGuard, isUpcomingPrint, overnightCapWarning, splitTriageCandidates, triageCatchUpAction } from './eod-triage.js';

describe('triageCatchUpAction (missed 15:52 slot — SECZ post-mortem 2026-08-13)', () => {
    const min = (h: number, m: number) => h * 60 + m;

    test('boot before the slot: the cron will fire — do nothing', () => {
        expect(triageCatchUpAction(min(9, 40), false, true)).toBe('none');
        expect(triageCatchUpAction(min(15, 51), false, true)).toBe('none');
    });

    test('boot in the missed window before the bell: run late (decisions still actionable at RTH prices)', () => {
        expect(triageCatchUpAction(min(15, 52), false, true)).toBe('run-late');
        expect(triageCatchUpAction(min(15, 59), false, true)).toBe('run-late');
    });

    test('the SECZ case: boot at 16:00 with the slot missed → loud alert, never a silent skip', () => {
        expect(triageCatchUpAction(min(16, 0), false, true)).toBe('alert-missed');
        expect(triageCatchUpAction(min(20, 30), false, true)).toBe('alert-missed');
    });

    test('already ran today: nothing, at any hour', () => {
        expect(triageCatchUpAction(min(15, 55), true, true)).toBe('none');
        expect(triageCatchUpAction(min(18, 0), true, true)).toBe('none');
    });

    test('weekends and holidays: nothing', () => {
        expect(triageCatchUpAction(min(15, 55), false, false)).toBe('none');
        expect(triageCatchUpAction(min(17, 0), false, false)).toBe('none');
    });

    test('half-day (13:00 close): the window tracks the real bell, not 16:00 (audit 2026-08-20)', () => {
        const HALF = min(13, 0);
        // Before the 12:52 slot: cron will fire.
        expect(triageCatchUpAction(min(12, 51), false, true, HALF)).toBe('none');
        // In the missed window before the 13:00 bell: run late.
        expect(triageCatchUpAction(min(12, 52), false, true, HALF)).toBe('run-late');
        expect(triageCatchUpAction(min(12, 59), false, true, HALF)).toBe('run-late');
        // After the 13:00 bell: alert — with the old hard-coded 16:00 close
        // this returned 'none' and 15:52 quietly triaged a dead session.
        expect(triageCatchUpAction(min(13, 0), false, true, HALF)).toBe('alert-missed');
        expect(triageCatchUpAction(min(15, 52), false, true, HALF)).toBe('alert-missed');
    });
});

describe('decideUnfilledEntryGuard (entry-side accidental earnings bets)', () => {
    const TODAY_ISO = '2026-08-11';

    test('a resting swing entry with a print ahead is cancelled, with the gap rationale', () => {
        const reason = decideUnfilledEntryGuard('swing', { date: '2026-08-12', time: 'pre-market' }, TODAY_ISO);
        expect(reason).toContain('cancelling the resting swing entry');
        expect(reason).toContain('INTO the reaction');
    });

    test('intraday GTC setups get the same guard', () => {
        expect(decideUnfilledEntryGuard('intraday', { date: '2026-08-11', time: 'after-hours' }, TODAY_ISO)).toContain('cancelling');
    });

    test('earnings-bet entries are exempt — gap-sized by design', () => {
        expect(decideUnfilledEntryGuard('earnings-bet', { date: '2026-08-11', time: 'after-hours' }, TODAY_ISO)).toBeNull();
    });

    test('no print, or a past BMO print today, leaves the entry resting', () => {
        expect(decideUnfilledEntryGuard('swing', null, TODAY_ISO)).toBeNull();
        expect(decideUnfilledEntryGuard('swing', { date: TODAY_ISO, time: 'pre-market' }, TODAY_ISO)).toBeNull();
    });
});

describe('overnightCapWarning (cap usage visible, never force-trimmed)', () => {
    const CAPS = { max_overnight_exposure_pct: 30, max_overnight_position_pct: 3 };

    test('inside both caps → silent', () => {
        expect(overnightCapWarning(
            [{ symbol: 'AAPL', valueUsd: 2_500 }, { symbol: 'MU', valueUsd: 2_000 }],
            100_000,
            CAPS,
        )).toBeNull();
    });

    test('an oversized keep is named against the per-position cap', () => {
        const line = overnightCapWarning([{ symbol: 'NVDA', valueUsd: 5_000 }], 100_000, CAPS);
        expect(line).toContain('NVDA is 5.0%');
        expect(line).toContain('3% per-position');
    });

    test('a book past the total cap is flagged with its percentage', () => {
        const holds = Array.from({ length: 11 }, (_, i) => ({ symbol: `S${i}`, valueUsd: 2_900 }));
        const line = overnightCapWarning(holds, 100_000, CAPS);
        expect(line).toContain('31.9% of NetLiq');
        expect(line).toContain('30% cap');
    });

    test('no NetLiq → honest could-not-verify, never silence with holds on', () => {
        expect(overnightCapWarning([{ symbol: 'AAPL', valueUsd: 1 }], null, CAPS)).toContain('could NOT be verified');
        expect(overnightCapWarning([], null, CAPS)).toBeNull();
    });
});

describe('splitTriageCandidates (kept-overnight holds re-enter momentum triage)', () => {
    const mk = (tif: 'DAY' | 'GTC', entryFillPrice: number | null, keptOvernightAt: number | null = null) =>
        ({ tif, entryFillPrice, keptOvernightAt });

    test('filled DAY brackets → momentum lane; deliberate GTC → guard-only lane', () => {
        const day = mk('DAY', 100);
        const swing = mk('GTC', 50);
        const { momentum, guardOnly } = splitTriageCandidates([day, swing]);
        expect(momentum).toEqual([day]);
        expect(guardOnly).toEqual([swing]);
    });

    test('a kept-overnight hold (GTC via EOD-keep conversion) is momentum-triaged daily — it must re-earn every night', () => {
        const kept = mk('GTC', 100, Date.now());
        const { momentum, guardOnly } = splitTriageCandidates([kept]);
        expect(momentum).toEqual([kept]);
        expect(guardOnly).toEqual([]);
    });

    test('unfilled GTC entries land in their own lane; unfilled DAY entries die at the bell (no lane)', () => {
        const restingGtc = mk('GTC', null);
        const dyingDay = mk('DAY', null);
        const { momentum, guardOnly, unfilledGtc } = splitTriageCandidates([dyingDay, restingGtc]);
        expect(momentum).toEqual([]);
        expect(guardOnly).toEqual([]);
        expect(unfilledGtc).toEqual([restingGtc]);
    });
});

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
