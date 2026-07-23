import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import angular from '@analogjs/vite-plugin-angular';

const here = fileURLToPath(new URL('.', import.meta.url));
const tsconfig = fileURLToPath(new URL('./tsconfig.json', import.meta.url));

/**
 * Vite is deliberately the runner here: it builds this Angular example today (via
 * the Analog plugin) and can build a React / vanilla web-component example
 * tomorrow with a different plugin — one toolchain as the library grows
 * framework-agnostic consumers.
 *
 * The library is consumed from node_modules (staged there by scripts/stage-lib.mjs,
 * run via prebuild/prestart:example) — NOT via an alias — so Analog's linker
 * AOT-compiles its partial-Ivy FESM instead of leaving it to fail at runtime JIT.
 */
export default defineConfig({
  root: here,
  // Absolute base: the internal repo's Pages URL is a *.pages.github.io ROOT, so '/'
  // works AND keeps dynamic imports / workers / the ORT WASM path robust (a relative
  // base is fragile for those). When the repo goes PUBLIC (served under
  // /sci-image-visualizer/), set PAGES_BASE=/sci-image-visualizer/ in the Pages workflow.
  base: process.env.PAGES_BASE || '/',
  plugins: [angular({ tsconfig })],
  resolve: {
    alias: {
      // ml-matrix (via image-js) is CJS with circular requires, and its package
      // exports has no `import` condition — so Vite's rollup build picks the CJS
      // entry, whose init crashes as `(void 0).Matrix`. Force the pure-ESM source
      // (matrix.mjs just re-wraps the CJS).
      'ml-matrix': fileURLToPath(new URL('../../node_modules/ml-matrix/src/index.js', import.meta.url)),
    },
  },
  // Bridge the mixed ESM/CJS dep graph (image-js + its ml-* deps) for the build.
  build: { commonjsOptions: { transformMixedEsModules: true } },
  // .dcm has no built-in loader — treat the bundled DICOM series as static assets
  // so the import.meta.glob('*.dcm', {query:"?url"}) resolves each to a served URL.
  assetsInclude: ["**/*.dcm"],
  optimizeDeps: {
    // Skip auto-scanning the HTML entry: Vite's dep-scan esbuild chokes on
    // Angular's @Inject() parameter decorators before Analog transforms the files.
    // List the deps to pre-bundle instead; esbuildOptions.tsconfig carries
    // experimentalDecorators too.
    entries: [],
    include: [
      'openseadragon', 'plotly.js-dist-min', 'image-js', 'file-saver', 'buffer',
      'rxjs', '@angular/common', '@angular/core', '@angular/forms', '@angular/common/http',
    ],
    esbuildOptions: { tsconfig },
  },
});
