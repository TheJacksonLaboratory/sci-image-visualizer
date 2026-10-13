import { Component, NgModule, NgZone, Type, isStandalone, ɵComponentDef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { ConfirmationService, MessageService } from 'primeng/api';
import { BehaviorSubject, EMPTY, of } from 'rxjs';
import { By } from '@angular/platform-browser';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { VisualizationModule } from './visualization.module';
import { RoutingVisualizerService } from './routing-visualizer.service';
import { VISUALIZER } from './contracts/visualizer.contract';
import { REGION_EDITOR_API } from './contracts/region-editor-api.contract';
import { CHANNEL_HISTOGRAM_API } from './contracts/channel-histogram-api.contract';
import { REGION_IO_PORT } from './contracts/ports/region-io.port';
import { VIZ_PORT_STUBS } from './testing/viz-port-stubs';
import { IMAGE_STATE_PORT } from './contracts/ports/image-state.port';
import { PlotType } from './contracts/plot-type';
import { ToolbarComponent } from './toolbar/toolbar.component';
import { VisualizerComponent } from './visualizer.component';
import { RegionEditorComponent } from './region-editor/region-editor.component';
import { HexColorPickerComponent } from './hex-color-picker/hex-color-picker.component';

jest.mock('plotly.js-dist-min', () => ({
  newPlot: jest.fn(),
  react: jest.fn(),
  relayout: jest.fn(),
  purge: jest.fn(),
  restyle: jest.fn(),
}));

/**
 * `VisualizationModule` is now a re-export shim over standalone components (CORE-21).
 * A host written against the module — a non-standalone component declared in an
 * NgModule that imports it — must keep working unchanged, root token bindings included.
 */

/** An NgModule-era host, exactly as a consumer wrote one before the components were standalone. */
@Component({
  selector: 'legacy-host',
  template: `
    <visualizer></visualizer>
    <region-editor></region-editor>
    <hex-color-picker [color]="color" (colorChange)="picked = $event"></hex-color-picker>
  `,
})
class LegacyHostComponent {
  color = '#112233';
  picked: string | null = null;
}

@NgModule({
  declarations: [LegacyHostComponent],
  imports: [VisualizationModule],
})
class LegacyHostModule {}

const REGION_IO_STUB = {
  provide: REGION_IO_PORT,
  useValue: {
    getSelectedFileName: () => undefined,
    roiFileExists: () => of(false),
    saveGeoJson: () => EMPTY,
    saveSliceGeoJsons: () => EMPTY,
  },
};

describe('VisualizationModule (re-export shim)', () => {
  beforeEach(async () => {
    // jsdom can't parse PrimeNG's component stylesheets; drop just that noise.
    const consoleError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) consoleError(...args);
    });
    await TestBed.configureTestingModule({
      imports: [LegacyHostModule, HttpClientTestingModule, NoopAnimationsModule],
      providers: [MessageService, ConfirmationService, ...VIZ_PORT_STUBS, REGION_IO_STUB],
      errorOnUnknownElements: true,
      errorOnUnknownProperties: true,
    }).compileComponents();
  });

  afterEach(() => jest.restoreAllMocks());

  it('bootstraps a module-based host: the viewer, the region editor and the picker render', () => {
    const fixture = TestBed.createComponent(LegacyHostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('visualizer plotting-toolbar')).not.toBeNull();
    expect(el.querySelector('region-editor region-table')).not.toBeNull();

    // The host's own picker (the region editor's class swatches are pickers too).
    const picker = el.querySelector(':scope > hex-color-picker') as HTMLElement;
    expect((picker.querySelector('.hex-picker-swatch') as HTMLElement).title).toBe('#112233');
    // The picker's output still reaches the host's binding.
    (picker.querySelector('.hex-cell') as HTMLButtonElement).click();
    expect(fixture.componentInstance.picked).toMatch(/^#[0-9A-F]{6}$/);
    fixture.destroy();
  });

  it('the OnPush viewer follows the host: its loading state, and a plot type the host selects', () => {
    const loading$ = new BehaviorSubject(false);
    const stub = VIZ_PORT_STUBS.find((p) => p.provide === IMAGE_STATE_PORT)!.useValue;
    TestBed.overrideProvider(IMAGE_STATE_PORT, { useValue: { ...stub, isImageLoading$: () => loading$ } });
    const fixture = TestBed.createComponent(LegacyHostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('visualizer .loading-overlay')).toBeNull();
    loading$.next(true);
    fixture.detectChanges();
    expect(el.querySelector('visualizer .loading-overlay')).not.toBeNull();

    // jit-ui's diagram calls this directly, outside the viewer's own events.
    const instance = <T>(type: Type<T>): T => fixture.debugElement.query(By.directive(type)).componentInstance;
    const viewer = instance(VisualizerComponent);
    const toolbar = instance(ToolbarComponent);
    viewer.onSelectPlotType(PlotType.HEATMAP);
    fixture.detectChanges();
    expect(toolbar.selectedPlotType).toBe(PlotType.HEATMAP);
    fixture.destroy();
  });

  it('drops the loading overlay when the host clears its loading flag outside the Angular zone', async () => {
    // A serverless host clears isImageLoading$ from an image decode or an OpenSeadragon open
    // callback, outside the zone. The OnPush viewer must still re-render: the overlay used to
    // stay over the drawn image until an unrelated event (the Cancel button) ran change detection.
    const loading$ = new BehaviorSubject(true);
    const stub = VIZ_PORT_STUBS.find((p) => p.provide === IMAGE_STATE_PORT)!.useValue;
    TestBed.overrideProvider(IMAGE_STATE_PORT, { useValue: { ...stub, isImageLoading$: () => loading$ } });
    const fixture = TestBed.createComponent(LegacyHostComponent);
    fixture.autoDetectChanges(true);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('visualizer .loading-overlay')).not.toBeNull();

    TestBed.inject(NgZone).runOutsideAngular(() => loading$.next(false));
    await fixture.whenStable();
    expect(el.querySelector('visualizer .loading-overlay')).toBeNull();
    fixture.destroy();
  });

  it('still binds the three host-facing tokens to one root router', () => {
    const router = TestBed.inject(RoutingVisualizerService);
    expect(TestBed.inject(VISUALIZER)).toBe(router);
    expect(TestBed.inject(REGION_EDITOR_API)).toBe(router);
    expect(TestBed.inject(CHANNEL_HISTOGRAM_API)).toBe(router);
  });

  it('exports the same six components, now standalone', () => {
    const exported = (VisualizationModule as unknown as { ɵmod: { exports: Type<unknown>[] } }).ɵmod.exports;
    expect(exported.map((c) => c.name)).toEqual([
      'VisualizerComponent',
      'RegionEditorComponent',
      'HexColorPickerComponent',
      'ChannelHistogramComponent',
      'SpatialControlsComponent',
      'SpatialChartsComponent',
    ]);
    expect(exported.every((c) => isStandalone(c))).toBe(true);
    expect(
      [VisualizerComponent, RegionEditorComponent, HexColorPickerComponent].every((c) => isStandalone(c)),
    ).toBe(true);
  });
});

/** Every component and directive of the library: standalone, and every component OnPush. */
describe('library components (CORE-21)', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(component|directive)\.ts$/.test(name) ? [path] : [];
    });
  }

  const classes = sources(__dirname).flatMap((file) => {
    const names = [...readFileSync(file, 'utf8').matchAll(/export class (\w+)/g)].map((m) => m[1]);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file) as Record<string, Type<unknown>>;
    return names.map((name) => ({ name, type: mod[name] })).filter((c) => !!c.type);
  });

  it('finds them (sanity)', () => {
    expect(classes.length).toBeGreaterThan(30);
  });

  it('are all standalone', () => {
    expect(classes.filter((c) => !isStandalone(c.type)).map((c) => c.name)).toEqual([]);
  });

  it('are all OnPush (components)', () => {
    const defaults = classes
      .map((c) => ({ name: c.name, cmp: (c.type as unknown as { ɵcmp?: ɵComponentDef<unknown> }).ɵcmp }))
      .filter((c) => c.cmp && !c.cmp.onPush)
      .map((c) => c.name);
    expect(defaults).toEqual([]);
  });
});
