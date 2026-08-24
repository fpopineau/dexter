/**
 * Pure equity-series arithmetic (REQ-VAL-006) — shared by the gateway
 * sampler (src/services/equity-series.ts) and the read-only validation
 * scorecard, which must not import broker-connected modules.
 */

const ET = 'America/New_York';

export interface EquitySample {
    ts: number;
    netLiq: number;
    /** Unrealized P&L (USD) of open SHADOW-ONLY class positions at sample
     *  time (review 2026-08-23: realized adjustment alone left in-flight
     *  shadow marks distorting the deployable curve). Absent on legacy
     *  lines and when no shadow position was open. */
    shadowUnrealized?: number;
    /** false = a shadow position was open and at least one mark FAILED —
     *  the sample's adjustment is incomplete and the scorecard must not
     *  certify the interval (fail-closed). Absent = nothing to mark. */
    shadowMarkComplete?: boolean;
    /** Strategy fingerprint at sample time (review-17 freeze integrity,
     *  strategy-fingerprint.ts) — the scorecard refuses a window whose
     *  samples mix fingerprints. Absent on legacy lines. */
    fingerprint?: string;
}

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
                out.push({
                    ts: v.ts,
                    netLiq: v.netLiq,
                    ...(typeof v.shadowUnrealized === 'number' && Number.isFinite(v.shadowUnrealized)
                        ? { shadowUnrealized: v.shadowUnrealized } : {}),
                    ...(typeof v.shadowMarkComplete === 'boolean' ? { shadowMarkComplete: v.shadowMarkComplete } : {}),
                    ...(typeof v.fingerprint === 'string' && v.fingerprint ? { fingerprint: v.fingerprint } : {}),
                });
            }
        } catch { /* torn line */ }
    }
    return out.sort((a, b) => a.ts - b.ts);
}

/** Review-18/19, pure: the freeze-purity decision over every fingerprint
 *  seen in the window (proposal rows AND equity samples). STRICT format:
 *  only a 12-hex value counts as a fingerprint — null, empty and
 *  malformed values all normalize to 'ABSENT' (a corrupted stamp proves
 *  nothing, same as no stamp). The window passes only when exactly one
 *  real fingerprint survives. An empty input has nothing to certify —
 *  not ok (fail closed), distinct []. */
export function fingerprintPurity(values: Iterable<string | null | undefined>): { ok: boolean; distinct: string[] } {
    const set = new Set<string>();
    for (const v of values) set.add(v && /^[0-9a-f]{12}$/.test(v) ? v : 'ABSENT');
    return { ok: set.size === 1 && !set.has('ABSENT'), distinct: [...set].sort() };
}

/** Review-21, pure: the freeze THREE-WAY identity comparison. Internal
 *  window purity is not enough — a sample collected entirely on a dirty
 *  tree, committed afterwards, evaluates on a clean checkout with a pure
 *  historical fingerprint and would pass. The sample's one surviving
 *  fingerprint must equal the EVALUATING runtime's fingerprint, and —
 *  once the manifest is filled — the manifest's recorded one. Nulls fail
 *  closed; a still-pending manifest is reported by the caller, never
 *  failed here (the tag does not exist yet). */
export function fingerprintFreezeCheck(input: {
    /** The single surviving window fingerprint (null = purity already failed). */
    sampleFp: string | null;
    /** strategyFingerprint() at evaluation time. */
    currentFp: string | null;
    /** Parsed from the freeze manifest; null = not yet filled. */
    manifestFp: string | null;
    /** Review-22: true once the freeze tag exists (or in an explicit
     *  final evaluation) — a missing/unfilled/malformed manifest then
     *  FAILS instead of passing as pre-tag diagnostics. */
    requireManifest?: boolean;
}): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    if (input.sampleFp === null) problems.push('no single sample fingerprint (window impure)');
    if (input.currentFp === null) problems.push('current runtime identity unresolvable');
    if (input.sampleFp !== null && input.currentFp !== null && input.sampleFp !== input.currentFp) {
        problems.push(`sample fingerprint ${input.sampleFp} != current ${input.currentFp} — the evaluated identity is not the sampled identity`);
    }
    if (input.manifestFp !== null && input.sampleFp !== null && input.manifestFp !== input.sampleFp) {
        problems.push(`manifest fingerprint ${input.manifestFp} != sample ${input.sampleFp}`);
    }
    if (input.requireManifest && input.manifestFp === null) {
        problems.push('freeze manifest fingerprint missing/unfilled/unreadable — REQUIRED once the tag exists (final evaluation)');
    }
    return { ok: problems.length === 0, problems };
}

