/**
 * Post-build step: bundle the web workers into the FESM directory.
 *
 * The library launches workers via `new Worker(new URL('./x.worker', import.meta.url))`.
 * ng-packagr references those URLs in the FESM but does NOT emit the worker bodies,
 * so a consuming bundler can't resolve them. Here we esbuild each worker into a
 * self-contained ESM file next to the FESM (`dist/fesm2022/<name>.worker.js`),
 * inlining the library's own code but keeping npm peer deps (onnxruntime-web,
 * fast-png, @angular/*) as bare imports — the consumer's bundler re-bundles the
 * worker and resolves those from its own node_modules. `.js` (not `.mjs`) so the
 * extensionless `./x.worker` reference resolves under default bundler settings.
 */
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const common = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  packages: 'external',        // keep bare (npm) imports external; inline only relative code
  tsconfig: 'tsconfig.json',   // experimentalDecorators for the @Injectable services pulled in
  logLevel: 'warning',
};

/**
 * `inline` names npm deps to bundle IN rather than leave bare.
 *
 * Only for a dep the consumer's bundler cannot leave alone. A worker whose bare imports
 * are all STATIC is fine external: the consumer inlines them into the single worker chunk.
 * A DYNAMIC one is not — it forces a second chunk, and Vite builds workers as IIFE by
 * default, which cannot code-split. That is a hard build failure in the consumer, not a
 * warning:
 *
 *   [vite:worker-import-meta-url] Invalid value "iife" for option "output.format" —
 *   UMD and IIFE output formats are not supported for code-splitting builds.
 *
 * @jax-js/jax is exactly that case, twice over: tsne-gpu imports it dynamically, and its
 * own index then dynamically imports its webgpu and webgl chunks. Bundling it here (with
 * esbuild splitting off, so every dynamic import is inlined) leaves one self-contained
 * file, and the consumer needs no `worker.format` setting of its own. It costs ~670 kB in
 * a file nothing fetches until someone asks for a t-SNE — the worker boundary is what
 * makes jax-js lazy, so nothing is lost by making the import inside it eager.
 */
const workers = [
  { in: 'src/lib/region-editor/mask.worker.ts',            out: 'dist/fesm2022/mask.worker.js' },
  { in: 'src/lib/toolbar/segmentation/onnx-sam.worker.ts', out: 'dist/fesm2022/onnx-sam.worker.js' },
  {
    in: 'src/lib/spatial/tsne.worker.ts',
    out: 'dist/fesm2022/tsne.worker.js',
    inline: ['@jax-js/jax'],
  },
];

for (const w of workers) {
  const options = { ...common, entryPoints: [w.in], outfile: w.out };
  if (w.inline?.length) {
    // esbuild has no "external except these", so drop the blanket setting and list the
    // externals explicitly. Anything not named here is bundled in.
    delete options.packages;
    options.external = ['@angular/*', 'rxjs', 'rxjs/*'];
  }
  await build(options);

  // A dynamic import surviving into the output is the failure described above, and it
  // fails in the CONSUMER's build rather than here — so assert it now, where the cause is
  // still in view.
  const emitted = await readFile(w.out, 'utf8');
  const leaked = [...new Set(
    [...emitted.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
  )];
  if (leaked.length) {
    throw new Error(
      `${w.out} keeps a dynamic import of ${leaked.join(', ')}. `
      + 'A consuming Vite build defaults workers to IIFE and cannot code-split; '
      + 'add the package to `inline` above.',
    );
  }
  const kb = (Buffer.byteLength(emitted) / 1024).toFixed(0);
  console.log(`  bundled ${w.in} -> ${w.out} (${kb} kB)`);
}
console.log('workers bundled into dist/fesm2022/');
