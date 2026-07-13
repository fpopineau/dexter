/**
 * Historical bar backfill — fills the market archive (market-archive.db)
 * from IBKR for a date range. Built to close the FirstRate gap
 * (2025-07-08 → present) for the calibration/backtest universe.
 *
 * Run:
 *   bun run scripts/backfill-bars.ts AAPL NVDA MSFT --from 2025-07-08
 *   bun run scripts/backfill-bars.ts SPY --from 2025-07-08 --to 2026-07-03 --chunk-days 7
 *
 * Options:
 *   --from YYYY-MM-DD      inclusive start (required)
 *   --to YYYY-MM-DD        inclusive end (default: yesterday)
 *   --bar-size "1 min"     1 min | 5 mins | 15 mins | 30 mins | 1 hour | 1 day
 *   --chunk-days N         calendar days per request (default 7)
 *   --rth                  regular trading hours only (default: extended, like FirstRate)
 *   --what TRADES          whatToShow (default TRADES; see adjustment note)
 *   --pace-ms N            delay between requests (default 11000 — IBKR pacing)
 *   --no-resume            re-fetch even what is already archived
 *   --no-daily-adjusted    skip the daily ADJUSTED_LAST series
 *
 * Pacing: IBKR allows ~60 historical requests / 10 min. At the default
 * 11 s pace, one symbol-year of 1-min bars (53 weekly chunks) takes ~10 min.
 * Safe to interrupt and re-run: --resume (default) continues where it left off.
 *
 * Adjustment note: ranged requests use as-traded TRADES prices (IBKR only
 * serves ADJUSTED_LAST ending "now"). A daily ADJUSTED_LAST series is also
 * stored per symbol ('1 day adj'): adjusted/unadjusted daily close ratios
 * give the per-day factors if a split/dividend falls inside the window.
 */

import 'dotenv/config';

import { archiveBarsRange, closeArchiveDb } from '@/services/data-archive';
import { disconnect, getIBApi } from '@/tools/ibkr/connection';

interface CliArgs {
    symbols: string[];
    from: string;
    to: string;
    barSize: string;
    chunkDays: number;
    useRTH: boolean;
    whatToShow: string;
    paceMs: number;
    resume: boolean;
    withDailyAdjusted: boolean;
}

function usage(exitCode: number): never {
    console.log(
        'Usage: bun run scripts/backfill-bars.ts SYMBOL [SYMBOL…] --from YYYY-MM-DD [--to YYYY-MM-DD]\n' +
        '       [--bar-size "1 min"] [--chunk-days 7] [--rth] [--what TRADES] [--pace-ms 11000]\n' +
        '       [--no-resume] [--no-daily-adjusted]',
    );
    process.exit(exitCode);
}

function yesterdayIso(): string {
    const d = new Date(Date.now() - 24 * 3600_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseCli(argv: string[]): CliArgs {
    const args: CliArgs = {
        symbols: [],
        from: '',
        to: yesterdayIso(),
        barSize: '1 min',
        chunkDays: 7,
        useRTH: false,
        whatToShow: 'TRADES',
        paceMs: 11_000,
        resume: true,
        withDailyAdjusted: true,
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined) {
                console.error(`Missing value for ${a}`);
                usage(1);
            }
            return v;
        };
        switch (a) {
            case '--help': case '-h': usage(0); break;
            case '--from': args.from = next(); break;
            case '--to': args.to = next(); break;
            case '--bar-size': args.barSize = next(); break;
            case '--chunk-days': args.chunkDays = Number(next()); break;
            case '--rth': args.useRTH = true; break;
            case '--what': args.whatToShow = next(); break;
            case '--pace-ms': args.paceMs = Number(next()); break;
            case '--no-resume': args.resume = false; break;
            case '--no-daily-adjusted': args.withDailyAdjusted = false; break;
            default:
                if (a.startsWith('-')) {
                    console.error(`Unknown option ${a}`);
                    usage(1);
                }
                args.symbols.push(a.toUpperCase());
        }
    }

    if (args.symbols.length === 0) {
        console.error('No symbols given.');
        usage(1);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.from)) {
        console.error('--from YYYY-MM-DD is required (e.g. --from 2025-07-08, the day after the FirstRate archive ends).');
        usage(1);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.to)) {
        console.error(`Invalid --to '${args.to}'.`);
        usage(1);
    }
    if (!Number.isFinite(args.chunkDays) || args.chunkDays < 1) {
        console.error('--chunk-days must be a positive number.');
        usage(1);
    }
    return args;
}

async function main(): Promise<void> {
    const args = parseCli(process.argv.slice(2));

    const days = Math.max(1, Math.round(
        (new Date(args.to).getTime() - new Date(args.from).getTime()) / (24 * 3600_000),
    ) + 1);
    const chunksPerSymbol = Math.ceil(days / args.chunkDays) + (args.withDailyAdjusted ? 1 : 0);
    const etaMin = Math.round((args.symbols.length * chunksPerSymbol * args.paceMs) / 60_000);

    console.log(`Backfill: ${args.symbols.length} symbol(s), ${args.from} → ${args.to} (${days} days)`);
    console.log(`Bar size ${args.barSize}, ${args.chunkDays}-day chunks, ${args.whatToShow}, ` +
        `${args.useRTH ? 'RTH only' : 'extended hours'}, pace ${args.paceMs} ms`);
    console.log(`Worst-case ~${chunksPerSymbol} requests/symbol ≈ ${etaMin} min total (resume skips archived data)\n`);

    console.log(`Connecting to IBKR ${process.env.IBKR_HOST ?? '127.0.0.1'}:${process.env.IBKR_PORT ?? '?'}…`);
    await getIBApi();
    console.log('Connected.\n');

    const started = Date.now();
    const result = await archiveBarsRange({
        symbols: args.symbols,
        from: args.from,
        to: args.to,
        barSize: args.barSize,
        chunkDays: args.chunkDays,
        useRTH: args.useRTH,
        whatToShow: args.whatToShow,
        paceMs: args.paceMs,
        resume: args.resume,
        withDailyAdjusted: args.withDailyAdjusted,
        onProgress: (msg) => console.log(`  ${msg}`),
    });

    const elapsedMin = ((Date.now() - started) / 60_000).toFixed(1);
    console.log(`\n=== Summary (${elapsedMin} min) ===`);
    for (const [symbol, bars] of Object.entries(result.bars)) {
        console.log(`  ${symbol.padEnd(8)} ${bars < 0 ? 'FAILED' : `${bars} bars`}`);
    }
    console.log(`  chunks: ${result.chunksFetched} fetched, ${result.chunksFailed} failed`);
    if (result.chunksFailed > 0) {
        console.log('  Re-run the same command to retry the failed chunks (resume is idempotent).');
    }

    closeArchiveDb();
    disconnect();
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    closeArchiveDb();
    disconnect();
    process.exit(1);
});