/** Review-24/25, pure: the mechanical audit of a TAGGED freeze manifest.
 *  Substring counting was not an audit (review-25): deleting a mandatory
 *  row passed, 'not observed' passed, non-waivable observations could be
 *  waived, and the WP2-dependency of the partial-expiry waiver was not
 *  enforced. Now a NAMED-FIELD SCHEMA: every required identity row must
 *  exist with a validly-formatted value; every broker-observation row
 *  must exist and carry 'observed …' (never 'not observed'), with
 *  'WAIVED …' accepted only where the protocol allows a waiver — and the
 *  partial-fill-expiry waiver only when the WP2 resize row itself reads
 *  observed. Placeholder markers anywhere remain failures (belt). The
 *  value grammar is documented in the manifest template. */
const MANIFEST_REQUIRED_FIELDS: Array<{ key: string; validate?: (v: string) => string | null }> = [
    { key: 'Freeze tag' }, // equality with the expected tag checked separately
    { key: 'Behavioral baseline commit SHA', validate: (v) => (/^[0-9a-f]{40}$/.test(v) ? null : 'must be a 40-hex commit SHA') },
    { key: 'Manifest commit docs-only diff verified' },
    { key: 'Tagged at (UTC)' },
    { key: 'Model string' },
    { key: 'Provider string' },
    { key: 'exit_style', validate: (v) => (/^(target|ratchet)\b/.test(v) ? null : "must be 'target' or 'ratchet'") },
    { key: 'Strategy fingerprint', validate: (v) => (/^[0-9a-f]{12}$/.test(v) ? null : 'must be the 12-hex fingerprint the scorecard prints') },
    { key: 'SHA-256 of `.dexter/RULES.md`', validate: (v) => (/[0-9a-f]{64}/.test(v) ? null : 'must contain a 64-hex digest') },
    { key: 'SHA-256 of `performance-epoch.json`', validate: (v) => (/[0-9a-f]{64}/.test(v) ? null : 'must contain a 64-hex digest') },
    { key: 'Epoch NetLiq', validate: (v) => (/\d/.test(v) ? null : 'must record the frozen NetLiq number') },
    { key: 'Scorer-weights provenance' },
    { key: 'risk-rules.live.yaml` ratified' },
];
// minOrderIds (review-27): every broker-interaction observation involves
// at least TWO orders — an OCA close and its cancelled sibling, a parent
// and its removed/surviving children — so one lone id is under-specified
// evidence.
const MANIFEST_OBSERVATIONS: Array<{ key: string; waivable: boolean | 'requires-wp2'; minOrderIds: number }> = [
    { key: 'OCA-joined close', waivable: false, minOrderIds: 2 },
    { key: 'unfilled DAY parent expiry', waivable: false, minOrderIds: 2 },
    { key: 'fully filled DAY parent', waivable: false, minOrderIds: 2 },
    { key: 'PARTIALLY filled DAY parent', waivable: 'requires-wp2', minOrderIds: 2 },
    { key: 'WP2 partial-fill resize', waivable: true, minOrderIds: 0 },
    { key: 'WP11 buffered finalize', waivable: true, minOrderIds: 0 },
];
const PLACEHOLDER_MARKERS = ['_pending_', '_REQUIRED', '_observation or explicit waiver'];

