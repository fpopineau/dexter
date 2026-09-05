/**
 * Calibration of the pre-registered sequential test (audit 2026-09-05,
 * AUD-12; REQ-SEQ-002/003).
 *
 * The four look alphas (1 / 2.5 / 4 / 5 %) SUM to 12.5 % — a Bonferroni
 * bound, not the realised familywise false-ACCEPT rate, which depends on
 * the dependence between looks (each prefix contains the previous one),
 * on the day-block bootstrap's own coverage at small n, and on the extra
 * ACCEPT conditions (net R > 0, PF ≥ 1.3). This script MEASURES it by
 * simulating the whole procedure — the same `evaluateLook`, the same
 * bootstrap, the same prefix rule — under:
 *
 *   H0   zero-mean R per trade with a shared DAILY shock (trades on one
 *        day are not independent) and a skewed trade distribution
 *        (p = 0.4 of +1.5 R, else −1.0 R → mean exactly 0)
 *   H1   the same noise shifted by +`--alt` R per trade (power)
 *
 * and for several confidence schedules, so the operator can see what the
 * pre-registered schedule actually buys and what an alternative would.
 * Production evaluates with SEQ_CONSTANTS only; the schedules here are
 * evidence for a decision, not a change.
 *
 *   bun run scripts/calibrate-sequential-test.ts [--sims 300] [--alt 0.25]
 *       [--day-sigma 0.3] [--max-per-day 4] [--seed 7] [--rho 0]
 *       [--reps <bootstrap replicates>] [--block 5] [--only A,B]
 *
 *   --rho    AR(1) coefficient of the daily shock (regime streaks) — the
 *            null the moving-block bootstrap is meant for
 *   --block  adds L-session moving-block copies of schedules A and B
 */

import { evaluateLook, SEQ_CONSTANTS, type LookConstants, type RTrade } from '../src/utils/sequential-test.js';
import { mulberry32 } from '../src/utils/day-bootstrap.js';

function arg(name: string, def: number): number {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0 || i + 1 >= process.argv.length) return def;
    const v = Number(process.argv[i + 1]);
    return Number.isFinite(v) ? v : def;
}

const SIMS = Math.max(20, Math.floor(arg('sims', 300)));
const ALT = arg('alt', 0.25);
const DAY_SIGMA = arg('day-sigma', 0.3);
const MAX_PER_DAY = Math.max(1, Math.floor(arg('max-per-day', 4)));
const SEED = Math.floor(arg('seed', 7));
/** AR(1) coefficient of the daily shock (0 = independent days; 0.5 = regime streaks). */
const RHO = Math.min(0.95, Math.max(0, arg('rho', 0)));
/** Bootstrap replicates for the run (production: SEQ_CONSTANTS.bootstrap.replicates). */
const REPS = Math.max(200, Math.floor(arg('reps', SEQ_CONSTANTS.bootstrap.replicates)));
/** Compare moving session blocks: `--block L` adds an L-day-block copy of schedules A and B. */
const BLOCK = Math.max(1, Math.floor(arg('block', 1)));
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1].split(',') : null; })();
const HORIZON = SEQ_CONSTANTS.looks[SEQ_CONSTANTS.looks.length - 1];

interface Schedule { name: string; consts: LookConstants; note: string }

const base = { looks: SEQ_CONSTANTS.looks, rejectConfidence: SEQ_CONSTANTS.rejectConfidence, minProfitFactor: SEQ_CONSTANTS.minProfitFactor, bootstrap: { ...SEQ_CONSTANTS.bootstrap, replicates: REPS, blockDays: 1 } };
const withBlock = (c: LookConstants, blockDays: number): LookConstants => ({ ...c, bootstrap: { ...c.bootstrap, blockDays } });
const A: Schedule = { name: 'A pre-registered', consts: { ...base, lookConfidences: SEQ_CONSTANTS.lookConfidences }, note: '99 / 97.5 / 96 / 95 (alphas sum 12.5%)' };
const B: Schedule = { name: 'B Bonferroni-5%', consts: { ...base, lookConfidences: [0.9875, 0.9875, 0.9875, 0.9875] }, note: '4 × 1.25% = 5% bound' };
let SCHEDULES: Schedule[] = [
    A,
    B,
    { name: 'C OBF-like', consts: { ...base, lookConfidences: [0.9996, 0.9933, 0.9776, 0.9587] }, note: "O'Brien-Fleming one-sided spending ≈ 5% overall" },
    { name: 'D stricter early', consts: { ...base, lookConfidences: [0.995, 0.99, 0.975, 0.95] }, note: 'alphas 0.5 / 1 / 2.5 / 5 (sum 9%)' },
];
if (BLOCK > 1) {
    SCHEDULES = [
        A, { ...A, name: `A block=${BLOCK}`, consts: withBlock(A.consts, BLOCK), note: `schedule A with ${BLOCK}-session moving blocks` },
        B, { ...B, name: `B block=${BLOCK}`, consts: withBlock(B.consts, BLOCK), note: `schedule B with ${BLOCK}-session moving blocks` },
    ];
}
if (ONLY) SCHEDULES = SCHEDULES.filter((s) => ONLY.some((o) => s.name.startsWith(o)));

