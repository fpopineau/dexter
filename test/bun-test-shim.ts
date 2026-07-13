/**
 * bun:test → jest bridge.
 *
 * Tests in this repo import from 'bun:test' (the primary runner is
 * `bun test`). jest.config.js maps 'bun:test' to this shim so the same
 * files also run under `npm run test:jest` on machines without bun.
 *
 * Not bridged: `mock.module` (bun-only) — tests that need it are listed in
 * testPathIgnorePatterns and run under bun only.
 */

export {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    test,
} from '@jest/globals';

import { jest as jestGlobal } from '@jest/globals';

/** Minimal stand-in for bun's `mock()` function factory. */
export const mock = Object.assign(
    (fn?: (...args: unknown[]) => unknown) => jestGlobal.fn(fn),
    {
        module: () => {
            throw new Error('mock.module is bun-only — exclude this test from the jest run');
        },
        restore: () => jestGlobal.restoreAllMocks(),
    },
);
