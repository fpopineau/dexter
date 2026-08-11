import { describe, expect, test } from 'bun:test';
import {
    classifyMacroTitle,
    macroNightWarning,
    parseGammaEvents,
    parsePriceArray,
    selectEarningsMarket,
    selectMacroEvents,
    topOutcomeOf,
    uncertaintyFrom,
    type MacroEvent,
} from './event-risk.js';

// Shapes captured from the live Gamma API on 2026-08-11.
const CPI_EVENT = {
    title: 'July Inflation US - Annual',
    slug: 'july-inflation-us-annual',
    endDate: '2026-08-12T00:00:00Z',
    closed: false,
    volume24hr: 45_860,
    markets: [
        { question: 'Will annual inflation be 3.1% or less in July?', groupItemTitle: '3.1% or less', outcomes: '["Yes", "No"]', outcomePrices: '["0.054", "0.946"]' },
        { question: 'Will annual inflation be 3.3% in July?', groupItemTitle: '3.3%', outcomes: '["Yes", "No"]', outcomePrices: '["0.325", "0.675"]' },
        { question: 'Will annual inflation be 3.4% in July?', groupItemTitle: '3.4%', outcomes: '["Yes", "No"]', outcomePrices: '["0.385", "0.615"]' },
        { question: 'Will annual inflation be 3.5% in July?', groupItemTitle: '3.5%', outcomes: '["Yes", "No"]', outcomePrices: '["0.155", "0.845"]' },
    ],
};

const FED_SEPT_EVENT = {
    title: 'Fed Decision in September?',
    slug: 'fed-decision-in-september-762',
    endDate: '2026-09-16T00:00:00Z',
    closed: false,
    volume24hr: 3_281_965,
    markets: [
        { question: 'Will the Fed decrease interest rates by 50+ bps after the September 2026 meeting?', outcomes: '["Yes", "No"]', outcomePrices: '["0.05", "0.95"]' },
        { question: 'No change in Fed interest rates after the September 2026 meeting?', outcomes: '["Yes", "No"]', outcomePrices: '["0.92", "0.08"]' },
    ],
};

const CUMULATIVE_EVENT = {
    title: 'How many Fed rate cuts in 2026?',
    endDate: '2026-08-12T00:00:00Z', // deliberately near-dated: must still be rejected
    closed: false,
    volume24hr: 68_717,
    markets: [],
};

const NONMACRO_EVENT = {
    title: 'Largest Company end of August?',
    endDate: '2026-08-12T00:00:00Z',
    closed: false,
    volume24hr: 183_616,
    markets: [],
};

// 20:00 ET on 2026-08-11 — CPI-eve.
const NOW = new Date('2026-08-12T00:00:00Z');

describe('classifyMacroTitle', () => {
    test('dated releases classify; cumulative and non-macro do not', () => {
        expect(classifyMacroTitle('July Inflation US - Annual')).toBe('inflation');
        expect(classifyMacroTitle('Core CPI MoM - July 2026')).toBe('inflation');
        expect(classifyMacroTitle('Fed Decision in September?')).toBe('fed');
        expect(classifyMacroTitle('Bank of Japan Decision in September?')).toBe('central-bank');
        expect(classifyMacroTitle('ECB Interest Rates: September 2026')).toBe('central-bank');
        expect(classifyMacroTitle('How many Fed rate cuts in 2026?')).toBeNull();
        expect(classifyMacroTitle('Fed rate hike in 2026?')).toBeNull();
        expect(classifyMacroTitle('Largest Company end of August?')).toBeNull();
        expect(classifyMacroTitle('US recession in 2026?')).toBeNull();
        expect(classifyMacroTitle('Strait of Hormuz traffic returns to normal by December 31?')).toBeNull();
    });
});

describe('parsePriceArray', () => {
    test('decodes the JSON-string quirk; rejects junk', () => {
        expect(parsePriceArray('["0.47", "0.53"]')).toEqual([0.47, 0.53]);
        expect(parsePriceArray('not json')).toBeNull();
        expect(parsePriceArray(undefined)).toBeNull();
        expect(parsePriceArray('["a","b"]')).toBeNull();
    });
});

describe('topOutcomeOf + uncertaintyFrom', () => {
    test('dispersed CPI brackets → high uncertainty on the 3.4% bucket', () => {
        const top = topOutcomeOf(CPI_EVENT.markets);
        expect(top?.label).toBe('3.4%');
        expect(top?.probability).toBeCloseTo(0.385);
        expect(uncertaintyFrom(top)).toBe('high');
    });

    test('a 92% consensus bucket → low uncertainty', () => {
        const top = topOutcomeOf(FED_SEPT_EVENT.markets);
        expect(top?.probability).toBeCloseTo(0.92);
        expect(uncertaintyFrom(top)).toBe('low');
    });

    test('no priced markets → unknown', () => {
        expect(uncertaintyFrom(topOutcomeOf([]))).toBe('unknown');
    });
});

