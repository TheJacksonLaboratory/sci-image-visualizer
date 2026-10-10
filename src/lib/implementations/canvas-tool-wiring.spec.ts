import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { MessageService } from 'primeng/api';

import { PlotlyService } from './plotly/plotly.service';
import { OpenSeadragonVisualizerService } from './osd/openseadragon-visualizer.service';
import { NapariVisualizerService } from './napari-js/napari-visualizer.service';
import { VIZ_PORT_STUBS } from '../testing/viz-port-stubs';
import { CanvasToolManager } from '../toolbar/tool-kit/canvas-tool-manager';
import { CanvasToolHost } from '../toolbar/tool-kit/canvas-tool';
import { CANVAS_TOOL_IDS } from '../contracts/display-types';
import { RegionStore } from '../store/region-store.service';
import { Rectangle, Region } from '../models/region';

type Backend = PlotlyService | OpenSeadragonVisualizerService | NapariVisualizerService;
const tools = (b: Backend) => (b as unknown as { canvasTools: CanvasToolManager }).canvasTools;
const host = (b: Backend) => (b as unknown as { toolHost: CanvasToolHost }).toolHost;

/**
 * The canvas tools were root singletons that every backend re-bound to its own
 * host before each activation (RT-21, OSD-PLOTLY-17). Now each backend builds
 * its own tools over one host of its own.
 */
describe('canvas tools per backend (RT-21)', () => {
  let backends: Backend[];

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, OpenSeadragonVisualizerService, NapariVisualizerService,
        MessageService, ...VIZ_PORT_STUBS],
    });
    backends = [
      TestBed.inject(PlotlyService),
      TestBed.inject(OpenSeadragonVisualizerService),
      TestBed.inject(NapariVisualizerService),
    ];
  });

  it('gives every backend its own manager and its own tool instances', () => {
    const [plotly, osd, napari] = backends.map(tools);
    expect(new Set([plotly, osd, napari]).size).toBe(3);
    for (const id of CANVAS_TOOL_IDS) {
      expect(plotly.has(id) && osd.has(id) && napari.has(id)).toBe(true);
      expect(new Set([plotly.get(id), osd.get(id), napari.get(id)]).size).toBe(3);
    }
  });

  it('arming a tool on one backend leaves another backend\'s armed tool and host alone', () => {
    const [plotly, osd] = backends;
    osd.setActiveTool('wand', { sensitivity: 2 });
    plotly.setActiveTool('wand', { sensitivity: 3 });
    expect(tools(osd).activeId).toBe('wand');
    const osdWand = tools(osd).get('wand') as unknown as { host: CanvasToolHost };
    expect(osdWand.host).toBe(host(osd));
    expect(host(osd)).not.toBe(host(plotly));
  });

  it('hands every tool one host that exposes the readback and the zoom-to-box members (RT-14)', () => {
    for (const b of backends) {
      const h = host(b);
      expect(typeof h.getCachedImageData).toBe('function');
      expect(typeof h.pixelToData).toBe('function');
      expect(typeof h.applyZoomToBox).toBe('function');
    }
  });

  it('drops the tools\' work in progress on undo and redo', () => {
    for (const b of backends) {
      const resetAll = jest.spyOn(tools(b), 'resetAll');
      b.undo();
      b.redo();
      expect(resetAll).toHaveBeenCalledTimes(2);
      resetAll.mockRestore();
    }
  });

  // The router writes undo/redo/slice switches straight to the store (IVisualizer split (d)),
  // so the resets must come from the store's event, not from the backend's own members.
  it('resets every backend\'s tools on a store undo, redo or slice switch — not on an ordinary edit', () => {
    const regionStore = TestBed.inject(RegionStore);
    const spies = backends.map((b) => jest.spyOn(tools(b), 'resetAll'));
    regionStore.setRegions([Object.assign(new Region(), {
      bounds: Object.assign(new Rectangle(), { x: 0, y: 0, width: 4, height: 4 }),
    })]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    regionStore.undo();
    regionStore.redo();
    regionStore.setDisplaySlice(1);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(3);
  });
});
