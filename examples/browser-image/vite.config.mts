import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import angular from '@analogjs/vite-plugin-angular';

const here = fileURLToPath(new URL('.', import.meta.url));
const tsconfig = fileURLToPath(new URL('./tsconfig.json', import.meta.url));

/** Staged library's FESM dir — holds the worker bodies `bundle-workers` emitted. */
const libFesm = fileURLToPath(
  new URL('../../node_modules/@jax-data-science/sci-image-visualizer/fesm2022/', import.meta.url),
);

/**
 * Dev-server only: make the library's web workers loadable out of the PRE-BUNDLED
 * dep. Unlike cellpose-js (excluded below), the library can't opt out of
 * pre-bundling — that esbuild pass is the only place Analog's linker AOT-compiles
 * its partial-Ivy FESM (see the note above), since the plugin's transform hook
 * skips node_modules.
 *
 * The library starts its workers with
 * `new Worker(new URL('./x.worker', import.meta.url), { type: 'module' })`
 * (onnx-sam.worker for SAM, mask.worker for the region editor's mask export).
 * esbuild copies that `new URL` into the optimized chunk verbatim WITHOUT emitting
 * the worker body, so Vite's worker-import-meta-url plugin resolves it next to the
 * chunk — `node_modules/.vite/deps/x.worker` — where nothing exists. The dev server
 * serves index.html for it and the browser rejects the worker script
 * ("non-JavaScript MIME type of text/html"), which surfaces as "SAM worker crashed".
 *
 * Point those requests at the real worker bundles `npm run bundle-workers` emitted
 * next to the FESM. Vite serves them through its normal pipeline, so each worker's
 * bare `onnxruntime-web` / `fast-png` imports get rewritten as usual. The production
 * build needs none of this: rollup resolves `./x.worker` -> `x.worker.js` itself and
 * emits proper worker chunks (dist/assets/{onnx-sam,mask}.worker-*.js).
 */
function stagedLibWorkers(): Plugin {
  // e.g. /@fs/…/node_modules/.vite/deps/onnx-sam.worker?worker_file&type=module
  const depsWorkerRE = /\/\.vite\/deps\/([\w.-]+\.worker)(\?[^#]*)?$/;
  return {
    name: 'example:staged-lib-workers',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const m = req.url?.match(depsWorkerRE);
        if (m) req.url = `/@fs${libFesm}${m[1]}.js${m[2] ?? ''}`;
        next();
      });
    },
  };
}

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
  plugins: [angular({ tsconfig }), stagedLibWorkers()],
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
    // cellpose-js instantiates its inference worker via
    // new Worker(new URL(./inference.worker.js, import.meta.url)). Vite's dep
    // pre-bundling turns that into a .vite/deps asset served with an empty MIME, so
    // the worker load is blocked (NS_ERROR_CORRUPTED_CONTENT). Excluding it makes
    // Vite serve the dep + its worker from source, with the correct MIME.
    exclude: ['cellpose-js'],
    include: [
      'openseadragon', 'plotly.js-dist-min', 'image-js', 'file-saver', 'buffer',
      'rxjs', '@angular/common', '@angular/core', '@angular/forms', '@angular/common/http',
    ],
    esbuildOptions: { tsconfig },
  },
});
