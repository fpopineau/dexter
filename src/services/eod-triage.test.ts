import { describe, expect, test } from 'bun:test';
import { applyEarningsGuard, decideEodAction, decideGtcEarningsGuard, decideUnfilledEntryGuard, isUpcomingPrint, overnightCapWarning, priceMinutesBack, splitTriageCandidates, triageCatchUpAction, vetOvernightBook } from './eod-triage.js';

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

    test('WP5 fail-closed flip: unknown momentum on a loser, or bad prices, CLOSE (was fail-open)', () => {
        // An overnight hold must be EARNED — a position the triage cannot
        // price or read does not ride the night by default (audit crit. 9,
        // decision D2: the operator's pre-bell 'keep SYMBOL' overrides).
        const noMomentum = decideEodAction({ direction: 'long', entryFill: 100, last: 98, hourAgo: null });
        expect(noMomentum.action).toBe('close');
        expect(noMomentum.reason).toContain('keep SYMBOL');
        const noPrice = decideEodAction({ direction: 'long', entryFill: 100, last: 0, hourAgo: 99 });
        expect(noPrice.action).toBe('close');
        expect(noPrice.reason).toContain('fail-closed');
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

describe('vetOvernightBook (WP5 — the conversion book earns the night)', () => {
    const RULES = { max_overnight_exposure_pct: 30, max_overnight_position_pct: 10 };
    const NONE = new Set<string>();
    const k = (symbol: string, marketValueUsd: number | null, pnlPct: number | null) =>
        ({ symbol, label: `P-${symbol}`, marketValueUsd, pnlPct });

    test('inside both caps: everything keeps, no cap line', () => {
        const v = vetOvernightBook([k('AAA', 5_000, 1), k('BBB', 8_000, -0.5)], 100_000, RULES, NONE);
        expect(v.trims).toEqual([]);
        expect(v.capLine).toBeNull();
    });

    test('per-name breach trims that position', () => {
        const v = vetOvernightBook([k('BIG', 15_000, 2), k('OK', 5_000, 1)], 100_000, RULES, NONE);
        expect(v.trims.map((t) => t.symbol)).toEqual(['BIG']);
        expect(v.trims[0].reason).toContain('per-position overnight cap');
    });

    test('book breach trims worst-first until it fits; unknown P&L trims before any known', () => {
        // Tighter 20% book cap: 4 x 9.5k = 38k → shed to <= 20k needs TWO
        // trims — unknown P&L first, then the worst loser; the winner and
        // the mild keeper survive.
        const TIGHT = { max_overnight_exposure_pct: 20, max_overnight_position_pct: 10 };
        const v = vetOvernightBook(
            [k('WIN', 9_500, 3), k('LOSE', 9_500, -2), k('MEH', 9_500, 0.5), k('UNK', 9_500, null)],
            100_000, TIGHT, NONE,
        );
        expect(v.trims.map((t) => t.symbol)).toEqual(['UNK', 'LOSE']);
    });

    test('unpriceable position is fail-closed unless the operator armed keep', () => {
        expect(vetOvernightBook([k('NOPX', null, null)], 100_000, RULES, NONE).trims.length).toBe(1);
        const withOverride = vetOvernightBook([k('NOPX', null, null)], 100_000, RULES, new Set(['NOPX']));
        expect(withOverride.trims).toEqual([]);
    });

    test('overridden unpriceable position still COUNTS at its cost basis (REQ-EOD-001)', () => {
        // NOPX has no market price but a 25k avgCost notional; the override
        // holds it, but its exposure must still weigh on the book cap — the
        // old valueUsd:0 hole let it vanish and the book read compliant.
        const v = vetOvernightBook(
            [{ ...k('NOPX', null, null), fallbackValueUsd: 25_000 }, k('OTHER', 9_000, 1)],
            100_000, RULES, new Set(['NOPX']),
        );
        // 25k + 9k = 34% > 30% book cap → OTHER (the only trimmable) goes.
        expect(v.trims.map((t) => t.symbol)).toEqual(['OTHER']);
        expect(v.warnings.some((w) => w.includes('NOPX') && w.includes('cost basis'))).toBe(true);
    });

    test('overridden unpriceable position with no fallback is loudly uncounted (REQ-EOD-001)', () => {
        const v = vetOvernightBook(
            [{ ...k('NOPX', null, null), fallbackValueUsd: null }],
            100_000, RULES, new Set(['NOPX']),
        );
        expect(v.trims).toEqual([]);
        expect(v.warnings.some((w) => w.includes('NOPX') && w.includes('NOT counted'))).toBe(true);
    });

    test("operator override survives both caps, and the cap line says the excess is owned", () => {
        // KEEP breaches the per-name cap AND alone exceeds the book cap —
        // the override holds it through both; nothing else to trim, so the
        // excess is explicitly the operator's.
        const v = vetOvernightBook([k('KEEP', 35_000, -3)], 100_000, RULES, new Set(['KEEP']));
        expect(v.trims).toEqual([]);
        expect(v.capLine).toContain('operator overrides hold the excess');
    });

    test('an override shields only its own symbol — the rest still trims', () => {
        const v = vetOvernightBook(
            [k('KEEP', 25_000, -3), k('OTHER', 15_000, 1)],
            100_000, RULES, new Set(['KEEP']),
        );
        // OTHER still breaches the per-name cap on its own.
        expect(v.trims.map((t) => t.symbol)).toEqual(['OTHER']);
    });

    test('NetLiq unavailable: no blind mass-close — loud warning instead (recorded deviation)', () => {
        const v = vetOvernightBook([k('AAA', 5_000, 1)], null, RULES, NONE);
        expect(v.trims).toEqual([]);
        expect(v.capLine).toContain('UNVETTED');
    });
});

describe('applyLookupFailurePolicy (REQ-EOD-002 — a failed calendar cannot silently wave keeps through)', () => {
    const keep = { action: 'keep' as const, reason: 'winning 2.00%' };
    const close = { action: 'close' as const, reason: 'losing and fading' };

    test('lookup fine: decisions pass through untouched', async () => {
        const { applyLookupFailurePolicy } = await import('./eod-triage.js');
        expect(applyLookupFailurePolicy(keep, false, false)).toEqual(keep);
        expect(applyLookupFailurePolicy(close, false, true)).toEqual(close);
    });

    test('lookup failed: a keep without an override fails closed', async () => {
        const { applyLookupFailurePolicy } = await import('./eod-triage.js');
        const d = applyLookupFailurePolicy(keep, true, false);
        expect(d.action).toBe('close');
        expect(d.reason).toContain('lookup failed');
        expect(d.reason).toContain("keep");
    });

    test('lookup failed: closes stay closes; an override holds the keep with the risk named', async () => {
        const { applyLookupFailurePolicy } = await import('./eod-triage.js');
        expect(applyLookupFailurePolicy(close, true, false).action).toBe('close');
        const held = applyLookupFailurePolicy(keep, true, true);
        expect(held.action).toBe('keep');
        expect(held.reason).toContain('unverifiable');
    });
});

describe('priceMinutesBack (WP11 — timestamp arithmetic, not index arithmetic)', () => {
    // IBKR intraday format; frame converter from the outcome tracker.
    const frame = (t: string | undefined) => {
        const m = /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec((t ?? '').trim());
        return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
    };
    const bar = (hhmm: string, close: number) => ({ time: `20260814  ${hhmm}:00`, close });

    test('gapless series: returns the close from exactly N minutes back', () => {
        const bars = Array.from({ length: 120 }, (_, i) =>
            bar(`${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`, 100 + i));
        expect(priceMinutesBack(bars, 60, frame)).toBe(100 + 59); // 60 min before the last bar
    });

    test('gappy series (thin name): finds the bar AT OR BEFORE the target time', () => {
        // Prints at 10:00, 10:05, 14:00 — an hour before 14:00 is 13:00;
        // the last print at/before 13:00 is 10:05. Index arithmetic would
        // have grabbed whatever sat 60 slots back (out of range → first bar).
        const bars = [bar('10:00', 50), bar('10:05', 51), bar('14:00', 60)];
        expect(priceMinutesBack(bars, 60, frame)).toBe(51);
    });

    test('series shorter than the lookback: null, never the first print', () => {
        const bars = [bar('15:30', 99), bar('15:31', 100)];
        expect(priceMinutesBack(bars, 60, frame)).toBeNull();
    });
});
