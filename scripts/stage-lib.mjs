// Stage the built library into node_modules so the example's Angular build
// (@analogjs/vite-plugin-angular) runs the partial-Ivy LINKER on its FESM. Consumed
// via a `../../dist` alias the linker is skipped and components fall back to JIT
// (unavailable in production → "JIT compiler unavailable"). Run before build/serve.
import { rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
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
