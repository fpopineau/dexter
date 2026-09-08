/**
 * Operator epoch stop — `bun run scripts/epoch-stop.ts "<reason>"`.
 *
 * Closes the RUNNING epoch with a stated reason through the very path the
 * REJECT look and the −5 % hard stop use (`stopEpoch`: status → stopped,
 * live switch OFF, one journal line). No gateway restart is needed: the
 * gateway reads `epoch-state.json` on every accept, so new entries pause
 * the moment the file is written (exits, triage and the guardian keep
 * running). The next `epoch new` opens the following epoch without a
 * confirm step — the current one is already stopped.
 *
 * Use it for a NON-statistical closure — a coverage correction, a fixed
 * defect discovered on the epoch's first days — so the record says so: the
 * look procedure never ran and the epoch must not be read as a REJECT.
 * Control plane: scripts are outside the strategy fingerprint.
 */

import 'dotenv/config';
import { readEpochRecord, stopEpoch } from '../src/services/loop/epoch-control.js';
import { appendJournalLine, journalPath } from '../src/services/loop/journal.js';

const reason = process.argv.slice(2).join(' ').trim();
if (!reason) {
    console.error('usage: bun run scripts/epoch-stop.ts "<reason>"   (the reason is recorded verbatim in the epoch state and the journal)');
    process.exit(2);
}

const before = readEpochRecord();
if (!before) {
    console.error('no epoch state file — nothing to stop (DEXTER_DATA_DIR / .dexter/data)');
    process.exit(1);
}
if (before.status === 'stopped') {
    console.log(`${before.id} is already STOPPED — ${before.stopReason ?? 'no reason recorded'}${before.stoppedAt ? ` (${new Date(before.stoppedAt).toISOString()})` : ''}. Nothing written.`);
    process.exit(0);
}

const now = Date.now();
let journaled = true;
const rec = stopEpoch({
    now,
    reason,
    journal: (line) => { journaled = appendJournalLine(line, journalPath(), now) && journaled; },
});
if (!rec || rec.status !== 'stopped') {
    console.error('stopEpoch did not return a stopped record — check the gateway log');
    process.exit(1);
}
console.log([
    `🛑 ${rec.id} STOPPED ${new Date(now).toISOString()} — ${reason}`,
    `fingerprint ${rec.fingerprint} · started ${new Date(rec.startedAt).toISOString()} · looks done ${rec.looksDone.length}${rec.firstAcceptAt ? ' · ACCEPT recorded' : ''}`,
    `live switch OFF · journal ${journaled ? `line appended (${journalPath()})` : 'NOT WRITTEN — see the log'}`,
    `New entries are paused. Restart the gateway if the code changed, then 'epoch new' opens ${rec.id.replace(/\d+$/, (n) => String(Number(n) + 1))}.`,
].join('\n'));
