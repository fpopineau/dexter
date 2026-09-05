/**
 * Validation journal writer (live-loop WP3) — one line per epoch start/stop,
 * ladder step and promotion, appended to docs/day2day/VALIDATION-JOURNAL.md
 * (REQ-EPOCH-001/002, REQ-LADDER-001/002, REQ-EPOCH-004). Docs are outside
 * the strategy identity, so the control plane may write them. Best-effort:
 * a failed append is logged loudly and reported by the caller; it never
 * blocks the action it records.
 */

import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/utils';

export function journalPath(): string {
    return process.env.DEXTER_JOURNAL_PATH ?? join(process.cwd(), 'docs', 'day2day', 'VALIDATION-JOURNAL.md');
}

/** Append `- <ISO date> — <line>`; returns whether the write landed. */
export function appendJournalLine(line: string, path: string = journalPath(), now: number = Date.now()): boolean {
    const day = new Date(now).toISOString().slice(0, 10);
    const entry = `- ${day} — ${line.replace(/\s+/g, ' ').trim()}\n`;
    try {
        if (!existsSync(path)) {
            logger.error(`[journal] ${path} does not exist — journal line NOT recorded: ${entry.trim()}`);
            return false;
        }
        appendFileSync(path, entry);
        return true;
    } catch (err) {
        logger.error(`[journal] append failed (${err instanceof Error ? err.message : err}) — line NOT recorded: ${entry.trim()}`);
        return false;
    }
}