export function auditFreezeManifest(
    man: string,
    expected: { tag: string; deployableClasses: string[] },
): { fingerprint: string | null; baselineSha: string | null; epochSha: string | null; taggedAtMs: number | null; problems: string[] } {
    const problems: string[] = [];
    // Belt: any placeholder marker anywhere is unfilled work.
    for (const marker of PLACEHOLDER_MARKERS) {
        const n = man.split(marker).length - 1;
        if (n > 0) problems.push(`${n} unfilled '${marker}' placeholder(s)`);
    }
    // Two-cell markdown table rows → first-cell key, second-cell value.
    const rows: Array<[string, string]> = [];
    for (const line of man.split('\n')) {
        const m = /^\s*\|([^|]+)\|([^|]+)\|\s*$/.exec(line);
        if (m) rows.push([m[1].trim(), m[2].trim()]);
    }
    const find = (key: string): string | null => rows.find(([k]) => k.includes(key))?.[1] ?? null;
    const isFilled = (v: string): boolean => v.length >= 2 && !PLACEHOLDER_MARKERS.some((p) => v.includes(p));

    for (const field of MANIFEST_REQUIRED_FIELDS) {
        const v = find(field.key);
        if (v === null) { problems.push(`required manifest row missing: '${field.key}'`); continue; }
        if (!isFilled(v)) { problems.push(`required manifest row '${field.key}' is not filled ('${v}')`); continue; }
        const why = field.validate?.(v) ?? null;
        if (why !== null) problems.push(`manifest row '${field.key}': ${why} (got '${v}')`);
    }
    const fingerprint = (() => {
        const v = find('Strategy fingerprint');
        return v !== null && /^[0-9a-f]{12}$/.test(v) ? v : null;
    })();
    const baselineSha = (() => {
        const v = find('Behavioral baseline commit SHA');
        return v !== null && /^[0-9a-f]{40}$/.test(v) ? v : null;
    })();
    const tagRow = find('Freeze tag');
    if (tagRow !== expected.tag) problems.push(`recorded freeze tag '${tagRow ?? 'missing'}' != '${expected.tag}'`);
    // Review-26: the tagged epoch hash and tag time are IDENTITY — the
    // caller compares them against the live epoch file and the git tag
    // timestamp (a post-tag `performance reset` must be detectable).
    const epochSha = (() => {
        const v = find('SHA-256 of `performance-epoch.json`');
        const m = v !== null ? /([0-9a-f]{64})/.exec(v) : null;
        return m?.[1] ?? null;
    })();
    const taggedAtMs = (() => {
        const v = find('Tagged at (UTC)');
        if (v === null) return null;
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : null;
    })();

    // Broker observations: 'observed …' (never 'not observed'); 'WAIVED …'
    // only where the protocol allows it.
    // ANCHORED grammar (the template documents it): the value must BEGIN
    // with its status word — a waiver whose free-text reason mentions
    // 'observed' must not classify as an observation. Review-27: waivers
    // anchor on the EXACT word WAIVED — 'waives'/'waiving'/lowercase are
    // not the documented status and read as invalid.
    const obsStatus = (v: string | null): 'observed' | 'waived' | 'invalid' => {
        if (v === null || !isFilled(v)) return 'invalid';
        if (/^not\s+observed/i.test(v)) return 'invalid';
        if (/^observed\b/i.test(v)) return 'observed';
        if (/^WAIVED\b/.test(v)) return 'waived';
        return 'invalid';
    };
    // Review-27: a REAL calendar date (2026-99-99 must fail) and a
    // ticker-shaped symbol — the round-trip through Date catches
    // impossible months/days the regex shape cannot.
    const isRealDate = (d: string): boolean => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
        const t = new Date(`${d}T00:00:00Z`);
        return Number.isFinite(t.getTime()) && t.toISOString().startsWith(d);
    };
    const isTickerShaped = (s: string): boolean => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s);
    const wp2 = obsStatus(find('WP2 partial-fill resize'));
    for (const obs of MANIFEST_OBSERVATIONS) {
        const v = find(obs.key);
        const s = obsStatus(v);
        if (v === null) { problems.push(`broker-observation row missing: '${obs.key}'`); continue; }
        if (s === 'invalid') { problems.push(`observation '${obs.key}' is neither observed nor a valid waiver ('${v}')`); continue; }
        // Review-26 P2: the status word alone is not EVIDENCE. An
        // observation must carry date + symbol + details (order ids where
        // the broker interaction is the thing observed); a waiver must
        // carry initials and a reason. Bare 'observed'/'WAIVED' fail.
        if (s === 'observed') {
            const m = /^observed\s+(\d{4}-\d{2}-\d{2})\s+(\S+)\s+\S/i.exec(v);
            if (m === null) {
                problems.push(`observation '${obs.key}' lacks the required evidence ('${v}' — grammar: observed YYYY-MM-DD SYMBOL <details>)`);
            } else {
                if (!isRealDate(m[1])) problems.push(`observation '${obs.key}' has an impossible date '${m[1]}'`);
                if (!isTickerShaped(m[2])) problems.push(`observation '${obs.key}' has a non-ticker symbol '${m[2]}'`);
                const ids = (v.match(/#\d+/g) ?? []).length;
                if (ids < obs.minOrderIds) {
                    problems.push(`observation '${obs.key}' records ${ids} broker order id(s) — at least ${obs.minOrderIds} required (every broker interaction here involves multiple orders)`);
                }
            }
        }
        if (s === 'waived') {
            if (!/^WAIVED\s+\S+\s*:\s*\S/.test(v)) {
                problems.push(`waiver on '${obs.key}' lacks initials and a reason ('${v}' — grammar: WAIVED <initials>: <reason>)`);
            }
            if (obs.waivable === false) problems.push(`'${obs.key}' is NOT waivable — a real paper observation is required`);
            if (obs.waivable === 'requires-wp2' && wp2 !== 'observed') {
                problems.push(`'${obs.key}' waiver requires the WP2 partial-fill resize observation to be recorded as observed`);
            }
        }
    }

    const scope = /record them here\)?:?\s*([^\n]*)/.exec(man)?.[1]?.trim() ?? '';
    const KNOWN_CLASSES = ['intraday', 'swing', 'earnings-bet'];
    for (const c of expected.deployableClasses) {
        if (!scope.includes(c)) problems.push(`enabled class '${c}' not recorded in the manifest's deployable scope`);
    }
    for (const c of KNOWN_CLASSES) {
        if (!expected.deployableClasses.includes(c) && scope.includes(c)) {
            problems.push(`manifest scope records '${c}' but it is not enabled`);
        }
    }
    return { fingerprint, baselineSha, epochSha, taggedAtMs, problems };
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
 * interval, the series must prove it was WATCHING the whole EXTENDED
 * session (04:00–20:00 ET — overnight gaps materialize at 04:00, exactly
 * where RTH-only coverage was blind): samples near both edges of the
 * exposed window and no gap over `maxGapMin` (default 20 min against the
 * 5-min sampler). Returns human-readable violations (empty = covered).
 * Holidays/half-days can false-flag — operator judgment; better a false
 * flag than a certified blind spot.
 */
/** The observable session of one ET calendar day (review 2026-08-23):
 *  'closed' = markets shut, nothing owed; 'unknown' = beyond the
 *  maintained calendar — coverage cannot be certified. */
export type SessionWindow = { startMin: number; endMin: number } | 'closed' | 'unknown';

export function exposureCoverageGaps(
    series: EquitySample[],
    intervals: Array<{ from: number; to: number; label: string }>,
    maxGapMin = 20,
    sessionFor?: (dayIso: string) => SessionWindow,
): string[] {
    // Default session: equity can move 04:00-20:00 ET (extended hours) —
    // overnight gap risk materializes AT 04:00. A calendar-aware caller
    // passes `sessionFor` to shorten half-days, drop holidays and refuse
    // days beyond the maintained calendar.
    const DEFAULT_SESSION = { startMin: 4 * 60, endMin: 20 * 60 };
    const fmt = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    // Per exposed day: the merged session sub-window the series must cover,
    // CLIPPED to the actual exposure (an entry at 14:50 does not owe the
    // morning; a close at 10:10 does not owe the afternoon).
    const days = new Map<string, { startMin: number; endMin: number; labels: string[] }>();
    const violations: string[] = [];
    const unknownDays = new Set<string>();
    for (const iv of intervals) {
        if (!(iv.to >= iv.from)) continue;
        const fromDay = etDayOf(iv.from), toDay = etDayOf(iv.to);
        // Noon-anchored stepping (review 2026-08-23): fixed 24h increments
        // from an arbitrary wall time can drift across a DST transition;
        // anchoring near ET noon keeps every step inside its intended day.
        const anchorNoon = iv.from + (12 * 60 - etMinutes(iv.from)) * 60_000;
        for (let k = 0; ; k++) {
            const t = k === 0 ? iv.from : anchorNoon + k * 86_400_000;
            const day = etDayOf(t);
            if (etIsWeekday(t)) {
                const session = sessionFor ? sessionFor(day) : DEFAULT_SESSION;
                if (session === 'unknown') {
                    if (!unknownDays.has(day)) {
                        unknownDays.add(day);
                        violations.push(`${day}: beyond the maintained market calendar — coverage cannot be certified (extend the holiday table)`);
                    }
                } else if (session !== 'closed') {
                    const startMin = day === fromDay ? Math.max(session.startMin, etMinutes(iv.from)) : session.startMin;
                    const endMin = day === toDay ? Math.min(session.endMin, etMinutes(iv.to)) : session.endMin;
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
            }
            if (day === toDay || t > iv.to + 86_400_000) break;
        }
    }
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
