/**
 * Vehicle complexes (REQ-SCAN-007/008, live-loop WP1) — the config-backed
 * knowledge that a leveraged/sector ETF and its constituents are ONE
 * information source. See src/config/vehicle-complexes.yaml for the why.
 *
 * Pure helpers over a parsed list; the loader reads the yaml once (the
 * file is a strategy-fingerprint surface, so a change means a restart and
 * a new epoch anyway). Validation is fail-LOUD (WP0.1 pattern): a
 * malformed complex file refuses to load rather than silently disabling
 * the rules that depend on it.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface VehicleComplex {
    name: string;
    vehicles: string[];
    constituents: string[];
}

const TICKER_RE = /^[A-Z][A-Z0-9.]{0,5}$/;

function parseList(raw: string, complex: string, field: string): string[] {
    const items = raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.toUpperCase());
    if (items.length === 0) {
        throw new Error(`[vehicle-complexes] complex '${complex}' has an empty ${field} list`);
    }
    for (const t of items) {
        if (!TICKER_RE.test(t)) throw new Error(`[vehicle-complexes] complex '${complex}' ${field}: '${t}' is not a ticker`);
    }
    return [...new Set(items)];
}

/**
 * Pure: parse the two-level yaml (`name:` then indented `vehicles:` /
 * `constituents:` comma lists). Throws on: a missing list, a non-ticker,
 * a vehicle appearing in two complexes, or a symbol that is both a vehicle
 * and a constituent anywhere (the dedupe rules would contradict).
 */
export function parseVehicleComplexes(text: string): VehicleComplex[] {
    const out: VehicleComplex[] = [];
    let current: { name: string; vehicles?: string[]; constituents?: string[] } | null = null;
    const flush = () => {
        if (!current) return;
        if (!current.vehicles) throw new Error(`[vehicle-complexes] complex '${current.name}' has no vehicles list`);
        if (!current.constituents) throw new Error(`[vehicle-complexes] complex '${current.name}' has no constituents list`);
        out.push({ name: current.name, vehicles: current.vehicles, constituents: current.constituents });
        current = null;
    };
    for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
        if (!line.trim()) continue;
        const indented = /^\s/.test(line);
        const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (!m) throw new Error(`[vehicle-complexes] cannot parse line: ${rawLine.trim()}`);
        const [, key, value] = m;
        if (!indented) {
            flush();
            current = { name: key };
            continue;
        }
        if (!current) throw new Error(`[vehicle-complexes] '${key}' appears before any complex name`);
        if (key === 'vehicles') current.vehicles = parseList(value, current.name, 'vehicles');
        else if (key === 'constituents') current.constituents = parseList(value, current.name, 'constituents');
        else throw new Error(`[vehicle-complexes] complex '${current.name}': unknown field '${key}'`);
    }
    flush();

    // Cross-complex invariants.
    const vehicleOwner = new Map<string, string>();
    const allVehicles = new Set<string>();
    for (const c of out) {
        for (const v of c.vehicles) {
            const owner = vehicleOwner.get(v);
            if (owner) throw new Error(`[vehicle-complexes] vehicle ${v} belongs to both '${owner}' and '${c.name}' — a vehicle has one complex`);
            vehicleOwner.set(v, c.name);
            allVehicles.add(v);
        }
    }
    for (const c of out) {
        for (const k of c.constituents) {
            if (allVehicles.has(k)) throw new Error(`[vehicle-complexes] ${k} is listed as a vehicle and as a constituent (complex '${c.name}')`);
        }
    }
    return out;
}

let cached: VehicleComplex[] | null = null;

/** Load (once) the shipped config. Throws on a malformed file. */
export function loadVehicleComplexes(): VehicleComplex[] {
    if (cached) return cached;
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '../config/vehicle-complexes.yaml');
    cached = parseVehicleComplexes(readFileSync(path, 'utf-8'));
    return cached;
}

/** Every complex `symbol` belongs to (as vehicle or constituent). */
export function complexesOf(symbol: string, complexes: VehicleComplex[] = loadVehicleComplexes()): VehicleComplex[] {
    const s = symbol.trim().toUpperCase();
    return complexes.filter((c) => c.vehicles.includes(s) || c.constituents.includes(s));
}

export function isVehicle(symbol: string, complexes: VehicleComplex[] = loadVehicleComplexes()): boolean {
    const s = symbol.trim().toUpperCase();
    return complexes.some((c) => c.vehicles.includes(s));
}

/** Floor under the ATR bar: below a 1% raw move even a low-ATR name has not
 *  moved enough to be a sector-day observation. */
export const COMPLEX_ADMISSION_MIN_ATR = 1.0;
export const COMPLEX_ADMISSION_FLOOR_PCT = 1.0;

/**
 * Pure (REQ-SCAN-007): should a constituent join the candidate set on a
 * vehicle sighting? RAW signed move (direction is the OUTPUT), admitted
 * when |move| ≥ max(1% floor, one daily ATR%). No ATR → no admission (the
 * rule never guesses a bar). The MU case: +4.1% on a 3.5% ATR name admits.
 */
export function complexAdmission(rawMovePct: number | null, dailyAtrPct: number | null): 'long' | 'short' | null {
    if (rawMovePct == null || !Number.isFinite(rawMovePct)) return null;
    if (dailyAtrPct == null || !(dailyAtrPct > 0)) return null;
    const bar = Math.max(COMPLEX_ADMISSION_FLOOR_PCT, COMPLEX_ADMISSION_MIN_ATR * dailyAtrPct);
    if (Math.abs(rawMovePct) < bar) return null;
    return rawMovePct > 0 ? 'long' : 'short';
}

/**
 * Pure (REQ-SCAN-008): the first working row on ANY complex of `symbol`
 * whose direction opposes the proposal, or null. `excludeId` keeps a row
 * from being its own rival at the accept-time re-check.
 */
export function oppositeDirectionConflict(
    symbol: string,
    direction: 'long' | 'short',
    working: Array<{ id: string; symbol: string; direction: 'long' | 'short' }>,
    complexes: VehicleComplex[] = loadVehicleComplexes(),
    excludeId?: string,
): { rivalId: string; rivalSymbol: string; complex: string } | null {
    const mine = complexesOf(symbol, complexes);
    if (mine.length === 0) return null;
    for (const c of mine) {
        const members = new Set([...c.vehicles, ...c.constituents]);
        for (const w of working) {
            if (excludeId && w.id === excludeId) continue;
            if (w.direction === direction) continue;
            if (members.has(w.symbol.trim().toUpperCase())) {
                return { rivalId: w.id, rivalSymbol: w.symbol.toUpperCase(), complex: c.name };
            }
        }
    }
    return null;
}
