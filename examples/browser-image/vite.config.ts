import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import angular from '@analogjs/vite-plugin-angular';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite is deliberately the runner here: it builds this Angular example today (via
 * the Analog plugin) and can build a React / vanilla web-component example
 * tomorrow with a different plugin — one toolchain as the library grows
 * framework-agnostic consumers.
 */
export default defineConfig({
  root: here,
  plugins: [angular()],
  resolve: {
    alias: {
      // Consume the BUILT library exactly as an external app would (from dist/).
      // Run `npm run build` in the repo root first so dist/ exists.
      '@jax-data-science/sci-image-visualizer': fileURLToPath(new URL('../../dist', import.meta.url)),
    },
  },
  optimizeDeps: {
    include: ['openseadragon', 'plotly.js-dist-min', '@angular/common', '@angular/core'],
  },
});
