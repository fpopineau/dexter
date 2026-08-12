import { describe, expect, test } from 'bun:test';
import {
    attributePulse,
    buildGdeltQuery,
    chunkWatch,
    cleanCompanyName,
    parseGdeltResponse,
    type GdeltArticle,
} from './news-pulse.js';

describe('chunkWatch (micro-batches — GDELT refuses big OR queries)', () => {
    test('splits into request-sized batches, remainder last', () => {
        expect(chunkWatch([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
        expect(chunkWatch([1, 2], 3)).toEqual([[1, 2]]);
        expect(chunkWatch([], 3)).toEqual([]);
    });

    test('a degenerate batch size still makes progress', () => {
        expect(chunkWatch([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    });
});

describe('cleanCompanyName', () => {
    test('strips listing suffixes and legal forms', () => {
        expect(cleanCompanyName('Micron Technology, Inc. - Common Stock')).toBe('Micron Technology');
        expect(cleanCompanyName('Artius II Acquisition Inc. - Class A Ordinary Shares')).toBe('Artius II Acquisition');
        expect(cleanCompanyName('Advanced Micro Devices, Inc.')).toBe('Advanced Micro Devices');
        expect(cleanCompanyName('StubHub Holdings, Inc.')).toBe('StubHub');
        expect(cleanCompanyName('NVIDIA Corporation - Common Stock')).toBe('NVIDIA');
    });

    test('never strips down to one generic or too-short word', () => {
        // "Target" alone would match every news headline with the word.
        expect(cleanCompanyName('Target Corporation')).toBe('Target Corporation');
        expect(cleanCompanyName('Visa Inc.')).toBe('Visa Inc.'); // 4 chars — too short to trust alone
    });

    test('empty input → null', () => {
        expect(cleanCompanyName('')).toBeNull();
        expect(cleanCompanyName(' - Common Stock')).toBeNull();
    });
});

describe('buildGdeltQuery', () => {
    test('quotes names, joins with OR, restricts language', () => {
        expect(buildGdeltQuery(['Micron Technology', 'Nvidia'])).toBe(
            '("Micron Technology" OR "Nvidia") sourcelang:english',
        );
    });

    test('strips embedded quotes that would break the query', () => {
        expect(buildGdeltQuery(['Weird "Quoted" Name'])).toBe('("Weird Quoted Name") sourcelang:english');
    });
});

describe('parseGdeltResponse', () => {
    test('parses the artlist JSON shape', () => {
        const res = parseGdeltResponse(JSON.stringify({
            articles: [
                { url: 'https://x.test/a', title: 'Micron Technology surges on guidance', domain: 'x.test', seendate: '20260811T131500Z' },
                { broken: true },
            ],
        }));
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.articles.length).toBe(1);
            expect(res.articles[0].domain).toBe('x.test');
        }
    });

    test('the plain-text throttle answer is degraded, NOT a quiet news day', () => {
        // Verbatim GDELT throttle response, observed live 2026-08-11.
        const res = parseGdeltResponse('Please limit requests to one every 5 seconds or contact ...');
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toContain('Please limit');
    });

    test('empty and junk responses are degraded too', () => {
        expect(parseGdeltResponse('').ok).toBe(false);
        expect(parseGdeltResponse('{not json').ok).toBe(false);
    });
});

describe('attributePulse', () => {
    const watch = [
        { symbol: 'MU', name: 'Micron Technology' },
        { symbol: 'NVDA', name: 'Nvidia' },
    ];
    const art = (title: string, domain: string): GdeltArticle => ({ title, domain, seendate: '20260811T131500Z', url: `https://${domain}/x` });

    test('attributes by name-in-title; a broad story goes hot', () => {
        const pulse = attributePulse(
            [
                art('Micron Technology surges after guidance raise', 'reuters.test'),
                art('Why Micron Technology stock is moving today', 'fool.test'),
                art('Micron Technology price target raised at two banks', 'bloomberg.test'),
                art('Chip names rally: Micron Technology leads', 'cnbc.test'),
                art('Unrelated market wrap', 'reuters.test'),
            ],
            watch,
            { minArticles: 4, minDomains: 3 },
        );
        expect(pulse.MU.articles).toBe(4);
        expect(pulse.MU.domains).toBe(4);
        expect(pulse.MU.hot).toBe(true);
        expect(pulse.MU.headlines.length).toBe(3);
        expect(pulse.NVDA.articles).toBe(0);
        expect(pulse.NVDA.hot).toBe(false);
    });

    test('one wire story syndicated to 40 outlets is NOT hot', () => {
        const copies = Array.from({ length: 40 }, (_, i) =>
            art('Micron Technology announces quarterly results', `local${i}.test`));
        const pulse = attributePulse(copies, watch, { minArticles: 4, minDomains: 3 });
        expect(pulse.MU.articles).toBe(1); // one unique headline
        expect(pulse.MU.domains).toBe(40); // breadth is still recorded
        expect(pulse.MU.hot).toBe(false); // article floor defuses the spam
    });

    test('matching is case-insensitive', () => {
        const pulse = attributePulse([art('NVIDIA and the AI capex debate', 'ft.test')], watch, { minArticles: 1, minDomains: 1 });
        expect(pulse.NVDA.articles).toBe(1);
        expect(pulse.NVDA.hot).toBe(true);
    });
});
