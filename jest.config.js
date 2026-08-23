/**
 * Jest configuration — secondary test runner.
 *
 * The primary runner is `bun test` (package.json "test"). This config lets
 * the same colocated .test.ts files under src run with jest on machines
 * without bun: `npm run test:jest`. 'bun:test' imports are bridged to
 * @jest/globals via test/bun-test-shim.ts.
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  moduleNameMapper: {
    '^bun:test$': '<rootDir>/test/bun-test-shim.ts',
    '^@/(.*)\\.js$': '<rootDir>/src/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    // Transform TypeScript files with ts-jest
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.json',
      },
    ],
    // Transform ESM JavaScript packages from node_modules with babel-jest
    'node_modules/(p-retry|is-network-error|@langchain)/.+\\.js$': [
      'babel-jest',
      {
        presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
      },
    ],
  },
  // Transform ESM packages from node_modules that Jest can't handle natively
  transformIgnorePatterns: [
    'node_modules/(?!(p-retry|is-network-error|@langchain)/)',
  ],
  // REQ-TEST-001: unconditional DB isolation before any suite imports the
  // stores — the production DEXTER_DATA_DIR must never survive into tests.
  setupFiles: ['<rootDir>/test/test-env.ts'],
  testMatch: ['**/src/**/*.test.ts'],
  testPathIgnorePatterns: [
    '\\\\node_modules\\\\',
    '/node_modules/',
    // bun-only (uses mock.module); runs under `bun test`
    'agent-runner\\.test\\.ts$',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  coverageDirectory: 'coverage',
  verbose: true,
};
