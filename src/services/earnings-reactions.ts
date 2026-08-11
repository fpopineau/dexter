/**
 * Earnings reactions — the symbol's own post-print record, computed
 * deterministically. This is the evidence base for the 'earnings-bet'
 * trade class: the sizer's worstCaseGapPct and the evidence bar
 * (≥ EVIDENCE_MIN_PRINTS prints, ≥ EVIDENCE_MIN_CONSISTENCY_PCT%
 * direction consistency) both come from here, never from the LLM's
 * arithmetic.
 *
 * Data sources:
 *   - report dates: Nasdaq's public earnings-surprise API (keyless, the
 *     same host the earnings-calendar service uses) — ~4 verified
 *     quarters with reported EPS vs consensus;
 *   - older dates: inferred by quarterly stepping from the oldest
 *     verified date and snapping to the largest overnight gap within a
 *     search window — earnings day is almost always the quarter's
 *     biggest gap. Inferred prints are flagged; the evidence verdict
 *     reports how much of the record rests on inference.
 *   - daily bars: IBKR (2 years, regular hours).
 *
 * Reaction-day convention: for a report on date D, the reaction shows at
 * D's open (pre-market report) or D+1's open (after-hours). Rather than
 * trust a timing label we pick whichever of the two candidate days has
 * the larger overnight gap — self-detecting, and robust to calendar
 * sources that disagree about BMO/AMC.
 */

import { BarSizeSetting } from '@stoqey/ib';
import { fetchBars } from '@/tools/ibkr/signal-scorer.js';
import { logger } from '@/utils';

// Evidence bar (decided 2026-08-06): at least 8 computable prints and 75%
// direction consistency before a name qualifies for an earnings bet. The
// third requirement — at least one supporting external signal — is the
// skill's to verify; it cannot be computed from bars.
export const EVIDENCE_MIN_PRINTS = 8;
export const EVIDENCE_MIN_CONSISTENCY_PCT = 75;

export interface DailyCloseBar {
    /** ISO date 'YYYY-MM-DD'. */
    date: string;
    open: number;
    close: number;
}

export interface ReportDate {
    /** ISO date 'YYYY-MM-DD' — the day the report was released. */
    date: string;
    /** True when the date came from a published record; false when it was
     *  inferred from quarterly spacing + gap snapping. */
    verified: boolean;
    /** EPS surprise in % when the source provides it (verified dates only). */
    epsSurprisePct?: number | null;
}

export interface PrintReaction {
    reportDate: string;
    reactionDate: string;
    verified: boolean;
    /** Overnight repricing: reaction day open vs previous close, %. */
    gapPct: number;
    /** Full first-session reaction: reaction day close vs previous close, %. */
    closeMovePct: number;
    epsSurprisePct?: number | null;
}

