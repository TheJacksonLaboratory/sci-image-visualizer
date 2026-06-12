/* eslint-disable */
export default {
  displayName: 'jax-image-visualization',
  preset: '../../jest.preset.js',
  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  globals: {
    'ts-jest': {
      tsconfig: '<rootDir>/tsconfig.spec.json',
      stringifyContentPathRegex: '\\.(html|svg)$',
    },
  },
  coverageDirectory: '../../coverage/libs/jax-image-visualization',
  // text-summary: compact totals in the CI log; json-summary: parsed for the
  // GitHub job summary table; lcov: HTML + machine-readable report.
  coverageReporters: ['text-summary', 'json-summary', 'lcov'],
  // Ratchet gate: CI (which runs with --codeCoverage) fails if coverage drops
  // below these floors. Set just under the current numbers (lines 70% /
  // statements 68% / functions 61% / branches 51.8%) so normal fluctuation
  // doesn't trip it; raise them as coverage climbs.
  coverageThreshold: {
    global: {
      statements: 67,
      branches: 51,
      functions: 60,
      lines: 69,
    },
  },
  transform: {
    '^.+\\.(ts|mjs|js|html)$': 'jest-preset-angular',
  },
  transformIgnorePatterns: ['node_modules/(?!.*\\.mjs$)'],
  snapshotSerializers: [
    'jest-preset-angular/build/serializers/no-ng-attributes',
    'jest-preset-angular/build/serializers/ng-snapshot',
    'jest-preset-angular/build/serializers/html-comment',
  ],
};
