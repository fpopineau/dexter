/**
 * Options market-data entitlement probe — READ-ONLY, no orders.
 *
 * Answers the standing question from the earnings-bet design (2026-08-06,
 * revisited in the SMCI review 2026-08-13): does THIS account/session
 * actually return option quotes, or is the implied-move signal a null?
 *
 *   A. chain params (reqSecDefOptParams)  — no entitlement needed; proves
 *      the plumbing and the expiration/strike pick.
 *   B. live snapshots via fetchImpliedMove — the OPRA entitlement test.
 *   C. if B returns no quotes: one DELAYED snapshot (market data type 3),
 *      logging every tick field id that arrives — delayed ticks use
 *      different ids (66-68, 72-76), so this detects the free delayed
 *      entitlement that the live path silently misses. Delayed-only is
 *      VIABLE for the earnings use case: the implied-move read happens at
 *      evening triage, where a 15-minute delay is immaterial.
 *
 * Run against the SAME IB Gateway the trading gateway uses, but as a
 * SEPARATE client id so the probe can never displace the live session
 * (a duplicate id refuses the NEW connection, never the existing one):
 *
 *   IBKR_CLIENT_ID=77 npx tsx scripts/probe-options-data.mts [SYMBOL]
 */
import 'dotenv/config';
import { EventName, OptionType, SecType, type Contract } from '@stoqey/ib';
import { allocReqId, getIBApi } from '../src/tools/ibkr/connection.js';
import { fetchImpliedMove } from '../src/tools/ibkr/implied-move.js';

const sym = (process.argv[2] ?? 'SMCI').toUpperCase();

console.log(`[probe] ${sym} — client id ${process.env.IBKR_CLIENT_ID ?? '(default 0 — WARNING: may collide with the gateway)'}`);

// A + B: the full existing path (chain → ATM strike → live snapshots).
const res = await fetchImpliedMove(sym);
console.log('[probe] fetchImpliedMove:', JSON.stringify(res, null, 2));

// C: delayed-mode retry on the same call contract when live quotes were dry.
if (res.callMid == null && res.expiration && res.strike != null) {
    console.log('[probe] live quotes dry — retrying ONE contract under DELAYED market data (type 3)…');
    const api = await getIBApi();
    api.reqMarketDataType(3);
    const reqId = allocReqId();
    const contract: Contract = {
        symbol: sym, secType: SecType.OPT,
        lastTradeDateOrContractMonth: res.expiration, strike: res.strike,
        right: OptionType.Call, exchange: 'SMART', currency: 'USD', multiplier: 100,
    };
    const ticks: Record<string, number> = {};
    await new Promise<void>((resolve) => {
        // Generous window: delayed snapshots can take several seconds to tick.
        const timer = setTimeout(() => { cleanup(); resolve(); }, 15_000);
        const onTick = (id: number, field: number, price: number) => {
            if (id === reqId && price > 0) ticks[`field_${field}`] = price;
        };
        const onEnd = (id: number) => {
            if (id !== reqId) return;
            clearTimeout(timer); cleanup(); resolve();
        };
        const onErr = (err: Error, code: number, id: number) => {
            if (id !== reqId) return;
            console.log(`[probe] delayed snapshot message ${code}: ${err.message}`);
        };
        function cleanup() {
            api.off(EventName.tickPrice, onTick);
            api.off(EventName.tickSnapshotEnd, onEnd);
            api.off(EventName.error, onErr);
        }
        api.on(EventName.tickPrice, onTick);
        api.on(EventName.tickSnapshotEnd, onEnd);
        api.on(EventName.error, onErr);
        api.reqMktData(reqId, contract, '', true, false);
    });
    api.reqMarketDataType(1); // restore live mode for this client
    console.log('[probe] delayed tick fields received:', JSON.stringify(ticks));
    console.log('[probe] (66=delayed bid, 67=delayed ask, 68=delayed last, 75=delayed close)');
}

console.log('[probe] done');
process.exit(0);
