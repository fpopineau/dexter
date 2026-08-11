/**
 * External-signals smoke test — drives the Polymarket event-risk service
 * and the GDELT news-pulse pieces directly, no LLM, no IBKR. Read-only
 * against two keyless public APIs.
 *
 * Run: bun run scripts/smoke-external-signals.ts [TICKER]
 * (or: ./node_modules/.bin/tsx scripts/smoke-external-signals.ts)
 *
 * GDELT note: allow ≥5 s between runs — the API answers violations with a
 * plain-text throttle message and a multi-minute penalty window.
 */

import 'dotenv/config';

import { getEarningsMarketSignal, getMacroEventsWithin, macroNightWarning } from '@/services/event-risk';
import { attributePulse, fetchGdeltArticles } from '@/services/news-pulse';

const ticker = (process.argv[2] || 'STUB').toUpperCase();

async function main(): Promise<void> {
    console.log('— event_risk: macro events within 3 days —');
    const events = await getMacroEventsWithin(3);
    if (events === null) {
        console.log('  DEGRADED: prediction-market data unavailable');
    } else {
        for (const e of events) {
            console.log(`  ${e.date} (d+${e.daysAway}) [${e.category}] ${e.title} — top ${e.topOutcome ? Math.round(e.topOutcome.probability * 100) + '% ' + e.topOutcome.label : 'n/a'} (${e.uncertainty})`);
        }
        console.log(`  triage line: ${macroNightWarning(events) ?? '(quiet horizon)'}`);
    }

    console.log(`— event_risk: earnings market for ${ticker} —`);
    const signal = await getEarningsMarketSignal(ticker);
    console.log(signal
        ? `  ${signal.question} → beat p=${signal.beatProbability} vol=$${Math.round(signal.volume)} resolves ${signal.endDate}`
        : '  no open market (absent, not negative)');

    console.log('— news_pulse: one live batched GDELT query —');
    const watch = [
        { symbol: 'NVDA', name: 'Nvidia' },
        { symbol: 'MU', name: 'Micron Technology' },
    ];
    const parsed = await fetchGdeltArticles(watch.map((w) => w.name), 180);
    if (!parsed.ok) {
        console.log(`  DEGRADED: ${parsed.reason}`);
    } else {
        const pulse = attributePulse(parsed.articles, watch, { minArticles: 4, minDomains: 3 });
        for (const [sym, p] of Object.entries(pulse)) {
            console.log(`  ${sym}: ${p.articles} unique headlines / ${p.domains} domains ${p.hot ? '← HOT' : ''}`);
            for (const h of p.headlines) console.log(`      ${h.domain}: ${h.title.slice(0, 80)}`);
        }
    }
}

main().catch((err) => {
    console.error(`smoke failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
