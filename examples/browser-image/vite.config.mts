import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import angular from '@analogjs/vite-plugin-angular';

const here = fileURLToPath(new URL('.', import.meta.url));
const tsconfig = fileURLToPath(new URL('./tsconfig.json', import.meta.url));
const libDist = fileURLToPath(new URL('../../dist', import.meta.url));

/**
 * Vite is deliberately the runner here: it builds this Angular example today (via
 * the Analog plugin) and can build a React / vanilla web-component example
 * tomorrow with a different plugin — one toolchain as the library grows
 * framework-agnostic consumers.
 */
export default defineConfig(({ command }) => ({
  root: here,
  // Relative base so the built site works at ANY mount path: GitHub Pages serves
  // an internal repo at a randomized *.pages.github.io *root*, and a public repo
  // at <org>.github.io/sci-image-visualizer/. Dev serves at the root.
  base: command === 'build' ? './' : '/',
  plugins: [angular({ tsconfig })],
  // image-js pulls CJS deps (ml-matrix) into an otherwise-ESM graph; without this
  // the production rollup build resolves their namespace to undefined at runtime.
  // ml-matrix (via image-js) is CJS with circular requires; rollup executes it
  // before init, yielding `(void 0).Matrix` at runtime. strictRequires wraps CJS
  // so execution defers to first require, and transformMixedEsModules bridges the
  // ESM/CJS graph. (Dev's esbuild pre-bundling didn't hit this; the rollup build did.)
  build: { commonjsOptions: { transformMixedEsModules: true } },
  resolve: {
    // Consume the BUILT library exactly as an external app would (from dist/).
    // Run `npm run build` in the repo root first so dist/ exists.
    alias: {
      '@jax-data-science/sci-image-visualizer': libDist,
      // ml-matrix's package exports has no `import` condition, so Vite's build
      // picks its CJS entry, whose circular require crashes as `(void 0).Matrix`.
      // Force the pure-ESM source (matrix.mjs just re-wraps the CJS).
      'ml-matrix': fileURLToPath(new URL('../../node_modules/ml-matrix/src/index.js', import.meta.url)),
    },
  },
  optimizeDeps: {
    // Skip auto-scanning the HTML entry: Vite's dep-scan esbuild chokes on
    // Angular's @Inject() parameter decorators before Analog transforms the
    // files. List the deps to pre-bundle instead (Vite optimizes the rest on
    // demand); esbuildOptions.tsconfig carries experimentalDecorators too.
    entries: [],
    include: [
      'openseadragon', 'plotly.js-dist-min', 'image-js', 'file-saver', 'buffer',
      'rxjs', '@angular/common', '@angular/core', '@angular/forms', '@angular/common/http',
    ],
    esbuildOptions: { tsconfig },
  },
}));
