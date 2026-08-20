/**
 * Paper-gateway verification of the VALIDATION-PROTOCOL.md freeze
 * prerequisites (Phase 4). Read-only: connects, fetches, compares —
 * places NO orders.
 *
 *   1. Rules + calendar + weights provenance (pure, no gateway)
 *   2. WP7 ADV lot factor: avgDailyVolume20d vs known-scale ADVs
 *   3. WP7 tick-236 semantics: shortable/halted on liquid names
 *   4. WP8 FX: EUR.USD midpoint sanity
 *
 * Run: bun run scripts/verify-paper-prereqs.ts   (IB Gateway paper up)
 */

import 'dotenv/config';
import { calendarCoverageStatus } from '@/utils/market-hours';
import { getRiskRules, setAccountProfile } from '@/tools/ibkr/risk-rules';
import { getActiveWeightsInfo, weightsSourceLabel } from '@/tools/ibkr/signal-scorer';
import { fetchDailyRiskContext } from '@/tools/ibkr/daily-atr';
import { fetchShortabilitySnapshot } from '@/tools/ibkr/microstructure';
import { usdRate } from '@/tools/ibkr/fx';
import { disconnect } from '@/tools/ibkr/connection';

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
    console.log(`${ok ? '✅' : '❌'} ${name}: ${detail}`);
    if (!ok) failures++;
}
function info(name: string, detail: string): void {
    console.log(`ℹ️  ${name}: ${detail}`);
}

// --- 1. Pure boot checks (no gateway needed) -------------------------------
console.log('\n=== 1. Rules / calendar / weights (pure) ===');
try {
    const paper = getRiskRules();
    check('risk-rules paper profile', true, `loads clean (max_open ${paper.max_open_positions}, spread cap ${paper.max_spread_pct}%)`);
} catch (err) {
    check('risk-rules paper profile', false, String(err));
}
try {
    setAccountProfile('live');
    const live = getRiskRules();
    check('risk-rules live profile', true, `loads clean (max_open ${live.max_open_positions}, risk ${live.max_risk_per_trade_pct}%)`);
} catch (err) {
    check('risk-rules live profile', false, String(err));
} finally {
    setAccountProfile('paper');
}
const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const cov = calendarCoverageStatus(todayEt);
check('holiday-calendar coverage', cov.status === 'ok', `${cov.status} (through ${cov.lastCoveredYear})`);
info('scorer weights', weightsSourceLabel(getActiveWeightsInfo()));

// --- 2. WP7 ADV lot factor -------------------------------------------------
// Reference scales (shares/day, order-of-magnitude — updated 2026-08):
// AAPL ~4e7–1.2e8, NVDA ~1e8–4e8, KO ~1e7–3e7. The lot factor is WRONG by
// 100x low if we read ~1e5–1e6 for AAPL, wrong by 100x high at ~1e9+.
console.log('\n=== 2. WP7 — ADV lot factor (needs IB Gateway paper) ===');
const ADV_REFS: Array<{ sym: string; lo: number; hi: number }> = [
    { sym: 'AAPL', lo: 2e7, hi: 2e8 },
    { sym: 'NVDA', lo: 5e7, hi: 6e8 },
    { sym: 'KO', lo: 5e6, hi: 6e7 },
];
for (const { sym, lo, hi } of ADV_REFS) {
    try {
        const ctx = await fetchDailyRiskContext(sym);
        const adv = ctx.avgDailyVolume20d;
        if (adv === null) {
            check(`ADV ${sym}`, false, 'unavailable (gateway down or no data)');
        } else {
            const ok = adv >= lo && adv <= hi;
            check(`ADV ${sym}`, ok,
                `${Math.round(adv).toLocaleString()} shares/day ` +
                (ok ? '(plausible — share-denominated as delivered, no lot factor)'
                    : adv < lo ? '(TOO LOW — lot factor missing or IBKR returns shares already?)'
                    : '(TOO HIGH — lot factor applied to share-denominated data?)'));
        }
    } catch (err) {
        check(`ADV ${sym}`, false, String(err));
    }
}

// --- 3. WP7 tick-236 shortable/halted --------------------------------------
console.log('\n=== 3. WP7 — tick-236 shortable/halted ===');
for (const sym of ['AAPL', 'BYND']) {
    try {
        const snap = await fetchShortabilitySnapshot(sym);
        info(`tick-236 ${sym}`, `shortable=${snap.shortable} halted=${snap.halted}`);
        if (sym === 'AAPL') {
            check('AAPL shortable sanity', snap.shortable === true, `expected true (deep borrow), got ${snap.shortable}`);
            // Field 49 does not arrive on a normal tape (verified
            // 2026-08-21) — the gate treats null as a best-effort note by
            // design; a TRUE here on an unhalted name would be the bug.
            check('AAPL halted sanity', snap.halted !== true, `expected not-true (null = tick silent, by design), got ${snap.halted}`);
        }
    } catch (err) {
        check(`tick-236 ${sym}`, false, String(err));
    }
}

// --- 4. WP8 FX --------------------------------------------------------------
console.log('\n=== 4. WP8 — EUR.USD midpoint ===');
try {
    const rate = await usdRate('EUR');
    check('EUR.USD rate', rate > 0.85 && rate < 1.4, `${rate.toFixed(4)} (sane band 0.85–1.40)`);
} catch (err) {
    check('EUR.USD rate', false, String(err));
}

console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===`);
console.log('Remaining freeze prerequisites NOT verifiable on demand: the WP2');
console.log('partial-fill resize and WP11 buffered-event paths need a genuine');
console.log('broker partial fill / EOD-keep window — observe them opportunistically');
console.log('on paper before tagging, or accept them on their harness coverage.');
try { disconnect(); } catch { /* not connected */ }
process.exit(failures === 0 ? 0 : 1);
