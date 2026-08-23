/**
 * Pure equity-series arithmetic (REQ-VAL-006) — shared by the gateway
 * sampler (src/services/equity-series.ts) and the read-only validation
 * scorecard, which must not import broker-connected modules.
 */

const ET = 'America/New_York';

export interface EquitySample { ts: number; netLiq: number }

/** Parse the JSONL text, dropping malformed lines (a torn write must not
 *  poison the series). Sorted by time. */
export function parseEquitySeries(text: string): EquitySample[] {
    const out: EquitySample[] = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
            const v = JSON.parse(t) as Partial<EquitySample>;
            if (typeof v.ts === 'number' && Number.isFinite(v.ts) && typeof v.netLiq === 'number' && v.netLiq > 0) {
                out.push({ ts: v.ts, netLiq: v.netLiq });
            }
        } catch { /* torn line */ }
    }
    return out.sort((a, b) => a.ts - b.ts);
}

export interface PortfolioDrawdown {
    /** Worst peak-to-trough of marked equity inside the window, % of the peak
     *  (rounded to 0.01%). */
    maxDdPct: number;
    peak: number;
    trough: number;
    samples: number;
    /** Distinct ET calendar days with at least one sample — coverage proof. */
    days: Set<string>;
}

export function etDayOf(ts: number): string {
    return new Date(ts).toLocaleDateString('en-CA', { timeZone: ET });
}

/** Peak-to-trough drawdown over the samples inside [fromMs, toMs]. Null
 *  when the window holds no samples. The running peak starts at the first
 *  in-window sample (pre-window highs are another epoch). */
export function portfolioDrawdown(series: EquitySample[], fromMs: number, toMs = Number.POSITIVE_INFINITY): PortfolioDrawdown | null {
    const win = series.filter((s) => s.ts >= fromMs && s.ts <= toMs);
    if (win.length === 0) return null;
    let peak = win[0].netLiq, trough = win[0].netLiq, maxDd = 0;
    let ddPeak = peak, ddTrough = peak;
    for (const s of win) {
        if (s.netLiq > peak) { peak = s.netLiq; trough = s.netLiq; }
        if (s.netLiq < trough) trough = s.netLiq;
        const dd = peak > 0 ? (peak - trough) / peak : 0;
        if (dd > maxDd) { maxDd = dd; ddPeak = peak; ddTrough = trough; }
    }
    return {
        maxDdPct: Math.round(maxDd * 10_000) / 100,
        peak: ddPeak,
        trough: ddTrough,
        samples: win.length,
        days: new Set(win.map((s) => etDayOf(s.ts))),
    };
}
