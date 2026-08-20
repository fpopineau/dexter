/**
 * Redacting debug-log sink (WP0.6, REMEDIATION-2026-08-20).
 *
 * The old sinks appended raw JIDs, phone numbers, the entire allowlist and
 * message bodies to an unbounded plaintext file. Every line now passes
 * through redact(), the file rotates at a size cap, and the pre-redaction
 * file is moved aside once so old unredacted lines stop growing.
 */
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';

const MAX_BYTES = 5 * 1024 * 1024;

/** Mask every digit run of 7+ (phone numbers, the number half of JIDs)
 *  down to its last 4. Epoch timestamps get caught too — acceptable: this
 *  is a debug log, and privacy wins over millisecond forensics. */
export function redact(msg: string): string {
    return msg.replace(/\d{7,}/g, (m) => `…${m.slice(-4)}`);
}

/** Build a sink bound to `path`: redact → size-capped rotate → append.
 *  Logging must never throw into the message path. */
export function makeDebugLog(path: string): (msg: string) => void {
    // One-time migration: park the existing unredacted file. Idempotent —
    // keyed on the .pre-redaction file's absence. Both stay gitignored.
    try {
        if (existsSync(path) && !existsSync(`${path}.pre-redaction`)) {
            renameSync(path, `${path}.pre-redaction`);
        }
    } catch { /* best effort */ }
    return (msg: string) => {
        try {
            try {
                if (statSync(path).size > MAX_BYTES) {
                    try { unlinkSync(`${path}.1`); } catch { /* absent */ }
                    renameSync(path, `${path}.1`);
                }
            } catch { /* file absent yet — first write creates it */ }
            appendFileSync(path, `${new Date().toISOString()} ${redact(msg)}\n`);
        } catch { /* never throw from logging */ }
    };
}
