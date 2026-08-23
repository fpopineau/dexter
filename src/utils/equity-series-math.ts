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

/** ET wall-clock minutes-since-midnight of an epoch instant. */
export function etMinutes(ts: number): number {
    const s = new Date(ts).toLocaleTimeString('en-GB', { timeZone: ET, hour12: false });
    const m = /^(\d{2}):(\d{2})/.exec(s);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** Is the ET calendar day of `ts` a weekday? */
export function etIsWeekday(ts: number): boolean {
    const d = new Date(ts).toLocaleDateString('en-US', { timeZone: ET, weekday: 'short' });
    return d !== 'Sat' && d !== 'Sun';
}

/**
 * Exposure coverage (review 2026-08-23 P1): "one sample on every close day"
 * certified a series that could sleep through the whole holding period and
 * wake after the recovery. For every ET WEEKDAY inside any exposure
 * interval, the series must prove it was WATCHING: a sample at/before
 * 10:00 ET, a sample at/after 15:30 ET, and no intra-RTH gap over
 * `maxGapMin`. Returns human-readable violations (empty = covered).
 * Half-session days can flag the 15:30 requirement — operator judgment,
 * better a false flag than a certified blind spot.
 */
export function exposureCoverageGaps(
    series: EquitySample[],
    intervals: Array<{ from: number; to: number; label: string }>,
    maxGapMin = 60,
): string[] {
    const RTH_OPEN = 9 * 60 + 30, RTH_CLOSE = 16 * 60;
    const fmt = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    // Per exposed weekday: the merged RTH sub-window the series must cover,
    // CLIPPED to the actual exposure (an entry at 14:50 does not owe the
    // morning; a close at 10:10 does not owe the afternoon).
    const days = new Map<string, { startMin: number; endMin: number; labels: string[] }>();
    for (const iv of intervals) {
        if (!(iv.to >= iv.from)) continue;
        const fromDay = etDayOf(iv.from), toDay = etDayOf(iv.to);
        for (let t = iv.from; ; t += 86_400_000) {
            const day = etDayOf(t);
            if (etIsWeekday(t)) {
                const startMin = day === fromDay ? Math.max(RTH_OPEN, etMinutes(iv.from)) : RTH_OPEN;
                const endMin = day === toDay ? Math.min(RTH_CLOSE, etMinutes(iv.to)) : RTH_CLOSE;
                if (startMin < endMin) {
                    const cur = days.get(day);
                    if (cur) {
                        cur.startMin = Math.min(cur.startMin, startMin);
                        cur.endMin = Math.max(cur.endMin, endMin);
                        cur.labels.push(iv.label);
                    } else {
                        days.set(day, { startMin, endMin, labels: [iv.label] });
                    }
                }
            }
            if (day === toDay || t > iv.to + 86_400_000) break;
        }
    }
    const violations: string[] = [];
    for (const [day, w] of [...days.entries()].sort()) {
        const who = [...new Set(w.labels)].join(', ');
        const inWindow = series
            .filter((s) => etDayOf(s.ts) === day)
            .filter((s) => { const m = etMinutes(s.ts); return m >= w.startMin && m <= w.endMin; })
            .sort((a, b) => a.ts - b.ts);
        if (inWindow.length === 0) {
            violations.push(`${day}: NO samples in the exposed window ${fmt(w.startMin)}-${fmt(w.endMin)} ET (${who})`);
            continue;
        }
        if (etMinutes(inWindow[0].ts) > w.startMin + maxGapMin / 2) {
            violations.push(`${day}: first sample at ${fmt(etMinutes(inWindow[0].ts))} ET — the start of the exposed window (${fmt(w.startMin)}) was unobserved (${who})`);
        }
        if (etMinutes(inWindow[inWindow.length - 1].ts) < w.endMin - maxGapMin / 2) {
            violations.push(`${day}: last sample at ${fmt(etMinutes(inWindow[inWindow.length - 1].ts))} ET — the end of the exposed window (${fmt(w.endMin)}) was unobserved (${who})`);
        }
        for (let i = 1; i < inWindow.length; i++) {
            const gapMin = (inWindow[i].ts - inWindow[i - 1].ts) / 60_000;
            if (gapMin > maxGapMin) {
                violations.push(`${day}: ${Math.round(gapMin)}min sampling gap while exposed (${who})`);
                break; // one gap per day is enough to fail it
            }
        }
    }
    return violations;
}
