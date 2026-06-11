/**
 * Sprint B smoke test — drives each IBKR tool directly without the LLM.
 * Confirms the @stoqey/ib wiring, IB Gateway connection, and that each
 * tool returns sensible data. Read-only: never places orders.
 *
 * Run: bun run scripts/smoke-ibkr.ts [TICKER]
 */

import 'dotenv/config';

import { createIbkrHistorical } from '@/tools/ibkr/historical';
import { createIbkrMarketData } from '@/tools/ibkr/market-data';
import { createRiskManager } from '@/tools/ibkr/risk-manager';
import { createIbkrScanner } from '@/tools/ibkr/scanner';
import { createSignalScorer } from '@/tools/ibkr/signal-scorer';
import { createTechnicalAnalysis } from '@/tools/ibkr/technical-analysis';
import { disconnect, getIBApi } from '@/tools/ibkr/connection';

const ticker = (process.argv[2] || 'AAPL').toUpperCase();

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function show(label: string, value: unknown): void {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  console.log(`${label}:\n${s.length > 1200 ? s.slice(0, 1200) + '…' : s}`);
}

async function main(): Promise<void> {
  section(`Env (target ${process.env.IBKR_HOST}:${process.env.IBKR_PORT})`);
  console.log(`IBKR_CLIENT_ID=${process.env.IBKR_CLIENT_ID ?? '(unset)'}`);

  section('1. Connection');
  const t0 = Date.now();
  await getIBApi();
  console.log(`getIBApi() resolved in ${Date.now() - t0} ms`);

  section(`2. ibkr_market_data ${ticker}`);
  const md = createIbkrMarketData();
  show('result', await md.invoke({ ticker, exchange: 'SMART', currency: 'USD' }));

  section(`3. ibkr_historical ${ticker} 1 day / 30 D`);
  const hist = createIbkrHistorical();
  show(
    'result',
    await hist.invoke({
      ticker,
      barSize: '1 day',
      duration: '30 D',
      whatToShow: 'TRADES',
      useRTH: true,
    }),
  );

  section(`4. technical_analysis ${ticker} 5 mins`);
  const ta = createTechnicalAnalysis();
  show('result', await ta.invoke({ ticker, barSize: '5 mins', useRTH: true }));

  section(`5. signal_scorer ${ticker} long 5 mins`);
  const ss = createSignalScorer();
  show('result', await ss.invoke({ ticker, direction: 'long', barSize: '5 mins', useRTH: true }));

  section('6. risk_manager (hypothetical long)');
  const rm = createRiskManager();
  show(
    'result',
    await rm.invoke({
      ticker,
      direction: 'long',
      entryPrice: 100,
      stopPrice: 98,
      targetPrice: 104,
      shares: 10,
      accountValue: 100_000,
    }),
  );

  section('7. ibkr_scanner TOP_PERC_GAIN');
  const sc = createIbkrScanner();
  show(
    'result',
    await sc.invoke({
      scanCode: 'TOP_PERC_GAIN',
      numberOfRows: 10,
      minPrice: 5,
      minVolume: 100_000,
      minMarketCap: 500_000_000,
      locationCode: 'STK.US.MAJOR',
    }),
  );
}

main()
  .then(() => {
    console.log('\nAll checks completed.');
    disconnect();
    setTimeout(() => process.exit(0), 500);
  })
  .catch((err) => {
    console.error('\nFAILED:', err);
    disconnect();
    setTimeout(() => process.exit(1), 500);
  });
