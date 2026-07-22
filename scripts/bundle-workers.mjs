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

const workers = [
  { in: 'src/lib/region-editor/mask.worker.ts',            out: 'dist/fesm2022/mask.worker.js' },
  { in: 'src/lib/toolbar/segmentation/onnx-sam.worker.ts', out: 'dist/fesm2022/onnx-sam.worker.js' },
];

for (const w of workers) {
  await build({ ...common, entryPoints: [w.in], outfile: w.out });
  console.log(`  bundled ${w.in} -> ${w.out}`);
}
console.log('workers bundled into dist/fesm2022/');
