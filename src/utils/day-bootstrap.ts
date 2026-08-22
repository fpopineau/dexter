/**
 * Day-block bootstrap for the validation scorecard (REQ-VAL-003).
 *
 * Trades on the same day are not independent — same tape, same regime,
 * often the same catalyst — so resampling TRADES overstates the effective
 * sample size and narrows the confidence bound dishonestly. The block
 * bootstrap resamples trading DAYS with replacement and recomputes the
 * mean net P&L per trade on each replicate; the lower confidence bound of
 * that distribution is the criterion ("a positive sample mean" alone can
 * ride on two outlier days).
 *
 * Deterministic by construction: a fixed-seed PRNG makes the scorecard
 * reproducible run-to-run — the protocol pins the evaluator's output, and
 * an evaluation that changes on re-run is not an evaluation.
 */

/** mulberry32 — tiny deterministic PRNG, plenty for resampling. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface DayBootstrapResult {
    /** One-sided lower confidence bound of mean net P&L per trade. */
    lcb: number;
    /** Bootstrap distribution median (sanity anchor for the report). */
    median: number;
    days: number;
    replicates: number;
}

/**
 * Resample day-blocks with replacement; each replicate's statistic is the
 * mean per TRADE over the concatenated sampled days (days carry their
 * trade counts, so heavy days weigh what they weighed). `alpha` 0.05 →
 * the 5th percentile = a 95% one-sided LCB. Null when fewer than
 * `minDays` distinct days — a bound over 2 days is theater.
 */
export function dayBlockBootstrapLcb(
    tradesByDay: Map<string, number[]>,
    opts: { replicates?: number; alpha?: number; seed?: number; minDays?: number } = {},
): DayBootstrapResult | null {
    const days = [...tradesByDay.values()].filter((d) => d.length > 0);
    const minDays = opts.minDays ?? 5;
    if (days.length < minDays) return null;
    const replicates = opts.replicates ?? 1000;
    const alpha = opts.alpha ?? 0.05;
    const rand = mulberry32(opts.seed ?? 42);
    const means: number[] = [];
    for (let i = 0; i < replicates; i++) {
        let sum = 0, count = 0;
        for (let k = 0; k < days.length; k++) {
            const day = days[Math.floor(rand() * days.length)];
            for (const v of day) { sum += v; count++; }
        }
        means.push(count > 0 ? sum / count : 0);
    }
    means.sort((a, b) => a - b);
    const at = (q: number) => means[Math.min(means.length - 1, Math.max(0, Math.floor(q * means.length)))];
    return {
        lcb: at(alpha),
        median: at(0.5),
        days: days.length,
        replicates,
    };
}
