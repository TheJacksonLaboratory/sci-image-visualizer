// Stage the built library into node_modules so the example's Angular build
// (@analogjs/vite-plugin-angular) runs the partial-Ivy LINKER on its FESM. Consumed
// via a `../../dist` alias the linker is skipped and components fall back to JIT
// (unavailable in production → "JIT compiler unavailable"). Run before build/serve.
import { rmSync, mkdirSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = root + 'dist';
const scope = root + 'node_modules/@jax-data-science';
const dest = scope + '/sci-image-visualizer';

if (!existsSync(dist)) {
  console.error('stage-lib: dist/ not found — run `npm run build` first.');
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(scope, { recursive: true });
cpSync(dist, dest, { recursive: true });
console.log('stage-lib: dist -> node_modules/@jax-data-science/sci-image-visualizer (linker will AOT-compile it)');

// The library references its toolbar icons at `assets/plotting/*` (jit-ui maps
// src/lib/assets -> /assets/plotting/). Mirror that for the example: copy them
// into public/ so Vite emits them to dist/assets/plotting/ (served at that path).
const libAssets = dest + '/src/lib/assets';
const publicPlotting = root + 'examples/browser-image/public/assets/plotting';
if (existsSync(libAssets)) {
  rmSync(root + 'examples/browser-image/public/assets', { recursive: true, force: true });
  mkdirSync(publicPlotting, { recursive: true });
  cpSync(libAssets, publicPlotting, { recursive: true });
  console.log('stage-lib: library assets -> public/assets/plotting');
  // region-editor references assets/icons/{polyline,wand}.svg (host-provided in
  // jit-ui); the library bundles those at the assets ROOT. Serve the flat asset
  // files at /assets/icons too so they resolve (the icons/ subfolder is colormaps).
  const publicIcons = root + 'examples/browser-image/public/assets/icons';
  mkdirSync(publicIcons, { recursive: true });
  for (const e of readdirSync(libAssets, { withFileTypes: true }))
    if (e.isFile()) cpSync(libAssets + '/' + e.name, publicIcons + '/' + e.name);
  console.log('stage-lib: flat library icons -> public/assets/icons');
}
