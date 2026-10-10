import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { MessageService } from 'primeng/api';
import { Subject } from 'rxjs';

import { PlotlyService } from './plotly/plotly.service';
import { OpenSeadragonVisualizerService } from './osd/openseadragon-visualizer.service';
import { NapariVisualizerService } from './napari-js/napari-visualizer.service';
import { VIZ_PORT_STUBS } from '../testing/viz-port-stubs';

type Rect = { x: number; y: number; width: number; height: number };

/**
 * The capability-gated getters of IViewerBackend (IVisualizer split step (e)): the
 * OSD/napari-only extras are reached through a getter that is null on a backend
 * without them, instead of being always-on members that a backend no-ops.
 */
describe('IViewerBackend capability-gated getters', () => {
  let plotly: PlotlyService;
  let osd: OpenSeadragonVisualizerService;
  let napari: NapariVisualizerService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        PlotlyService,
        OpenSeadragonVisualizerService,
        NapariVisualizerService,
        MessageService,
        ...VIZ_PORT_STUBS,
      ],
    });
    plotly = TestBed.inject(PlotlyService);
    osd = TestBed.inject(OpenSeadragonVisualizerService);
    napari = TestBed.inject(NapariVisualizerService);
  });

  it('Plotly has none of them', () => {
    expect(plotly.getOsdViewOptions()).toBeNull();
    expect(plotly.getVolumeResolution()).toBeNull();
    expect(plotly.getIntensitySampling()).toBeNull();
  });

  it('OpenSeadragon: view options forward to its navigator chrome; no volume resolution', () => {
    const chrome = (
      osd as unknown as {
        chrome: { setNavigatorVisible(v: boolean): void; setImageSmoothingEnabled(e: boolean): void };
      }
    ).chrome;
    const nav = jest.spyOn(chrome, 'setNavigatorVisible');
    const smooth = jest.spyOn(chrome, 'setImageSmoothingEnabled');
    osd.getOsdViewOptions().setNavigatorVisible(false);
    osd.getOsdViewOptions().setImageSmoothingEnabled(true);
    expect(nav).toHaveBeenCalledWith(false);
    expect(smooth).toHaveBeenCalledWith(true);
    expect(osd.getVolumeResolution()).toBeNull();
  });

  it('OpenSeadragon reports where its view settled', () => {
    const viewport = (osd as unknown as { viewport: { viewportChange$: Subject<Rect> } }).viewport;
    const seen: Rect[] = [];
    osd
      .getIntensitySampling()
      .getViewportChange$()
      .subscribe((r) => seen.push(r));
    viewport.viewportChange$.next({ x: 1, y: 2, width: 3, height: 4 });
    expect(seen).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
  });

  it('napari-js: view options, the volume resolution and its camera viewport', () => {
    const settings = (
      napari as unknown as {
        settings: { navigatorVisible: boolean; imageSmoothing: boolean };
      }
    ).settings;
    napari.getOsdViewOptions().setNavigatorVisible(false);
    napari.getOsdViewOptions().setImageSmoothingEnabled(true);
    expect(settings.navigatorVisible).toBe(false);
    expect(settings.imageSmoothing).toBe(true);

    const resolution = napari.getVolumeResolution();
    resolution.set(2.6); // rounded, at least 1
    expect(resolution.get()).toBe(3);
    resolution.set(0);
    expect(resolution.get()).toBe(1);

    const viewport$ = (napari as unknown as { viewportChange$: Subject<Rect> }).viewportChange$;
    const seen: Rect[] = [];
    napari
      .getIntensitySampling()
      .getViewportChange$()
      .subscribe((r) => seen.push(r));
    viewport$.next({ x: 5, y: 6, width: 7, height: 8 });
    expect(seen).toEqual([{ x: 5, y: 6, width: 7, height: 8 }]);
  });
});
