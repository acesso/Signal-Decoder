// Plain @swc/jest setup (no Next.js involved post-migration — next/jest used
// to wrap this and read next.config.js, which no longer exists, and used
// SWC under the hood too). @swc/jest transpiles TS to JS per-file without
// full type-checking (typechecking is covered separately by `tsc -b`) and,
// unlike ts-jest, has no TS `module`-kind gate on `import.meta` syntax —
// needed because ringRecorder.ts uses `import.meta.url` to build its Worker
// URL (for Vite's worker bundling).
/** @type {import('jest').Config} */
const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.cjs'],
  testEnvironment: 'jest-environment-jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^\\$decoder-lib/(.*)$': '<rootDir>/src/lib/$1',
  },
  testMatch: [
    '**/__tests__/**/*.[jt]s?(x)',
    '**/?(*.)+(spec|test).[jt]s?(x)'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
  ],
  transform: {
    '^.+\\.(t|j)sx?$': ['@swc/jest', {
      jsc: {
        parser: { syntax: 'typescript', tsx: true },
        target: 'es2022',
      },
    }],
  },
  collectCoverageFrom: [
    'src/**/*.{js,jsx,ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/*.stories.{js,jsx,ts,tsx}',
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
}

module.exports = customJestConfig
