# Browser example — serverless image visualization (Mode B)

A minimal, **fully in-browser** host for `<jaxviz-visualization>`. A gallery of
bundled sample images (large thumbnails on the left) — click one to load it into
the OpenSeadragon view with the zoom + region tools. Or drop in your own file.
No backend, no tile server: each image is handed to OSD as a self-contained
single image (`IImageInfo.tiled === false`).

This is the "serverless" consumption path (SOW Mode B), modeled directly on
jit-ui's `processing-pipeline` preview. A later example will add a small Node/TS
**example server** for the tiled path (Mode A: `/tiles/info`, `/tile`,
`/zoom/region`, `/histogram`), similar to what jit-service provides.

## Files

| File | Role |
|---|---|
| `sample-images/` | Bundled example images (**Git LFS**). PNGs open directly; TIFFs are decoded client-side. |
| `serverless-ports.ts` | The three host DI ports. `ExampleImageStateAdapter` emits `IImageInfo{ tiled:false }`: PNG/JPEG use the URL directly; **TIFF** is decoded in-browser with `image-js` (browsers can't render TIFF) → a PNG blob. `Stub{TileAccess,RegionIo}Adapter` are no-ops. |
| `app.component.ts` | Standalone host: the thumbnail gallery + `<jaxviz-visualization>`; binds `provideVisualization()` + the four ports. |
| `main.ts` | `bootstrapApplication` + the app-level providers the library needs (`HttpClient`, animations, PrimeNG `MessageService`). |
| `index.html`, `vite.config.ts`, `tsconfig.json` | Vite runner (Angular via `@analogjs/vite-plugin-angular`); aliases the package → the built `dist/`. |

> **TIFF caveat:** the two `.tif` samples are multichannel / z-stack files. On
> this serverless path they render as **frame 0**, 8-bit — full z-scrubbing and
> per-channel display are the tiled-server path (Phase 2). PNGs (including the
> 16-bit ones) render directly.

## Sample images are stored in Git LFS

`sample-images/*` is tracked via **Git LFS** (see the repo-root `.gitattributes`,
scoped to this folder). After cloning, pull the actual bytes:

```bash
git lfs install
git lfs pull
```

Without that, the files are tiny LFS pointer stubs and the gallery thumbnails
won't render.

## Run it

```bash
# from the repo root — build the library first (the example consumes dist/):
npm run build

# install the example toolchain (dev-only; not part of the published package):
npm install -D vite@^5 @analogjs/vite-plugin-angular @angular-devkit/build-angular@^17

# serve:
npm run start:example      # → http://localhost:5173
```

> **Angular 17 note:** Analog's plugin targets Angular 18's `@angular/build` by
> default; on Angular 17 it uses the `@angular-devkit/build-angular@^17` peer
> (installed above). When the library moves to Angular 18+, drop that and add
> `@angular/build`.

`image-js` (a library peer dependency) does the client-side TIFF decode, and
`onnxruntime-web` sidecars would go in `/assets/ort/` (only for the SAM/cellpose
tools — not used by this image-only example).

## Why Vite

Vite is the runner so the **same** tooling can host non-Angular examples later
(a React or vanilla web-component demo) as the library grows framework-agnostic
consumers — just add another plugin. Angular CLI would lock the examples to
Angular.
