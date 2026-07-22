import { Component, Inject } from '@angular/core';
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
 * Minimal standalone host for <jaxviz-visualization>, run entirely in the
 * browser (no backend). A gallery of bundled sample images (large thumbnails) —
 * click one to load it into the viewer with the region + zoom tools. Everything
 * is wired through the library's DI ports, three of which are serverless stubs
 * (see serverless-ports.ts). Mirrors jit-ui's pipeline-preview wiring.
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
    `:host { display: flex; flex-direction: column; height: 100vh; font-family: system-ui, sans-serif; color: #1a1a1a; }`,
    `header { display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-bottom: 1px solid #e2e2e2; }`,
    `header strong { font-size: 14px; }`,
    `header .upload { font-size: 12px; color: #555; margin-left: auto; }`,
    `.body { display: flex; flex: 1 1 auto; min-height: 0; }`,
    `.gallery { width: 232px; flex: none; overflow-y: auto; padding: 10px; display: grid;
       grid-template-columns: 1fr 1fr; gap: 10px; align-content: start; background: #fafafa; border-right: 1px solid #e2e2e2; }`,
    `.tile { display: flex; flex-direction: column; gap: 4px; padding: 6px; border: 1px solid #ddd; border-radius: 8px;
       background: #fff; cursor: pointer; font: inherit; text-align: left; }`,
    `.tile:hover { border-color: #9ab; }`,
    `.tile.active { border-color: #2b6cb0; box-shadow: 0 0 0 2px rgba(43,108,176,.3); }`,
    `.tile .thumb { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 5px; background: #f0f0f0; display: block; }`,
    `.tile .tiff { display: flex; align-items: center; justify-content: center; color: #888; font-size: 12px;
       letter-spacing: .05em; border: 1px dashed #ccc; }`,
    `.tile .name { font-size: 10.5px; color: #444; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`,
    `.viewer { position: relative; flex: 1 1 auto; min-width: 0; display: flex; }`,
    `jaxviz-visualization { flex: 1 1 auto; min-height: 0; }`,
    `.spinner { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
       background: rgba(255,255,255,.6); font-size: 13px; color: #333; pointer-events: none; }`,
  ],
  template: `
    <header>
      <strong>sci-image-visualizer — serverless browser example</strong>
      <label class="upload">Load your own…
        <input type="file" accept="image/*,.tif,.tiff" (change)="onFile($event)" />
      </label>
    </header>
    <div class="body">
      <aside class="gallery">
        <button
          *ngFor="let s of samples"
          class="tile"
          [class.active]="s.name === active"
          (click)="load(s)"
          [title]="s.name">
          <img *ngIf="!s.isTiff" class="thumb" [src]="s.url" loading="lazy" alt="" />
          <span *ngIf="s.isTiff" class="thumb tiff">TIFF</span>
          <span class="name">{{ s.name }}</span>
        </button>
      </aside>
      <main class="viewer">
        <jaxviz-visualization [toolbarTools]="toolbarTools"></jaxviz-visualization>
        <div class="spinner" *ngIf="loading">decoding…</div>
      </main>
    </div>
  `,
})
export class AppComponent {
  readonly samples = SAMPLES;
  active?: string;
  loading = false;

  /** Show the zoom + region tools; hide the server-only "special" tools (plot
   *  type / channels / download need a backend) and help. */
  readonly toolbarTools: ToolbarToolVisibility = {
    specialTools: false,
    zoomTools: true,
    regionTools: true,
    help: false,
  };

  constructor(
    private readonly imageState: ExampleImageStateAdapter,
    @Inject(VISUALIZER) private readonly viz: IVisualizer,
  ) {
    // Render raw pixels (no smoothing) so images are inspectable pixel-for-pixel.
    this.viz.setImageSmoothingEnabled(false);
    // Show something on load: the first sample.
    if (this.samples.length) void this.load(this.samples[0]);
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
