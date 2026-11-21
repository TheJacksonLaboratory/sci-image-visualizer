# Host integration

Everything an Angular 21 app has to provide to run the viewer. The working
reference is the serverless example: [`examples/browser-image/main.ts`](../../examples/browser-image/main.ts)
(app providers and CSS) and [`app.component.ts`](../../examples/browser-image/app.component.ts)
(ports).

## 1. Install

```bash
npm install @jax-data-science/sci-image-visualizer
npm install @angular/cdk @angular/router primeng @primeuix/themes primeicons primeflex \
  image-js file-saver buffer onnxruntime-web
```

`openseadragon`, `plotly.js-dist-min`, `napari-js`, `cellpose-js`, `fast-png`
and `tslib` are regular dependencies and come with the package. Peer ranges are
listed in the [README](../../README.md#peer-dependencies).

## 2. App-level providers

```ts
import { provideZoneChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { MessageService, ConfirmationService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import Lara from '@primeuix/themes/lara';

bootstrapApplication(AppComponent, {
  providers: [
    provideZoneChangeDetection(),
    provideHttpClient(),
    providePrimeNG({ theme: { preset: Lara } }),
    MessageService,
    ConfirmationService,
  ],
});
```

- `provideHttpClient()`: the backends and stores inject `HttpClient`, and asset
  fetches go through it so your interceptors apply.
- `provideZoneChangeDetection()`: the library runs with zone.js change
  detection. Angular 21 apps are zoneless by default, so add it (and keep
  `zone.js` in the polyfills).
- `providePrimeNG()`: PrimeNG 18 and later ship no theme CSS; the theme is a
  preset (Aura, Lara, Nora, Material, or your own `definePreset()` of one).
  The library's styles use its design tokens (`--p-primary-color`,
  `--p-content-border-color`, ...), so they follow the preset and its dark mode.
  (`@angular/router` and `@angular/cdk` are peers because PrimeNG needs them.
  The library does not route.)
- `MessageService` and `ConfirmationService`: the toolbar, the region editor
  and the toasts inject them, and the library does not provide them.

An NgModule app puts the same providers in its root module. It can keep importing
`VisualizationModule`, which is deprecated and re-exports the standalone components.

## 3. Styles

```ts
// main.ts, or the "styles" array in angular.json
import 'primeicons/primeicons.css';
import 'primeflex/primeflex.css';
```

