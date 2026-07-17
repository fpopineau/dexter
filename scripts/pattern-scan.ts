/**
 * Run the swing-pattern scan over the local archive and print the result.
 * No IBKR connection needed — reads market-archive.db only.
 *
 *   bun run scripts/pattern-scan.ts
 */

import { runPatternScan } from '../src/services/pattern-scanner.js';

const snap = await runPatternScan();
console.log(`\nScanned ${snap.scanned} symbols (${snap.eligible} fresh) — ${snap.candidates.length} candidates\n`);
for (const c of snap.candidates) {
    console.log(
        `${c.symbol.padEnd(6)} ${c.pattern.padEnd(20)} score ${String(c.score).padStart(3)}  ` +
        `close ${String(c.close).padStart(8)}  pivot ${String(c.pivot).padStart(8)}  ` +
        `entry ${String(c.suggestedEntry).padStart(8)}  stop ${String(c.suggestedStop).padStart(8)}  ATR ${c.dailyAtr ?? '?'}`,
    );
    console.log(`       ${c.note}`);
}
process.exit(0);
