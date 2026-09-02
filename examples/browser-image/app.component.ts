import { Component, ElementRef, Inject, NgZone, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  VisualizationModule,
  provideVisualization,
  VISUALIZER,
  IVisualizer,
  IMAGE_STATE_PORT,
  TILE_ACCESS_PORT,
  REGION_IO_PORT,
  VIZ_CONFIG,
  ToolbarToolVisibility,
  SPATIAL_DATA_PORT,
  SpatialDataHttpService,
} from '@jax-data-science/sci-image-visualizer';
import {
  ExampleImageStateAdapter,
  ServerTileAccessAdapter,
  StubRegionIoAdapter,
} from './serverless-ports';

interface Sample {
  name: string;
  url: string;
  isTiff: boolean;
}

interface DicomSlice {
  name: string;
  url: string;
}

/** A gallery sub-folder (currently just the bundled micro-CT DICOM series). */
/**
 * A spatial-omics dataset the SERVER reported, rather than one hardcoded here.
 * The example asks `/spatial/datasets` at startup, so dropping a SpatialData
 * store (or a legacy ST bundle) into the server's data directories makes it
 * appear in this gallery with no code change.
 */
interface SpatialEntry {
  datasetId: string;
  name: string;
  /**
   * The tissue image this dataset registers onto, when there is one.
   *
   * Absent for a dataset that has no single reference plane — a 3D cloud
   * registered into a common anatomical frame (the Allen CCF) is coordinates all
   * the way down, with no one section to draw them over. Those open straight
   * into the 3D mode with no image behind them.
   */
  imageId?: string;
}

/**
 * A gallery folder. Holds EITHER a DICOM series or a set of spatial-omics
 * datasets — both are "many related things behind one tile", and the root
 * gallery is unreadable with 41 spatial entries flattened into it.
 */
interface Folder {
  name: string;
  /** Slices of an image series (micro-CT). */
  slices?: DicomSlice[];
  /** Spatial-omics datasets, discovered from the server. */
  spatial?: SpatialEntry[];
  /** Nested folders, so a source with many sections does not flood its parent. */
  folders?: Folder[];
}

/**
 * The bundled sample images (examples/browser-image/sample-images/, stored via
 * Git LFS). Vite resolves each to a served URL at build time. `?url` keeps the
 * big TIFFs out of the JS graph — they're plain asset URLs we fetch on demand.
 */
