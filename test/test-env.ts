/**
 * Test-runner preload (REQ-TEST-001, review 2026-08-23 P0).
 *
 * A verification run wrote 14 synthetic rows into the REAL proposals.db:
 * `.env` supplies DEXTER_DATA_DIR (bun auto-loads .env, jest can inherit
 * it), and suites that isolated with `??=` kept the production path. The
 * store caches its SQLite handle process-wide, so one unisolated import
 * poisons the entire run.
 *
 * This preload runs BEFORE any suite imports anything and UNCONDITIONALLY
 * points DEXTER_DATA_DIR at a fresh temp directory. Suites that make their
 * own temp dir still may (plain assignment overrides); nothing can fall
 * through to production. Loaded via bunfig.toml [test].preload and
 * jest.config.js setupFiles — never use `??=` for database isolation.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DEXTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dexter-test-'));

// Operator-environment leaks that change behavior under test: the shadow
// profile override flipped three profile tests when set in the shell.
delete process.env.DEXTER_RISK_PROFILE;