describe('selectMacroEvents', () => {
    const raw = parseGammaEvents([CPI_EVENT, FED_SEPT_EVENT, CUMULATIVE_EVENT, NONMACRO_EVENT]);

    test('keeps only dated macro events inside the horizon', () => {
        const events = selectMacroEvents(raw, 2, NOW);
        expect(events.length).toBe(1);
        expect(events[0].title).toBe('July Inflation US - Annual');
        expect(events[0].category).toBe('inflation');
        expect(events[0].uncertainty).toBe('high');
    });

    test('endDate midnight-UTC maps to the UTC release day, not the ET eve', () => {
        // 2026-08-12T00:00:00Z is 20:00 ET on 08-11; the release day is 08-12.
        const events = selectMacroEvents(raw, 2, NOW);
        expect(events[0].date).toBe('2026-08-12');
        expect(events[0].daysAway).toBe(1);
    });

    test('a wider horizon picks up the September Fed decision', () => {
        const events = selectMacroEvents(raw, 40, NOW);
        expect(events.map((e) => e.category)).toEqual(['inflation', 'fed']);
    });
});

describe('selectEarningsMarket', () => {
    // Live shapes from public-search?q=STUB (2026-08-11): the open beat
    // market, a closed prior-quarter market, and the Finnish presidential
    // election (matched via candidate "Stubb") that a loose matcher takes.
    const raw = parseGammaEvents({
        events: [
            {
                title: 'Will Stubhub Holdings (STUB) beat quarterly earnings?',
                slug: 'will-stubhub-holdings-stub-beat-quarterly-earnings',
                endDate: '2026-08-12T00:00:00Z',
                closed: false,
                volume: 2059.23,
                markets: [{
                    question: 'Will Stubhub Holdings (STUB) beat quarterly earnings?',
                    outcomes: '["Yes", "No"]',
                    outcomePrices: '["0.47", "0.53"]',
                    lastTradePrice: 0.47,
                    closed: false,
                }],
            },
            {
                title: 'Will StubHub (STUB) beat quarterly earnings?',
                endDate: '2026-03-04T00:00:00Z',
                closed: true,
                volume: 5_000,
                markets: [{ question: 'Will StubHub (STUB) beat quarterly earnings?', outcomes: '["Yes", "No"]', outcomePrices: '["0", "1"]', closed: true }],
            },
            {
                title: 'Finland Presidential Election Winner',
                endDate: '2024-02-11T00:00:00Z',
                closed: true,
                volume: 700_000,
                markets: [{ question: 'Finnish Presidential Election: Will Alexander Stubb win?', outcomes: '["Yes", "No"]', outcomePrices: '["1", "0"]' }],
            },
        ],
    });

    test('finds the open beat market and its implied probability', () => {
        const signal = selectEarningsMarket(raw, 'stub', NOW);
        expect(signal).not.toBeNull();
        expect(signal!.symbol).toBe('STUB');
        expect(signal!.beatProbability).toBeCloseTo(0.47);
        expect(signal!.endDate).toBe('2026-08-12');
        expect(signal!.url).toContain('polymarket.com/event/');
    });

    test('ignores election noise, closed markets, and unknown symbols', () => {
        expect(selectEarningsMarket(raw, 'HIMS', NOW)).toBeNull();
        // The Finland event is the only match candidate for a loose matcher;
        // the strict one returns null for a symbol with no open market.
        expect(selectEarningsMarket(raw, 'STUBB', NOW)).toBeNull();
    });

    test('dust markets below the volume floor are not evidence', () => {
        const dust = parseGammaEvents([{
            title: 'Will Tiny Corp (TINY) beat quarterly earnings?',
            endDate: '2026-08-12T00:00:00Z',
            closed: false,
            volume: 120,
            markets: [{ question: 'Will Tiny Corp (TINY) beat quarterly earnings?', outcomes: '["Yes", "No"]', outcomePrices: '["0.6", "0.4"]', closed: false }],
        }]);
        expect(selectEarningsMarket(dust, 'TINY', NOW)).toBeNull();
    });
});

describe('macroNightWarning', () => {
    const cpi: MacroEvent = {
        title: 'July Inflation US - Annual', category: 'inflation',
        date: '2026-08-12', daysAway: 1,
        topOutcome: { label: '3.4%', probability: 0.385 },
        uncertainty: 'high', volume24h: 45_860,
    };

    test('names tomorrow-resolving events with their consensus', () => {
        const line = macroNightWarning([cpi]);
        expect(line).toContain('July Inflation US - Annual');
        expect(line).toContain('tomorrow');
        expect(line).toContain('39%');
        expect(line).toContain('high uncertainty');
    });

    test('silent when the horizon is clear; honest when data is missing', () => {
        expect(macroNightWarning([{ ...cpi, daysAway: 2 }])).toBeNull();
        expect(macroNightWarning([])).toBeNull();
        expect(macroNightWarning(null)).toContain('unavailable');
    });
});

describe('parseGammaEvents', () => {
    test('accepts arrays, search envelopes, and junk', () => {
        expect(parseGammaEvents([CPI_EVENT]).length).toBe(1);
        expect(parseGammaEvents({ events: [CPI_EVENT] }).length).toBe(1);
        expect(parseGammaEvents(null)).toEqual([]);
        expect(parseGammaEvents({ nope: true })).toEqual([]);
        expect(parseGammaEvents([null, CPI_EVENT])).toEqual([CPI_EVENT]);
    });
});
