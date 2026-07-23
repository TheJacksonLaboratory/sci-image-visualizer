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
  resolve: {
    // Consume the BUILT library exactly as an external app would (from dist/).
    // Run `npm run build` in the repo root first so dist/ exists.
    alias: { '@jax-data-science/sci-image-visualizer': libDist },
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