export interface ReactionStats {
    symbol: string;
    prints: PrintReaction[];
    n: number;
    nVerified: number;
    upCount: number;
    downCount: number;
    /** % of prints whose first-session close moved up / down. */
    upConsistencyPct: number;
    downConsistencyPct: number;
    /** Mean |closeMovePct| — the historical realized print move, the
     *  honest comparator for the options-implied move. */
    avgAbsMovePct: number;
    /** Worst adverse move for a LONG holder, positive magnitude % (the
     *  most negative of gap/close across prints; 0 when none negative).
     *  Feed this to worstCaseGapPct when proposing a long bet. */
    worstAdverseForLongPct: number;
    /** Worst adverse move for a SHORT holder, positive magnitude %. */
    worstAdverseForShortPct: number;
    /** Deterministic evidence verdicts (print count + consistency only —
     *  the external-signal requirement is checked by the skill). */
    meetsBarLong: boolean;
    meetsBarShort: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Verified report dates — Nasdaq earnings-surprise (keyless)
// ---------------------------------------------------------------------------

/** Parse Nasdaq's 'M/D/YYYY' into ISO, or null. */
export function parseNasdaqDate(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Extract verified report dates from the Nasdaq earnings-surprise payload. */
export function parseEarningsSurprise(json: unknown): ReportDate[] {
    const rows = (json as { data?: { earningsSurpriseTable?: { rows?: unknown[] } } })
        ?.data?.earningsSurpriseTable?.rows;
    if (!Array.isArray(rows)) return [];
    const out: ReportDate[] = [];
    for (const r of rows) {
        const row = r as { dateReported?: unknown; percentageSurprise?: unknown };
        const date = parseNasdaqDate(row.dateReported);
        if (!date) continue;
        const surprise = Number(row.percentageSurprise);
        out.push({ date, verified: true, epsSurprisePct: Number.isFinite(surprise) ? surprise : null });
    }
    // Newest first, deduped.
    return [...new Map(out.map((d) => [d.date, d])).values()]
        .sort((a, b) => b.date.localeCompare(a.date));
}

async function fetchVerifiedDates(symbol: string): Promise<ReportDate[]> {
    try {
        const res = await fetch(
            `https://api.nasdaq.com/api/company/${encodeURIComponent(symbol)}/earnings-surprise`,
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json',
                },
                signal: AbortSignal.timeout(10_000),
            },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseEarningsSurprise(await res.json());
    } catch (err) {
        logger.warn(`[earnings-reactions] ${symbol}: verified dates unavailable — ${err instanceof Error ? err.message : err}`);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Inferred older report dates — quarterly stepping + gap snapping
// ---------------------------------------------------------------------------

const QUARTER_DAYS = 91;
/** Trading days searched on each side of the quarterly estimate. */
const SNAP_WINDOW = 7;

function isoDaysBefore(iso: string, days: number): string {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
}

/**
 * Infer report dates OLDER than the oldest verified one: step back a
 * quarter at a time and snap to the largest overnight gap inside the
 * window. Deterministic; returns newest-first.
 */
export function inferOlderReportDates(
    bars: DailyCloseBar[],
    oldestVerified: string,
    want: number,
): ReportDate[] {
    const out: ReportDate[] = [];
    let anchor = oldestVerified;
    for (let q = 0; q < want; q++) {
        const estimate = isoDaysBefore(anchor, QUARTER_DAYS);
        // Center of the search: the trading day at/just before the estimate.
        let center = -1;
        for (let i = bars.length - 1; i >= 0; i--) {
            if (bars[i].date <= estimate) { center = i; break; }
        }
        if (center < 1) break; // ran out of history
        let best = -1;
        let bestGap = -1;
        const from = Math.max(1, center - SNAP_WINDOW);
        const to = Math.min(bars.length - 1, center + SNAP_WINDOW);
        for (let i = from; i <= to; i++) {
            const gap = Math.abs(bars[i].open / bars[i - 1].close - 1);
            if (gap > bestGap) { bestGap = gap; best = i; }
        }
        if (best < 1) break;
        // The gap shows on the REACTION day; the report itself may have been
        // the prior evening. Recording the gap day as the report date is
        // fine: computeReactionStats treats it as a pre-market report and
        // measures the same gap.
        out.push({ date: bars[best].date, verified: false, epsSurprisePct: null });
        anchor = bars[best].date;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Reaction math
// ---------------------------------------------------------------------------

/**
 * Compute per-print reactions and the aggregate stats. Pure — bars must be
 * ascending by date; prints may be in any order and are deduped. Prints
 * without enough surrounding bars are skipped.
 */
export function computeReactionStats(
    symbol: string,
    bars: DailyCloseBar[],
    reports: ReportDate[],
): ReactionStats {
    const prints: PrintReaction[] = [];
    const seenReaction = new Set<string>();

    for (const report of [...new Map(reports.map((r) => [r.date, r])).values()]) {
        // First bar at/after the report date (BMO candidate)…
        let i = bars.findIndex((b) => b.date >= report.date);
        if (i < 1) continue;
        // …vs the following bar (AMC candidate): larger overnight gap wins.
        const gapAt = (k: number) => Math.abs(bars[k].open / bars[k - 1].close - 1);
        let r = i;
        if (i + 1 < bars.length && gapAt(i + 1) > gapAt(i)) r = i + 1;
        if (seenReaction.has(bars[r].date)) continue;
        seenReaction.add(bars[r].date);
        const prev = bars[r - 1].close;
        prints.push({
            reportDate: report.date,
            reactionDate: bars[r].date,
            verified: report.verified,
            gapPct: round2((bars[r].open / prev - 1) * 100),
            closeMovePct: round2((bars[r].close / prev - 1) * 100),
            epsSurprisePct: report.epsSurprisePct ?? null,
        });
    }

    prints.sort((a, b) => b.reactionDate.localeCompare(a.reactionDate));

    const n = prints.length;
    const upCount = prints.filter((p) => p.closeMovePct > 0).length;
    const downCount = prints.filter((p) => p.closeMovePct < 0).length;
    const upPct = n > 0 ? round2((upCount / n) * 100) : 0;
    const downPct = n > 0 ? round2((downCount / n) * 100) : 0;
    // Adverse per print: the worse of exit-at-open and exit-at-close.
    const adverseLong = prints.map((p) => Math.min(p.gapPct, p.closeMovePct)).filter((v) => v < 0);
    const adverseShort = prints.map((p) => Math.max(p.gapPct, p.closeMovePct)).filter((v) => v > 0);

    return {
        symbol: symbol.toUpperCase(),
        prints,
        n,
        nVerified: prints.filter((p) => p.verified).length,
        upCount,
        downCount,
        upConsistencyPct: upPct,
        downConsistencyPct: downPct,
        avgAbsMovePct: n > 0 ? round2(prints.reduce((s, p) => s + Math.abs(p.closeMovePct), 0) / n) : 0,
        worstAdverseForLongPct: adverseLong.length ? round2(Math.abs(Math.min(...adverseLong))) : 0,
        worstAdverseForShortPct: adverseShort.length ? round2(Math.max(...adverseShort)) : 0,
        meetsBarLong: n >= EVIDENCE_MIN_PRINTS && upPct >= EVIDENCE_MIN_CONSISTENCY_PCT,
        meetsBarShort: n >= EVIDENCE_MIN_PRINTS && downPct >= EVIDENCE_MIN_CONSISTENCY_PCT,
    };
}

// ---------------------------------------------------------------------------
// End-to-end fetch
// ---------------------------------------------------------------------------

/** IBKR daily-bar time 'YYYYMMDD' → ISO. */
export function ibkrDailyTimeToIso(time: string): string {
    const t = time.trim().slice(0, 8);
    return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

/**
 * Fetch bars + report dates and compute the symbol's reaction stats.
 * Throws when bars are unavailable (no IBKR data → no evidence → no bet).
 */
export async function getEarningsReactions(symbol: string): Promise<ReactionStats> {
    const sym = symbol.toUpperCase();
    const raw = await fetchBars(sym, BarSizeSetting.DAYS_ONE, '3 Y', true);
    const bars: DailyCloseBar[] = [];
    for (const b of raw) {
        if (typeof b.time !== 'string' || b.open == null || b.close == null) continue;
        if (!(b.open > 0) || !(b.close > 0)) continue;
        bars.push({ date: ibkrDailyTimeToIso(b.time), open: b.open, close: b.close });
    }
    bars.sort((a, b) => a.date.localeCompare(b.date));
    if (bars.length < 200) {
        throw new Error(`insufficient daily history for ${sym} (${bars.length} bars) — cannot build an earnings record`);
    }

    const verified = await fetchVerifiedDates(sym);
    const oldest = verified.length ? verified[verified.length - 1].date : bars[bars.length - 1].date;
    const inferred = inferOlderReportDates(bars, oldest, Math.max(0, EVIDENCE_MIN_PRINTS + 2 - verified.length));
    return computeReactionStats(sym, bars, [...verified, ...inferred]);
}

// ---------------------------------------------------------------------------
// LIVE-GATE evidence (consumed by the proposal risk gate)
// ---------------------------------------------------------------------------

export interface EarningsBetEvidence {
    /** Does the symbol verifiably print tonight or next-session pre-market?
     *  Null = the calendar could not be checked — the gate FAILS CLOSED. */
    reportsWithinWindow: boolean | null;
    /** The record verdict for the bet's side (print count + consistency).
     *  Null = no record could be built — no evidence base, no bet. */
    meetsBar: boolean | null;
    nPrints: number | null;
    consistencyPct: number | null;
    /** The record's worst adverse move for the side (%): the number the
     *  proposal's worstCaseGapPct must not understate. */
    recordWorstAdversePct: number | null;
}

/**
 * Server-side evidence for the earnings-bet LIVE-GATE checks. Never
 * throws: a data failure returns nulls, and the gate refuses on null —
 * the evidence bar must not be satisfiable by breaking the data source.
 * (The bar's third leg — one supporting EXTERNAL signal — stays with the
 * judgment layer: signal types beyond the Polymarket market are not
 * machine-checkable, and "market absent" must never kill a valid bet.)
 */
export async function fetchEarningsBetEvidence(
    symbol: string,
    direction: 'long' | 'short',
): Promise<EarningsBetEvidence> {
    const { reportsInBetWindow } = await import('./earnings-calendar.js');
    const reportsWithinWindow = await reportsInBetWindow(symbol).catch(() => null);
    try {
        const stats = await getEarningsReactions(symbol);
        return {
            reportsWithinWindow,
            meetsBar: direction === 'long' ? stats.meetsBarLong : stats.meetsBarShort,
            nPrints: stats.n,
            consistencyPct: direction === 'long' ? stats.upConsistencyPct : stats.downConsistencyPct,
            recordWorstAdversePct: direction === 'long' ? stats.worstAdverseForLongPct : stats.worstAdverseForShortPct,
        };
    } catch (err) {
        logger.warn(`[earnings-reactions] ${symbol}: no evidence base for the bet gate (${err instanceof Error ? err.message : err})`);
        return { reportsWithinWindow, meetsBar: null, nPrints: null, consistencyPct: null, recordWorstAdversePct: null };
    }
}
