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
} from '@jax-data-science/sci-image-visualizer';
import {
  ExampleImageStateAdapter,
  StubTileAccessAdapter,
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
interface Folder {
  name: string;
  slices: DicomSlice[];
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
    { provide: TILE_ACCESS_PORT, useClass: StubTileAccessAdapter },
    { provide: REGION_IO_PORT, useClass: StubRegionIoAdapter },
    { provide: VIZ_CONFIG, useValue: { slideCropServer: '' } },
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
            [title]="'Open ' + f.name + ' (' + f.slices.length + ' DICOM slices)'"
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
          <div class="breadcrumb">
            <button class="crumb-back" (click)="closeFolder()" title="Back to gallery">← Gallery</button>
            <span>/</span>
            <span class="crumb-current">{{ folder.name }}</span>
          </div>
          <div class="folder-hint">
            Click a slice to view it · <strong>right-click</strong> to load the whole folder as a z-stack.
          </div>
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
        </ng-container>
      </aside>
      <div
        class="splitter"
        [class.dragging]="dragging"
        (mousedown)="startResize($event)"
        title="Drag to resize the gallery"
      ></div>
      <main class="viewer">
        <visualizer [toolbarTools]="toolbarTools"></visualizer>
        <div class="spinner" *ngIf="loading">decoding…</div>
      </main>
    </div>
  `,
})
export class AppComponent implements OnDestroy {
  readonly samples = SAMPLES;
  readonly folders = FOLDERS;
  /** null = root (folders + samples); otherwise the opened folder's slices. */
  currentFolder: Folder | null = null;
  active?: string;
  loading = false;
  dragging = false;

  @ViewChild('galleryRef') private readonly galleryRef!: ElementRef<HTMLElement>;

  /** Tear-down for an in-progress splitter drag; null when not dragging. */
  private cleanupResize: (() => void) | null = null;

  /** Show the plot-type dropdown + zoom + region tools; hide help. (Channels /
   *  download need a backend, but the plot-type selector works serverlessly.) */
  readonly toolbarTools: ToolbarToolVisibility = {
    specialTools: true,
    zoomTools: true,
    regionTools: true,
    help: false,
  };

  constructor(
    private readonly imageState: ExampleImageStateAdapter,
    private readonly zone: NgZone,
    @Inject(VISUALIZER) private readonly viz: IVisualizer,
  ) {
    // Render raw pixels (no smoothing) so images are inspectable pixel-for-pixel.
    this.viz.setImageSmoothingEnabled(false);
    // Show something on load: the first sample.
    if (this.samples.length) void this.load(this.samples[0]);
  }

  // ── Gallery folder navigation ───────────────────────────────────────────
  openFolder(f: Folder): void { this.currentFolder = f; }
  closeFolder(): void { this.currentFolder = null; }

  /** Left-click a DICOM slice: decode + show just that slice. */
  async loadDicom(d: DicomSlice): Promise<void> {
    this.active = d.name;
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
    if (!folder) return;
    this.active = folder.slices[index]?.name;
    this.loading = true;
    try {
      await this.imageState.setStackFromDicomUrls(
        folder.slices.map((s) => s.url),
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
    this.loading = true;
    try {
      await this.imageState.setImageFromFile(file);
    } finally {
      this.loading = false;
    }
  }
}
