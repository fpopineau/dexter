import { describe, expect, test } from 'bun:test';
import { orderArchiveUniverse } from './archive-scheduler.js';

describe('orderArchiveUniverse (REQ-BENCH-007 — priority under the cap)', () => {
    test('watchlist, today\'s proposals, open GTC rows, prior-day candidates, then the snapshot; case-folded, de-duplicated, capped with a count', () => {
        const r = orderArchiveUniverse({
            watchlist: ['spy', 'QQQ'],
            proposals: ['MU', 'qqq'],
            openGtc: ['AMD'],
            priorCandidates: ['NVDA', 'MU'],
            snapshot: ['TSLA', 'AAPL', 'META'],
        }, 6);
        expect(r.symbols).toEqual(['SPY', 'QQQ', 'MU', 'AMD', 'NVDA', 'TSLA']);
        expect(r.dropped).toBe(2);
    });

    test('an empty universe stays empty; nothing dropped under the cap', () => {
        expect(orderArchiveUniverse({ watchlist: [], proposals: [], openGtc: [], priorCandidates: [], snapshot: [] }, 30)).toEqual({ symbols: [], dropped: 0 });
        expect(orderArchiveUniverse({ watchlist: ['SPY'], proposals: [], openGtc: [], priorCandidates: [], snapshot: ['MU'] }, 30)).toEqual({ symbols: ['SPY', 'MU'], dropped: 0 });
    });
});