The templates use `pi pi-*` icons and PrimeFlex utility classes, so the viewer
renders unstyled without them. PrimeNG's own styles come from the preset. Its
presets set no font (PrimeNG 17's theme files set one on `:root`), so set yours
on `:root` or `body`, or menus and select lists appended to `<body>` use the
browser's default.

The toolbar and context-menu icon classes (`.wand-icon`, `.brush-icon`, … and the
highlighted context-menu entry) have to be global, because PrimeNG appends those
menus to `<body>`, outside the visualizer's view. The visualizer defines them when it
first loads. The package also ships them as a stylesheet, so a host can define them
up front, independent of stylesheet order (a host menu that reuses the icons, say):

```json
"styles": ["node_modules/@jax-data-science/sci-image-visualizer/src/lib/styles/viz-icons.scss"]
```

Its icon URLs are relative to the stylesheet (`../assets/*.svg`), and the Angular CLI
bundles them, so they work whether or not `assets/plotting/` is served.

## 4. Assets

The library loads its icons and colormap previews from `assets/plotting/`. Serve
the package's `src/lib/assets` folder there. In `angular.json`:

```json
"assets": [
  {
    "glob": "**/*",
    "input": "node_modules/@jax-data-science/sci-image-visualizer/src/lib/assets",
    "output": "assets/plotting"
  }
]
```

SAM and cellpose run on `onnxruntime-web`, which loads its WASM sidecars from
`/assets/ort/`. Copy `node_modules/onnxruntime-web/dist/*.{wasm,mjs}` there, or
call `setOrtWasmBase(url)` once at startup to load them from somewhere else, such
as a CDN. The version must match the installed `onnxruntime-web`.

## 5. Ports and configuration

The library never imports host code. It reaches the host through these DI
tokens, which you provide at the root or on the component that embeds
`<visualizer>`:

| Token                     | Required              | What it is                                                                                                |
| ------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------- |
| `IMAGE_STATE_PORT`        | yes                   | Your image/loading state: current image info, loading flags, zoom; the library writes updates back        |
| `TILE_ACCESS_PORT`        | yes                   | The selected file's tile info, server-side zoom crops, auth headers for OpenSeadragon's own tile requests |
| `REGION_IO_PORT`          | for `<region-editor>` | Saving and checking ROI GeoJSON files                                                                     |
| `VIZ_CONFIG`              | yes                   | `{ slideCropServer, regionEditorWidthSelector?, useNapariRenderer? }`                                     |
| `PREFERENCES_PORT`        | no                    | Persists class presets                                                                                    |
| `SPATIAL_DATA_PORT`       | no                    | Spatial-omics datasets; see [spatial-omics.md](./spatial-omics.md)                                        |
| `CELL_SEGMENTER`          | no                    | Override the automatic segmenter (defaults to `CellposeSegmenterService`)                                 |
| `TOOLBAR_TOOLS`           | no                    | Contributed tools; see [dialog-tools.md](./dialog-tools.md)                                               |
| `PLOT_TYPE_CONTRIBUTIONS` | no                    | Contributed plot modes; see [plot-type-contributions.md](./plot-type-contributions.md)                    |

```ts
import {
  VisualizerComponent,
  RegionEditorComponent,
  provideVisualization,
  IMAGE_STATE_PORT,
  TILE_ACCESS_PORT,
  REGION_IO_PORT,
  VIZ_CONFIG,
} from '@jax-data-science/sci-image-visualizer';

@Component({
  standalone: true,
  imports: [VisualizerComponent, RegionEditorComponent],
  template: `<visualizer></visualizer> <region-editor></region-editor>`,
  providers: [
    ...provideVisualization(),
    { provide: IMAGE_STATE_PORT, useClass: MyImageStateAdapter },
    { provide: TILE_ACCESS_PORT, useClass: MyTileAccessAdapter },
    { provide: REGION_IO_PORT, useClass: MyRegionIoAdapter },
    { provide: VIZ_CONFIG, useValue: { slideCropServer: 'https://tiles.example.org' } },
  ],
})
export class ViewerPageComponent {}
```

### A second, isolated viewer

The services behind the viewer are root singletons, so every `<visualizer>` in
the app shares regions, image and display state by default. A view that needs
its own state, such as a modal over the main viewer, spreads
`...provideVisualization()` into its component `providers` together with its
own ports.

## 6. Components

All are standalone components (import them directly; the deprecated `VisualizationModule`
re-exports them for NgModule hosts) and use unprefixed selectors.

| Selector            | Inputs                                                                                                         | Outputs                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `visualizer`        | `toolbarTools` (partial `ToolbarToolVisibility`; hides toolbar groups), `testMode` (show test-only plot types) | `isStackEvent`, `isGrayscaleEvent` (emit, on each image load, whether it is a z-stack / grayscale) |
| `region-editor`     | none                                                                                                           | none                                                                                               |
| `channel-histogram` | `visible`                                                                                                      | `visibleChange`                                                                                    |
| `spatial-controls`  | `visible`, `is3d`                                                                                              | `visibleChange`                                                                                    |
| `spatial-charts`    | `active` (draw only while the host panel is on screen)                                                         | none                                                                                               |
| `hex-color-picker`  | `color` (hex string)                                                                                           | `colorChange`                                                                                      |

The viewer is driven through the `VISUALIZER` token (`IVisualizer`), and the
Regions panel through `REGION_EDITOR_API`. Inject the tokens, not
`RoutingVisualizerService`.

## 7. Toasts

The library emits its notices on two PrimeNG toast keys, `sci-viz-notice` and
`sci-viz-alert`. `<visualizer>` renders their outlets itself. Do not add
`<p-toast>` outlets with these keys, or each message shows twice.

## 8. Segmentation models

Set the hosted SAM model URLs once at startup with `setSamModelUrls(...)`. See
[segmentation.md](./segmentation.md#host-configuration).
