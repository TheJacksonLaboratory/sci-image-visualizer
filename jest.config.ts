/* eslint-disable */
export default {
  displayName: 'sci-image-visualizer',
  preset: 'jest-preset-angular',
  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  coverageDirectory: '<rootDir>/coverage',
  // testing/ holds test doubles (fake OSD viewer, port stubs), not library code.
  coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/src/lib/testing/'],
  // The current floor: `npm run test:coverage` fails if a change drops below it.
  coverageThreshold: {
    global: { lines: 80, branches: 65 },
  },
  // napari-js's bundle uses native class fields with code before `super()` (HeadlessViewer).
  // The ts transform below lowers class fields (target es2020, useDefineForClassFields: false)
  // and moves the initialisers above `super()`, which throws; esbuild lowers them correctly.
  // (A second ts transform entry with another target would not help: ts-jest keeps one
  // compiler config per jest project.)
  globals: { ngJest: { processWithEsbuild: ['**/node_modules/napari-js/dist/*.js'] } },
  transform: {
    '^.+\\.(ts|mjs|js|html)$': [
      'jest-preset-angular',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
        stringifyContentPathRegex: '\\.(html|svg)$',
      },
    ],
  },
  // napari-js, image-js and image-js's ESM dependency tree ship untranspiled ESM in
  // node_modules; transform those (plus any .mjs) so jest can load them.
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$|napari-js|image-js|@swiftcarrot|blob-util|canny-edge-detector|fast-bmp|fast-jpeg|fast-list|fast-png|has-own|image-type|is-any-array|is-array-type|is-integer|jpeg-js|js-priority-queue|js-quantities|median-quickselect|ml-.*|monotone-chain-convex-hull|new-array|robust-point-in-polygon|tiff|web-worker-manager))',
  ],
  // The real napari-js, through its GPU-free `napari-js/testing` entry: the whole public API
  // with `Viewer` bound to `HeadlessViewer` (the real model, layers and canvas maths, no
  // device). Every entry imports the one shared chunk, so classes are identical across them.
  moduleNameMapper: {
    '^napari-js$': '<rootDir>/node_modules/napari-js/dist/testing.js',
    '^napari-js/(testing|overlays|colormaps|geometry)$': '<rootDir>/node_modules/napari-js/dist/$1.js',
  },
  snapshotSerializers: [
    'jest-preset-angular/build/serializers/no-ng-attributes',
    'jest-preset-angular/build/serializers/ng-snapshot',
    'jest-preset-angular/build/serializers/html-comment',
  ],
};