/** Box-Muller standard normal from a uniform PRNG. */
function normal(rand: () => number): number {
    const u = Math.max(1e-12, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** One epoch of `HORIZON` trades: days of 1..MAX_PER_DAY trades sharing a
 *  daily shock; trade R = mean + shock + skewed zero-mean noise. */
function simulateEpoch(rand: () => number, mean: number): RTrade[] {
    const out: RTrade[] = [];
    let day = 0;
    let prevShock = 0;
    while (out.length < HORIZON) {
        const k = 1 + Math.floor(rand() * MAX_PER_DAY);
        // AR(1) daily shock with stationary variance DAY_SIGMA² (RHO 0 = iid).
        const shock = RHO * prevShock + Math.sqrt(1 - RHO * RHO) * normal(rand) * DAY_SIGMA;
        prevShock = shock;
        for (let j = 0; j < k && out.length < HORIZON; j++) {
            const e = rand() < 0.4 ? 1.5 : -1.0; // E[e] = 0.6 − 0.6 = 0
            const i = out.length;
            out.push({ id: `S-${String(i).padStart(4, '0')}`, entryDay: `d${String(day).padStart(4, '0')}`, closedAt: i, netR: mean + shock + e, netUsd: 0, band: null, tradeClass: 'intraday' });
        }
        day++;
    }
    return out;
}

interface Tally { accept: number[]; reject: number[]; notEvaluable: number; stoppedAt: number[] }

function runProcedure(epoch: RTrade[], consts: LookConstants, tally: Tally): void {
    for (let li = 0; li < consts.looks.length; li++) {
        const lookN = consts.looks[li];
        const r = evaluateLook(epoch, lookN, consts);
        if (r.decision === 'NOT-EVALUABLE') { tally.notEvaluable++; continue; }
        if (r.decision === 'ACCEPT') { tally.accept[li]++; tally.stoppedAt.push(lookN); return; }
        if (r.decision === 'REJECT') { tally.reject[li]++; tally.stoppedAt.push(lookN); return; }
    }
    tally.stoppedAt.push(HORIZON);
}

function pct(x: number, n: number): string { return `${((100 * x) / n).toFixed(1)}%`; }

function main(): void {
    console.log(`\n=== SEQUENTIAL-TEST CALIBRATION — ${SIMS} simulated epochs per cell, day shock σ ${DAY_SIGMA} R (AR1 ρ ${RHO}), 1..${MAX_PER_DAY} trades/day, seed ${SEED} ===`);
    console.log(`procedure: prefix looks at ${SEQ_CONSTANTS.looks.join('/')}; ACCEPT = LCB > 0 ∧ net R > 0 ∧ PF ≥ ${SEQ_CONSTANTS.minProfitFactor}; REJECT = UCB95 < 0; bootstrap ${REPS} × seed ${SEQ_CONSTANTS.bootstrap.seed}, ≥ ${SEQ_CONSTANTS.bootstrap.minDays} days${BLOCK > 1 ? `, blocks 1 vs ${BLOCK}` : ''}`);
    const t0 = Date.now();
    for (const mean of [0, ALT]) {
        const rand = mulberry32(SEED + (mean === 0 ? 0 : 1000));
        const epochs: RTrade[][] = [];
        for (let s = 0; s < SIMS; s++) epochs.push(simulateEpoch(rand, mean));
        console.log(`\n--- ${mean === 0 ? 'H0: mean R = 0 (false-ACCEPT rate)' : `H1: mean R = +${mean} (power)`} ---`);
        console.log('schedule            | ACCEPT total | by look 25/50/75/100        | REJECT total | mean stop n | note');
        for (const sch of SCHEDULES) {
            const tally: Tally = { accept: [0, 0, 0, 0], reject: [0, 0, 0, 0], notEvaluable: 0, stoppedAt: [] };
            for (const e of epochs) runProcedure(e, sch.consts, tally);
            const acc = tally.accept.reduce((a, b) => a + b, 0);
            const rej = tally.reject.reduce((a, b) => a + b, 0);
            const stopN = tally.stoppedAt.reduce((a, b) => a + b, 0) / tally.stoppedAt.length;
            console.log(
                `${sch.name.padEnd(19)} | ${pct(acc, SIMS).padStart(12)} | ${tally.accept.map((x) => pct(x, SIMS)).join(' / ').padEnd(27)} | ${pct(rej, SIMS).padStart(12)} | ${stopN.toFixed(1).padStart(11)} | ${sch.note}`,
            );
        }
    }
    console.log(`\nelapsed ${((Date.now() - t0) / 1000).toFixed(1)}s. Vendor of truth: these are the procedure's realised rates under THIS null; a heavier-tailed or more clustered tape changes them — re-run with --day-sigma / --max-per-day to see the sensitivity.\n`);
}

main();