const SAMPLES: Sample[] = Object.entries(
  import.meta.glob('./sample-images/*.{png,tif,tiff}', {
    eager: true,
    query: '?url',
    import: 'default',
  }) as Record<string, string>,
)
  .map(([path, url]) => {
    const name = path.split('/').pop() as string;
    return { name, url, isTiff: /\.tiff?$/i.test(name) };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Bundled micro-CT DICOM series (examples/browser-image/micro-ct/, Git LFS).
 * A folder of numbered single-slice .dcm files — the classic CT z-stack shape.
 * `numeric` sort keeps case1_008 … case1_068 in slice order.
 */
const MICRO_CT: DicomSlice[] = Object.entries(
  import.meta.glob('./micro-ct/*.dcm', {
    eager: true,
    query: '?url',
    import: 'default',
  }) as Record<string, string>,
)
  .map(([path, url]) => ({ name: path.split('/').pop() as string, url }))
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

const FOLDERS: Folder[] = MICRO_CT.length ? [{ name: 'micro-ct', slices: MICRO_CT }] : [];

/** Base URL of the example tile server (Mode A). Set VITE_TILE_SERVER (with a
 *  trailing slash — the library concatenates `${api}tile`) to enable the
 *  gigapixel tiled-loading gallery entries; empty keeps the demo fully serverless. */
const TILE_SERVER: string = (import.meta.env.VITE_TILE_SERVER as string | undefined) || '';

interface TiledImage {
  name: string;
  imageId: string;
  width: number;
  height: number;
  mppX: number;
  mppY: number;
  /** Band count. 3 (default) = RGB brightfield; anything else is treated as a
   *  fluorescence stack (rgbChannels 1), so the Channels pane gets one tinted
   *  channel per band. */
  channels?: number;
  /** z-slice count. >1 shows the slice scrubber; OSD swaps the tile `z` param. */
  slices?: number;
  /**
   * Spatial-omics dataset served alongside this image (`/spatial/<id>/…`).
   * Selecting the image loads the dataset, which makes the "Spatial omics" plot
   * type appear in the selector; selecting any other image clears it again.
   */
  spatialDatasetId?: string;
}

/** Gigapixel whole-slide images served through the tile server. Shown only when a
 *  tile server is configured (VITE_TILE_SERVER), so the live Pages demo stays
 *  serverless until one is deployed. */
const TILED_IMAGES: TiledImage[] = TILE_SERVER
  ? [
      { name: 'CMU-1 · 1.5 Gpx (CC0)', imageId: 'cmu-1', width: 46000, height: 32914, mppX: 0.499, mppY: 0.499 },
      { name: 'BC18 · 22 Gpx (NDPI)', imageId: 'bc18', width: 218240, height: 103424, mppX: 0.2264, mppY: 0.2264 },
      { name: 'Sirius Red · 0.5 Gpx (NDPI)', imageId: 'sirius-red', width: 36480, height: 14080, mppX: 0.442, mppY: 0.442 },
      // Two-channel fluorescence pair — the SAME pixels and the SAME pyramid,
      // differing only in the descriptor's `multichannel` flag, to isolate what
      // that flag alone does to the Channels pane:
      //   …/2ch  multichannel: true  → per-channel layers; hide/tint each band works
      //   …flat  multichannel: false → one composited layer; the pane's channel
      //                                toggles have nothing to act on (the
      //                                behaviour seen against a server that
      //                                won't flag a LUT-less stack multichannel)
      { name: '2-channel fluorescence · 0.35 Gpx', imageId: 'result-img', width: 16830, height: 20518, mppX: 0.3211, mppY: 0.3211, channels: 2 },
      { name: '2-channel · multichannel:false (repro)', imageId: 'result-img-flat', width: 16830, height: 20518, mppX: 0.3211, mppY: 0.3211, channels: 2 },
      // Project002 series2: a 15 GB ImageJ hyperstack (2ch x 27z, contiguous
      // planes behind a single IFD). Built from the middle z-slice — unlike
      // result_img this one carries an embedded ColorMap/LUT, so a server that
      // gates multichannel on "has a LUT" treats it differently.
      { name: 'Project002 · 2-channel BF · 0.28 Gpx (z=13)', imageId: 'project002-2ch', width: 14971, height: 18664, mppX: 0.3211, mppY: 0.3211, channels: 2 },
      // The same file as its real shape: 2 channels x 27 z-slices. Scrubbing the
      // stack swaps the tile `z` param server-side (no per-slice urls).
      { name: 'Project002 · 2ch x 27z stack · 7.5 Gpx', imageId: 'project002-stack', width: 14971, height: 18664, mppX: 0.3211, mppY: 0.3211, channels: 2, slices: 27 },
    ]
  : [];

/**
 * The tile server's descriptor for an image: its true dimensions and µm/px.
 * Asking for it is also what triggers the server to build that image's pyramid
 * from the Zarr store, so this is deliberately called on open, not at startup.
 */
async function fetchTileDescriptor(base: string, imageId: string): Promise<{
  width: number; height: number; mppX?: number; mppY?: number;
}> {
  const info = btoa(JSON.stringify({ image: imageId }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch(`${base}tiles/info?info=${info}`);
  if (!res.ok) throw new Error(`tiles/info ${res.status}`);
  return res.json();
}

/** Ping the tile server so a scaled-to-zero Cloud Run instance cold-starts before
 *  OSD asks for tiles. Resolves once the server responds — or after a generous
 *  timeout / on error — so a load never hangs forever. */
async function warmUp(base: string): Promise<void> {
  if (!base) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    await fetch(base, { signal: ctrl.signal, cache: 'no-store' });
  } catch {
    /* offline or aborted — proceed; OSD surfaces any real failure */
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal standalone host for <visualizer>, run entirely in the browser (no
 * backend). The gallery has two levels: the root shows folders (e.g. micro-ct)
 * plus flat sample images; opening a folder shows its DICOM slices. Click a
 * sample/slice to view it; RIGHT-CLICK a DICOM slice to load the whole folder as
 * a z-stack (the viewer's slice slider then scrubs through it), mirroring the
 * jit-ui file browser. DICOM is decoded in the browser (see dicom.ts) — the
 * serverless stand-in for jit-service + Bio-Formats.
 *
 * Everything is wired through the library's DI ports, three of which are
 * serverless stubs (serverless-ports.ts). The gallery and viewer are separated
 * by a draggable vertical splitter (see startResize).
 */
@Component({
  standalone: true,
  selector: 'app-root',
  imports: [CommonModule, VisualizationModule],
  providers: [
    ...provideVisualization(),
    ExampleImageStateAdapter,
    { provide: IMAGE_STATE_PORT, useExisting: ExampleImageStateAdapter },
    ServerTileAccessAdapter,
    { provide: TILE_ACCESS_PORT, useExisting: ServerTileAccessAdapter },
    { provide: REGION_IO_PORT, useClass: StubRegionIoAdapter },
    // The library's reference adapter for the example server's /spatial/* wire
    // format. Unbound by default, so this line is what turns the feature on.
    SpatialDataHttpService,
    { provide: SPATIAL_DATA_PORT, useExisting: SpatialDataHttpService },
    { provide: VIZ_CONFIG, useValue: { slideCropServer: TILE_SERVER } },
  ],
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
        font-family: system-ui, sans-serif;
        color: #1a1a1a;
      }
    `,
    `
      header {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 10px 14px;
        border-bottom: 1px solid #e2e2e2;
      }
    `,
    `
      header strong {
        font-size: 14px;
      }
    `,
    `
      header .upload {
        font-size: 12px;
        color: #555;
        margin-left: auto;
      }
    `,
    `
      .body {
        display: flex;
        flex: 1 1 auto;
        min-height: 0;
      }
    `,
    `
      .gallery {
        width: 232px;
        flex: none;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 10px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        align-content: start;
        background: #fafafa;
      }
    `,
    `
      .splitter {
        flex: none;
        width: 6px;
        cursor: col-resize;
        background: #e2e2e2;
        transition: background 0.15s ease;
      }
    `,
    `
      .splitter:hover,
      .splitter.dragging {
        background: #2b6cb0;
      }
    `,
    `
      .tile {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 6px;
        border: 1px solid #ddd;
        border-radius: 8px;
        background: #fff;
        cursor: pointer;
        font: inherit;
        text-align: left;
        min-width: 0;
      }
    `,
    `
      .tile:hover {
        border-color: #9ab;
      }
    `,
    `
      .tile.active {
        border-color: #2b6cb0;
        box-shadow: 0 0 0 2px rgba(43, 108, 176, 0.3);
      }
    `,
    `
      .tile .thumb {
        width: 100%;
        aspect-ratio: 1;
        object-fit: cover;
        border-radius: 5px;
        background: #f0f0f0;
        display: block;
      }
    `,
    `
      .tile .tiff,
      .tile .dcm {
        display: flex;
        align-items: center;
        justify-content: center;
        color: #888;
        font-size: 12px;
        letter-spacing: 0.05em;
        border: 1px dashed #ccc;
      }
    `,
    `
      .tile .dcm {
        color: #2b6cb0;
        font-weight: 600;
        letter-spacing: 0.08em;
        background: #eef4fb;
        border-color: #b8cbe0;
      }
    `,
    `
      .tile.folder .folder-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        color: #e0a92e;
        background: #fffdf4;
        border: 1px solid #ecdca8;
      }
    `,
    `
      .tile.folder .folder-icon svg {
        width: 56%;
        height: 56%;
      }
    `,
    `
      .tile.folder .name {
        font-weight: 600;
        color: #333;
      }
    `,
    `
      .breadcrumb {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: #555;
      }
    `,
    `
      .breadcrumb .crumb-back {
        font: inherit;
        font-size: 12px;
        color: #2b6cb0;
        background: none;
        border: none;
        padding: 2px 4px;
        cursor: pointer;
        border-radius: 4px;
      }
    `,
    `
      .breadcrumb .crumb-back:hover {
        background: #eef4fb;
      }
    `,
    `
      .breadcrumb .crumb-current {
        font-weight: 600;
        color: #333;
      }
    `,
    `
      .folder-hint {
        grid-column: 1 / -1;
        font-size: 11px;
        line-height: 1.4;
        color: #4a5b6b;
        background: #eef4fb;
        border: 1px solid #d6e4f0;
        border-radius: 6px;
        padding: 6px 8px;
      }
    `,
    `
      .tile .name {
        font-size: 10.5px;
        color: #444;
        overflow-wrap: break-word;
        word-break: break-word;
      }
    `,
    `
      .viewer {
        position: relative;
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
      }
    `,
    `
      visualizer {
        flex: 1 1 auto;
        min-height: 0;
      }
    `,
    `
      .spinner {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255, 255, 255, 0.6);
        font-size: 13px;
        color: #333;
        pointer-events: none;
      }
    `,
  ],
  template: `
    <header>
      <strong>sci-image-visualizer — serverless browser example</strong>
      <label class="upload"
        >Load your own…
        <input type="file" accept="image/*,.tif,.tiff,.dcm" (change)="onFile($event)" />
      </label>
    </header>
    <div class="body">
      <aside class="gallery" #galleryRef>
        <!-- Root: folders first, then the flat sample images. -->
        <ng-container *ngIf="!currentFolder">
          <button
            *ngFor="let f of folders"
            class="tile folder"
            (click)="openFolder(f)"
            [title]="'Open ' + f.name + ' (' + folderCount(f) + ' items)'"
          >
            <span class="thumb folder-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"
                />
              </svg>
            </span>
            <span class="name">{{ f.name }}</span>
          </button>
          <button
            *ngFor="let t of tiledImages"
            class="tile"
            [class.active]="t.imageId === active"
            (click)="loadTiled(t)"
            [title]="t.name + ' — gigapixel, tiled (server) loading'"
          >
            <span class="thumb dcm">WSI</span>
            <span class="name">{{ t.name }}</span>
          </button>
          <button
            *ngFor="let s of samples"
            class="tile"
            [class.active]="s.name === active"
            (click)="load(s)"
            [title]="s.name"
          >
            <img *ngIf="!s.isTiff" class="thumb" [src]="s.url" loading="lazy" alt="" />
            <span *ngIf="s.isTiff" class="thumb tiff">TIFF</span>
            <span class="name">{{ s.name }}</span>
          </button>
        </ng-container>

        <!-- Inside a folder: DICOM slices. -->
        <ng-container *ngIf="currentFolder as folder">
          <!-- A trail rather than one back button: folders nest, so "up one
               level" and "back to the root" are different actions. -->
          <div class="breadcrumb">
            <button class="crumb-back" (click)="goToDepth(0)" title="Back to gallery">← Gallery</button>
            <ng-container *ngFor="let f of folderPath; let i = index; let last = last">
              <span>/</span>
              <span *ngIf="last" class="crumb-current">{{ f.name }}</span>
              <button *ngIf="!last" class="crumb-back" (click)="goToDepth(i + 1)"
                      [title]="'Back to ' + f.name">{{ f.name }}</button>
            </ng-container>
          </div>
          <div class="folder-hint" *ngIf="folder.slices">
            Click a slice to view it · <strong>right-click</strong> to load the whole folder as a z-stack.
          </div>
          <div class="folder-hint" *ngIf="folder.folders">
            Grouped by source · a source with several sections gets its own folder.
          </div>
          <div class="folder-hint" *ngIf="folder.spatial">
            Click a dataset to open it over its tissue image, then pick
            <strong>Spatial omics</strong> in the plot-type menu.
          </div>
          <!-- Nested folders, rendered like the root's. -->
          <button
            *ngFor="let sub of folder.folders"
            class="tile folder"
            (click)="openFolder(sub)"
            [title]="'Open ' + sub.name + ' (' + folderCount(sub) + ' items)'"
          >
            <span class="thumb folder-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"
                />
              </svg>
            </span>
            <span class="name">{{ sub.name }}</span>
          </button>
          <button
            *ngFor="let d of folder.slices; let i = index"
            class="tile dcm-tile"
            [class.active]="d.name === active"
            (click)="loadDicom(d)"
            (contextmenu)="loadStack($event, i)"
            [title]="d.name + '  —  right-click: load folder as z-stack'"
          >
            <span class="thumb dcm">DCM</span>
            <span class="name">{{ d.name }}</span>
          </button>
          <button
            *ngFor="let e of folder.spatial"
            class="tile dcm-tile"
            [class.active]="e.datasetId === active"
            (click)="loadSpatial(e)"
            [title]="e.name + '  —  ' + e.datasetId"
          >
            <span class="thumb dcm">OMIC</span>
            <span class="name">{{ e.name }}</span>
          </button>
        </ng-container>
      </aside>
      <div
        class="splitter"
        [class.dragging]="dragging"
        (mousedown)="startResize($event)"
        title="Drag to resize the gallery"
      ></div>
      <main class="viewer">
        <visualizer [toolbarTools]="toolbarTools" [testMode]="testMode"></visualizer>
        <div class="spinner" *ngIf="loading">{{ loadingMessage || 'decoding…' }}</div>
      </main>
    </div>
  `,
})
export class AppComponent implements OnDestroy {
  readonly samples = SAMPLES;
  /**
   * Root folders: the bundled micro-CT series, plus a spatial-omics folder once
   * the server has reported any.
   *
   * Assigned ONCE when discovery completes, never derived in a getter. A getter
   * would return a new `Folder` object on every change-detection pass, and
   * `*ngFor` tracks by identity — so that folder's button was destroyed and
   * recreated between mousedown and click, and clicking it did nothing. The
   * micro-CT tile kept working precisely because its object was stable.
   */
  folders: Folder[] = FOLDERS;

  /**
   * The spatial-omics folder, with each SOURCE that has several datasets nested
   * one level down.
   *
   * Dataset ids are `<source>.<section>` (`her2.A1`, `visium.table.ST8059048`),
   * so the prefix groups them for free. The HER2 deposition alone is 36
   * sections, which would bury the two Visium and two Visium HD datasets it sits
   * beside; a source with only a couple stays a direct tile rather than costing
   * an extra click for nothing.
   */
  private spatialFolder(entries: SpatialEntry[]): Folder {
    const NEST_FROM = 4;
    const groups = new Map<string, SpatialEntry[]>();
    for (const e of entries) {
      const dot = e.datasetId.indexOf('.');
      const source = dot > 0 ? e.datasetId.slice(0, dot) : '';
      const list = groups.get(source) ?? [];
      list.push(e);
      groups.set(source, list);
    }

    const folders: Folder[] = [];
    const spatial: SpatialEntry[] = [];
    for (const [source, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (source && list.length >= NEST_FROM) folders.push({ name: source, spatial: list });
      else spatial.push(...list);
    }
    return {
      name: 'spatial-omics',
      ...(folders.length ? { folders } : {}),
      ...(spatial.length ? { spatial } : {}),
    };
  }
  readonly tiledImages = TILED_IMAGES;
  /**
   * Breadcrumb trail of opened folders. Empty = the root gallery. A path rather
   * than a single folder because folders nest (spatial-omics → her2).
   */
  folderPath: Folder[] = [];
  active?: string;
  loading = false;
  /** Optional viewer-spinner message (e.g. the tile-server cold-start notice). */
  loadingMessage = '';
  dragging = false;

  @ViewChild('galleryRef') private readonly galleryRef!: ElementRef<HTMLElement>;

  /** Tear-down for an in-progress splitter drag; null when not dragging. */
  private cleanupResize: (() => void) | null = null;

  /** Show the plot-type dropdown + zoom + region tools, and the help dialog —
   *  it documents the segmentation tools this example exercises, so it is worth
   *  having here. (Channels / download need a backend, but the plot-type selector
   *  works serverlessly.) */
  /**
   * Show every backend's plot mode in the selector, under its backend-suffixed
   * label — `?test=1` (or `?test=true`) in the URL.
   *
   * This lifts the `productionLabel` CURATION only. The capability gates still
   * apply: a stack-only mode still needs a stack, a scalar mode still needs a
   * grayscale image, and Spatial omics still needs a dataset loaded.
   */
  readonly testMode = /^(1|true|yes)$/i.test(
    new URLSearchParams(window.location.search).get('test') ?? '',
  );

  /** Spatial-omics datasets discovered from the server (see SpatialEntry). */
  spatialEntries: SpatialEntry[] = [];

  readonly toolbarTools: ToolbarToolVisibility = {
    specialTools: true,
    zoomTools: true,
    regionTools: true,
    help: true,
  };

  constructor(
    private readonly imageState: ExampleImageStateAdapter,
    private readonly zone: NgZone,
    @Inject(VISUALIZER) private readonly viz: IVisualizer,
    private readonly spatialData: SpatialDataHttpService,
  ) {
    // Render raw pixels (no smoothing) so images are inspectable pixel-for-pixel.
    this.viz.setImageSmoothingEnabled(false);
    if (TILE_SERVER) {
      this.spatialData.configure({ baseUrl: TILE_SERVER });
      void this.discoverSpatial();
    }
    // Show something on load: the first sample.
    if (this.samples.length) void this.load(this.samples[0]);
  }

  // ── Gallery folder navigation ───────────────────────────────────────────
  /** The folder being shown, or null at the root. */
  get currentFolder(): Folder | null {
    return this.folderPath.length ? this.folderPath[this.folderPath.length - 1] : null;
  }

  openFolder(f: Folder): void { this.folderPath = [...this.folderPath, f]; }

  /** Jump to a breadcrumb depth: 0 = root, 1 = the first folder, and so on. */
  goToDepth(depth: number): void { this.folderPath = this.folderPath.slice(0, depth); }

  /** How many items a folder holds, for its tooltip. */
  folderCount(f: Folder): number {
    return (f.slices?.length ?? 0) + (f.spatial?.length ?? 0) + (f.folders?.length ?? 0);
  }
  /** Up one level, not all the way to the root. */
  closeFolder(): void { this.folderPath = this.folderPath.slice(0, -1); }

  /** Load a gigapixel image through the TILED (Mode A) server path. First warms
   *  the tile server with a visible message — a scaled-to-zero Cloud Run service
   *  cold-starts on the first request after idle — then emits the tiled image, and
   *  the viewer's OSD backend polls the server and fetches tiles on demand. */
  async loadTiled(t: TiledImage): Promise<void> {
    this.active = t.imageId;
    this.loading = true;
    this.loadingMessage = 'Starting the tile server (first load may take up to a minute)…';
    try {
      await warmUp(TILE_SERVER);
    } finally {
      this.loading = false;
      this.loadingMessage = '';
    }
    this.imageState.setTiledImage(t.imageId, t.name, t.width, t.height, t.mppX, t.mppY, t.channels ?? 3, t.slices ?? 1);
    await this.selectSpatialDataset(t.spatialDatasetId);
  }

  /**
   * Ask the server which spatial-omics datasets it has.
   *
   * Deliberately NOT fetching each dataset's image dimensions here: that would
   * hit `/tiles/info`, which makes the server materialise every pyramid at
   * startup. Dimensions are fetched on click instead, so only the dataset you
   * open pays for its image.
   */
  private async discoverSpatial(): Promise<void> {
    try {
      const datasets = await this.spatialData.listDatasets();
      const entries: SpatialEntry[] = [];
      for (const d of datasets) {
        // The manifest names the image this dataset registers onto, if any. No
        // image is not a reason to skip the dataset: a 3D cloud has none, and is
        // rendered on its own.
        const manifest = await this.spatialData.readManifest(d.id).catch(() => null);
        if (!manifest) continue;
        entries.push({
          datasetId: d.id,
          name: `${d.name} · ${d.count.toLocaleString()} obs`,
          imageId: manifest.imageRef?.imageId,
        });
      }
      this.zone.run(() => {
        this.spatialEntries = entries;
        this.folders = entries.length ? [...FOLDERS, this.spatialFolder(entries)] : FOLDERS;
      });
    } catch {
      // No server, or none configured — the gallery just has no spatial entries.
    }
  }

  /**
   * Open a discovered spatial dataset: read the image's real dimensions from the
   * server, show it, then load the dataset so the Spatial omics plot type
   * appears.
   */
  async loadSpatial(entry: SpatialEntry): Promise<void> {
    this.active = entry.datasetId;
    this.loading = true;
    this.loadingMessage = entry.imageId
      ? 'Preparing the tissue image…'
      : 'Loading observations…';
    try {
      await warmUp(TILE_SERVER);
      if (entry.imageId) {
        // The tile DESCRIPTOR is a tile-server concern, not part of the spatial
        // contract, so the host fetches it — and it is what makes the server
        // materialise this image's pyramid, on first open only.
        const desc = await fetchTileDescriptor(TILE_SERVER, entry.imageId);
        this.imageState.setTiledImage(
          entry.imageId, entry.name, desc.width, desc.height,
          desc.mppX ?? 1, desc.mppY ?? 1, 3, 1,
        );
      }
      // No reference image means the visualizer selects the 3D cloud itself —
      // it is the only mode that can render such a dataset, so the host does not
      // have to know that.
      await this.selectSpatialDataset(entry.datasetId);
    } finally {
      this.loading = false;
      this.loadingMessage = '';
    }
  }

  /**
   * Load (or clear) the spatial-omics dataset that goes with the current image.
   * The "Spatial omics" plot type is gated on a dataset being published, so
   * clearing here is what makes it disappear when you move to a plain slide.
   *
   * With a dataset loaded, colour by the first categorical column straight away
   * so the mode opens on something meaningful rather than undifferentiated
   * neutral dots. From there the Spatial omics toolbar button opens the controls
   * panel, which offers every column, a gene search, and the display knobs.
   */
  private async selectSpatialDataset(datasetId?: string): Promise<void> {
    const controls = this.viz.getSpatialControls?.();
    if (!datasetId) {
      this.spatialData.clear();
      return;
    }
    try {
      const dataset = await this.spatialData.selectDataset(datasetId);
      const categorical = dataset.columns.find((c) => c.kind === 'categorical');
      if (categorical) controls?.colorByColumn(categorical.name);
    } catch (err) {
      // A missing dataset must not break image loading — the slide still renders,
      // just without the spatial mode on offer.
      console.warn(`[example] spatial dataset "${datasetId}" unavailable`, err);
      this.spatialData.clear();
    }
  }

  /** Left-click a DICOM slice: decode + show just that slice. */
  async loadDicom(d: DicomSlice): Promise<void> {
    this.active = d.name;
    this.spatialData.clear();
    this.loading = true;
    try {
      await this.imageState.setImageFromDicomUrl(d.url, d.name);
    } finally {
      this.loading = false;
    }
  }

  /** Right-click a DICOM slice: load the whole folder as a z-stack, opening on
   *  the clicked slice. The viewer's slice slider then scrubs through it. */
  async loadStack(event: MouseEvent, index: number): Promise<void> {
    event.preventDefault(); // suppress the browser's native context menu
    const folder = this.currentFolder;
    // Only a slice folder can be loaded as a z-stack; a spatial-omics folder has
    // no slices to stack.
    if (!folder?.slices?.length) return;
    this.active = folder.slices![index]?.name;
    this.spatialData.clear();
    this.loading = true;
    try {
      await this.imageState.setStackFromDicomUrls(
        folder.slices!.map((s) => s.url),
        folder.name,
        index,
      );
    } finally {
      this.loading = false;
    }
  }

  /**
   * Drag the vertical splitter to resize the gallery; the viewer flexes to fill
   * whatever's left, so the canvas grows/shrinks to match. The move handler runs
   * OUTSIDE Angular and mutates the gallery's inline width directly — no change
   * detection per mouse move — and dispatches a `resize` event (rAF-throttled) so
   * the OpenSeadragon / Plotly canvas re-fits its new container size live.
   */
  startResize(event: MouseEvent): void {
    event.preventDefault();
    if (this.cleanupResize) return; // guard against a stuck second drag
    const gallery = this.galleryRef.nativeElement;
    const container = gallery.parentElement as HTMLElement;
    const startX = event.clientX;
    const startWidth = gallery.getBoundingClientRect().width;
    const min = 140;
    // Leave the viewer at least ~240px so it never collapses to nothing.
    const max = Math.max(min, container.getBoundingClientRect().width - 240);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    this.dragging = true;
    let raf = 0;

    const onMove = (e: MouseEvent): void => {
      const width = Math.min(max, Math.max(min, startWidth + (e.clientX - startX)));
      gallery.style.width = `${width}px`;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          window.dispatchEvent(new Event('resize')); // re-fit the viewer canvas
        });
      }
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (raf) cancelAnimationFrame(raf);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      this.cleanupResize = null;
      // Back inside Angular to flip `dragging` off, then one final settle.
      this.zone.run(() => (this.dragging = false));
      window.dispatchEvent(new Event('resize'));
    };

    this.cleanupResize = onUp;
    this.zone.runOutsideAngular(() => {
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  ngOnDestroy(): void {
    // Clean up if the component is torn down mid-drag.
    this.cleanupResize?.();
  }

  async load(s: Sample): Promise<void> {
    this.active = s.name;
    this.spatialData.clear();
    this.loading = true;
    try {
      await this.imageState.setImageFromUrl(s.url, s.name);
    } finally {
      this.loading = false;
    }
  }

  async onFile(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    if (!file) return;
    this.active = file.name;
    this.spatialData.clear();
    this.loading = true;
    try {
      await this.imageState.setImageFromFile(file);
    } finally {
      this.loading = false;
    }
  }
}
