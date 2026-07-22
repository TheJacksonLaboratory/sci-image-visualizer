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
export default defineConfig({
  root: here,
  // Served at the repo root in dev; under /sci-image-visualizer/ on GitHub Pages
  // (the CI sets PAGES_BASE). Keep the trailing slash.
  base: process.env.PAGES_BASE || '/',
  plugins: [angular({ tsconfig })],
  resolve: {
    // Consume the BUILT library exactly as an external app would (from dist/).
    // Run `npm run build` in the repo root first so dist/ exists.
    alias: { '@jax-data-science/sci-image-visualizer': libDist },
  },
  optimizeDeps: {
    // Skip auto-scanning the HTML entry: Vite's dep-scan esbuild chokes on
    // Angular's @Inject() parameter decorators before Analog transforms the
    // files. We list the deps to pre-bundle instead (Vite optimizes the rest
    // on demand); esbuildOptions.tsconfig carries experimentalDecorators too.
    entries: [],
    include: [
      'openseadragon',
      'plotly.js-dist-min',
      'image-js',
      'file-saver',
      'buffer',
      'rxjs',
      '@angular/common',
      '@angular/core',
      '@angular/forms',
      '@angular/common/http',
    ],
    esbuildOptions: { tsconfig },
  },
});
