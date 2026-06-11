/**
 * Opportunity Engine demo — runs ONE scan→score→rank cycle and prints the
 * ranked snapshot. Read-only: no orders, no LLM keys required.
 *
 * Requires IB Gateway/TWS connected (paper). Outside market hours the
 * engine falls back to intraday scan codes and flags marketOpen=false.
 *
 * Run:
 *   bun run scripts/demo-opportunities.ts            # phase inferred from the clock
 *   bun run scripts/demo-opportunities.ts pre-close  # force a phase (pre-open|open-drive|midday|pre-close)
 */

import 'dotenv/config';

import { runCycleOnce, type EnginePhase } from '@/services/opportunity-engine';
import { disconnect } from '@/tools/ibkr/connection';

const PHASES = ['pre-open', 'open-drive', 'midday', 'pre-close'] as const;
const arg = process.argv[2];
const force = PHASES.includes(arg as typeof PHASES[number]) ? (arg as EnginePhase) : undefined;

console.log(`\n=== Opportunity Engine — one cycle${force ? ` (forced phase: ${force})` : ''} ===`);
const t0 = Date.now();

const snap = await runCycleOnce(force);

console.log(`Phase      : ${snap.phase}   session: ${snap.sessionLabel}   marketOpen: ${snap.marketOpen}`);
console.log(`Scanned    : ${snap.scanned} symbols, scored ${snap.scored}, in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

if (snap.opportunities.length === 0) {
    console.log('No opportunities scored this cycle (scanners may return nothing outside market hours).');
} else {
    console.log('rank  symbol  dir    comp  signal rating      price     rvol  scanners');
    console.log('----  ------  -----  ----  ------ ----------  --------  ----  --------');
    snap.opportunities.slice(0, 15).forEach((o, i) => {
        console.log(
            String(i + 1).padStart(4) + '  ' +
            o.symbol.padEnd(6) + '  ' +
            o.direction.padEnd(5) + '  ' +
            String(o.compositeRank).padStart(4) + '  ' +
            String(o.signalScore).padStart(6) + ' ' +
            o.rating.padEnd(10) + '  ' +
            String(o.price ?? '—').padStart(8) + '  ' +
            String(o.rvol ?? '—').padStart(4) + '  ' +
            o.scanSources.join(','),
        );
    });
}

console.log('');
disconnect();
setTimeout(() => process.exit(0), 500);
