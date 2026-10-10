/* eslint-disable */
export default {
  displayName: 'sci-image-visualizer',
  preset: 'jest-preset-angular',
  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  coverageDirectory: '<rootDir>/coverage',
  // The napari-js stub is test infrastructure, not library code.
  coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/src/lib/testing/'],
  // The current floor: `npm run test:coverage` fails if a change drops below it.
  coverageThreshold: {
    global: { lines: 80, branches: 65 },
  },
  transform: {
    '^.+\\.(ts|mjs|js|html)$': [
      'jest-preset-angular',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
        stringifyContentPathRegex: '\\.(html|svg)$',
      },
    ],
  },
  // image-js and its ESM dependency tree ship untranspiled ESM in node_modules;
  // transform those (plus any .mjs) so jest can load them.
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$|image-js|@swiftcarrot|blob-util|canny-edge-detector|fast-bmp|fast-jpeg|fast-list|fast-png|has-own|image-type|is-any-array|is-array-type|is-integer|jpeg-js|js-priority-queue|js-quantities|median-quickselect|ml-.*|monotone-chain-convex-hull|new-array|robust-point-in-polygon|tiff|web-worker-manager))',
  ],
  // napari-js ships ESM-only and needs a real WebGPU device, so unit tests use a
  // stub (the real package is used by the ng-packagr build). See testing/napari-js-stub.ts.
  moduleNameMapper: {
    '^napari-js$': '<rootDir>/src/lib/testing/napari-js-stub.ts',
  },
  snapshotSerializers: [
    'jest-preset-angular/build/serializers/no-ng-attributes',
    'jest-preset-angular/build/serializers/ng-snapshot',
    'jest-preset-angular/build/serializers/html-comment',
  ],
};
