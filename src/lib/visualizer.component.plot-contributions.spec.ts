import { BehaviorSubject, Subject } from 'rxjs';
import { Component, Inject, Injector, NO_ERRORS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CommonModule } from '@angular/common';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { DialogModule } from 'primeng/dialog';
import { MessageService } from 'primeng/api';

// Capture the RenderOrchestrator host config so a test can land a render
// (`finished`) exactly when it wants to — the point at which a contributed mode
// is activated. Same technique as visualizer.component.spec.ts.
const orchestratorHosts: any[] = [];
jest.mock('./render-orchestrator', () => {
  const actual = jest.requireActual('./render-orchestrator');
  return {
    ...actual,
    RenderOrchestrator: jest.fn().mockImplementation((host: any) => {
      orchestratorHosts.push(host);
      return { render: jest.fn().mockResolvedValue(undefined) };
    }),
  };
});

import { VisualizerComponent } from './visualizer.component';
import { PlotType, PLOT_TYPE_DESCRIPTORS } from './contracts/plot-type';
import {
  PLOT_MODE_CONTEXT,
  PLOT_MODE_SESSION,
  PLOT_TYPE_CONTRIBUTIONS,
  PlotModeContext,
  PlotModeSession,
  PlotModeViewport,
  PlotTypeContribution,
} from './contracts/plot-type-contribution.contract';
import { IMAGE_STATE_PORT } from './contracts/ports/image-state.port';
import { VISUALIZER } from './contracts/visualizer.contract';
import { VisualizerStore } from './store/visualizer-store.service';
import { RegionOpsService } from './region-ops.service';
import { WandService } from './toolbar/wand/wand.service';
import { SamToolService } from './toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from './toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from './toolbar/segmentation/cell-segment-tool.service';

/**
 * PLOT_TYPE_CONTRIBUTIONS as the visualizer sees it: the selector merge and its
 * curation, routing a contributed id to its base type, the activate/deactivate
 * lifecycle around the render pipeline, isolation from a failing contribution,
 * and the panel.
 */

const BUILT_INS = Object.values(PLOT_TYPE_DESCRIPTORS).filter(Boolean) as any[];

function toolFeeds(): any {
  return { status$: new BehaviorSubject(''), busy$: new BehaviorSubject(false), progress$: new BehaviorSubject(-1) };
}

/** Any unlisted `getX$()` / `isX()` answers with a BehaviorSubject, anything else
 *  with a jest.fn() — so ngOnInit's long tail of subscriptions is satisfied. */
function selfCompleting(base: any): any {
  return new Proxy(base, {
    has: () => true,
    get(target, prop: any) {
      if (typeof prop !== 'string' || prop in target) return target[prop];
      target[prop] = /\$$|^(get|is)[A-Z]/.test(prop)
        ? jest.fn(() => new BehaviorSubject(false))
        : jest.fn();
      return target[prop];
    },
  });
}

function mockViewport(): PlotModeViewport {
  return {
    getOverlayContainer: () => null,
    dataToClient: (x, y) => ({ x, y }),
    clientToData: (x, y) => ({ x, y }),
    dataLengthToScreen: (l) => l,
    isReady: () => true,
    frame$: new Subject(),
    settled$: new Subject(),
  };
}

function infoFor(fileName: string, over: any = {}): any {
  return {
    fileName,
    urls: [`/api/preview?info=${fileName}`],
    isStack: false,
    showStack: false,
    isGrayscale: true,
    trueImageSize: [100, 100],
    imageMeta: [{ x: 100, y: 100, z: 1, rgbChannels: 1, channelCount: 1 }],
    ...over,
  };
}

/** Records the order of lifecycle events across the contribution and the viewer. */
let events: string[] = [];

function dianne(over: Partial<PlotTypeContribution> = {}): PlotTypeContribution & {
  sessions: PlotModeSession[];
} {
  const sessions: PlotModeSession[] = [];
  const c: any = {
    sessions,
    descriptor: {
      type: 'dianne',
      label: 'Digital Pathology - DIANNE',
      productionLabel: 'DIANNE',
      icon: 'pi pi-pencil',
      dimensions: '2d',
      baseType: PlotType.IMAGE,
    },
    activate: jest.fn((_ctx: PlotModeContext) => {
      events.push('activate');
      const s = { deactivate: jest.fn(() => events.push('deactivate')) };
      sessions.push(s);
      return s;
    }),
    ...over,
  };
  return c;
}

function plotBase(viewport: PlotModeViewport | null): any {
  return {
    capabilities: { has: () => true },
    getColormapOptions: jest.fn().mockReturnValue([{ children: [{ label: 'Greys Inv' }] }]),
    getPlotTypeDescriptors: jest.fn().mockReturnValue(BUILT_INS),
    getAutoscaleEvent: () => new BehaviorSubject(''),
    getColormap: () => new BehaviorSubject('Greys'),
    getReverseScale: () => new BehaviorSubject(false),
    getIntensityProfile$: () => new BehaviorSubject([]),
    getStackLoadingProgress: () => new BehaviorSubject(0),
    getViewportChange$: () => new BehaviorSubject({ x: 0, y: 0, width: 1, height: 1 }),
    isStackLoading: () => new BehaviorSubject(false),
    getRegions: jest.fn().mockReturnValue([]),
    getRegionOverlay: jest.fn().mockReturnValue({ setMode: jest.fn() }),
    getShowShapeLabel: jest.fn().mockReturnValue(false),
    importRegions: jest.fn().mockReturnValue([]),
    load: jest.fn().mockImplementation((info: any) => Promise.resolve({ filename: info.fileName })),
    plot: jest.fn().mockResolvedValue(true),
    reset: jest.fn(() => events.push('reset')),
    setPlotType: jest.fn((t: PlotType) => events.push(`setPlotType:${t}`)),
    getPlotModeViewport: jest.fn(() => viewport),
  };
}

function harness(contributions: unknown[] | undefined, viewport: PlotModeViewport | null = mockViewport()) {
  const plot = selfCompleting(plotBase(viewport));
  const imageInfo$ = new BehaviorSubject<any>(null);
  const state = selfCompleting({
    getImageInfo$: () => imageInfo$,
    getFilename$: () => new BehaviorSubject('none'),
    getImageLoadingMessage$: () => new BehaviorSubject(''),
    getCacheProgress$: () => new BehaviorSubject(null),
    getPanelWidth$: () => new BehaviorSubject(500),
    isImageLoading$: () => new BehaviorSubject(false),
    isZoom$: () => new BehaviorSubject(false),
    // The host re-publishes whatever the visualizer pushes back (reloadAndPlot).
    setImageInfo: jest.fn((info: any) => imageInfo$.next(info)),
  });
  const messages = { add: jest.fn(), clear: jest.fn() };
  const component = new VisualizerComponent(
    state,
    plot,
    messages as any,
    { run: (fn: () => void) => fn(), runOutsideAngular: (fn: () => void) => fn() } as any,
    { detectChanges: jest.fn(), markForCheck: jest.fn() } as any,
    new VisualizerStore(),
    toolFeeds(), toolFeeds(), toolFeeds(),
    new RegionOpsService(new WandService()),
    undefined, // VIZ_CONFIG
    undefined, // TOOLBAR_TOOLS
    undefined, // SPATIAL_DATA_PORT
    contributions as any, // PLOT_TYPE_CONTRIBUTIONS
    Injector.create({ providers: [] }),
  );
  component.ngOnInit();
  /** Land the most recent render, as RenderOrchestrator would once it finished. */
  const finish = () => orchestratorHosts[orchestratorHosts.length - 1].finished(false, 'done');
  /** Drive the most recent render's plot phase and return what it plotted with. */
  const renderPhase = async () => {
    const host = orchestratorHosts[orchestratorHosts.length - 1];
    await host.renderPhase(imageInfo$.value, false);
    return plot.plot.mock.calls[plot.plot.mock.calls.length - 1];
  };
  return { component, plot, state, imageInfo$, messages, finish, renderPhase };
}

beforeEach(() => {
  orchestratorHosts.length = 0;
  events = [];
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('PLOT_TYPE_CONTRIBUTIONS', () => {
  it('has no factory: with no provider it is simply absent', () => {
    expect(Injector.create({ providers: [] }).get(PLOT_TYPE_CONTRIBUTIONS, null)).toBeNull();
  });

  it('collects plain-object contributions from useValue and useFactory multi-providers', () => {
    const a = dianne();
    const b = dianne();
    b.descriptor = { ...b.descriptor, type: 'other' };
    const injector = Injector.create({
      providers: [
        { provide: PLOT_TYPE_CONTRIBUTIONS, useValue: a, multi: true },
        { provide: PLOT_TYPE_CONTRIBUTIONS, useFactory: () => b, multi: true },
      ],
    });
    expect(injector.get(PLOT_TYPE_CONTRIBUTIONS)).toEqual([a, b]);
  });
});

describe('contributed plot types — the selector', () => {
  const types = (c: VisualizerComponent) => c.plotTypeOptions.map((d) => d.type);

  it('is unchanged when nothing is contributed', () => {
    const withNone = harness(undefined).component;
    const withEmpty = harness([]).component;
    expect(types(withNone)).toContain(PlotType.IMAGE);
    expect(types(withNone).every((t) => (Object.values(PlotType) as string[]).includes(t))).toBe(true);
    expect(withEmpty.plotTypeOptions).toEqual(withNone.plotTypeOptions);
    // …and a contribution only ever adds to the end of that list.
    const withOne = harness([dianne()]).component;
    expect(withOne.plotTypeOptions.slice(0, -1)).toEqual(withNone.plotTypeOptions);
  });

  it('appends contributed modes after every built-in one, under the production label', () => {
    const { component } = harness([dianne()]);
    const opts = component.plotTypeOptions;
    expect(opts[opts.length - 1]).toEqual(expect.objectContaining({
      type: 'dianne', label: 'DIANNE', baseType: PlotType.IMAGE, source: 'image', dimensions: '2d',
    }));
    expect(types(component).indexOf('dianne')).toBe(opts.length - 1);
  });

  it('keeps a mode without productionLabel test-only, and shows the full label in test mode', () => {
    const testOnly = dianne();
    testOnly.descriptor = { ...testOnly.descriptor, productionLabel: undefined };
    const { component } = harness([testOnly]);
    expect(types(component)).not.toContain('dianne');

    component.testMode = true;
    component.ngOnChanges({ testMode: {} as any });
    expect(component.plotTypeOptions.find((d) => d.type === 'dianne')?.label)
      .toBe('Digital Pathology - DIANNE');
  });

  it('applies requiresGrayscale and requiresStack like the built-ins do', () => {
    const gray = dianne();
    gray.descriptor = { ...gray.descriptor, type: 'gray', requiresGrayscale: true };
    const stack = dianne();
    stack.descriptor = { ...stack.descriptor, type: 'stack', requiresStack: true };
    const { component, imageInfo$ } = harness([gray, stack]);

    imageInfo$.next(infoFor('rgb.tif', { isGrayscale: false, imageMeta: [{ rgbChannels: 3, channelCount: 3 }] }));
    expect(types(component)).not.toContain('gray');
    expect(types(component)).not.toContain('stack');

    imageInfo$.next(infoFor('gray-stack.tif', { isStack: true, urls: ['/a', '/b'] }));
    expect(types(component)).toContain('gray');
    expect(types(component)).toContain('stack');
  });

  it('applies requiresSpatialData and requiresSpatial3d to contributed modes', () => {
    const spatial = dianne();
    spatial.descriptor = { ...spatial.descriptor, type: 'spatial', requiresSpatialData: true };
    const spatial3d = dianne();
    spatial3d.descriptor = { ...spatial3d.descriptor, type: 'spatial3d', requiresSpatial3d: true };
    const { component } = harness([spatial, spatial3d]);
    const c = component as any;
    expect(types(component)).not.toContain('spatial');
    expect(types(component)).not.toContain('spatial3d');

    c.hasSpatialDataset = true;
    c.spatialDatasetHasPixels = true; // a tissue image under the observations
    c.computePlotTypeOptions();
    expect(types(component)).toContain('spatial');
    expect(types(component)).not.toContain('spatial3d');

    c.hasSpatial3dDataset = true;
    c.computePlotTypeOptions();
    expect(types(component)).toContain('spatial3d');
  });

  it('hides an Image-based mode wherever Image itself is hidden (a spatial dataset without pixels)', () => {
    const { component } = harness([dianne()]);
    (component as any).hasSpatialDataset = true;
    (component as any).spatialDatasetHasPixels = false;
    (component as any).computePlotTypeOptions();
    expect(types(component)).not.toContain(PlotType.IMAGE);
    expect(types(component)).not.toContain('dianne');
  });

  it('drops a contribution whose id clashes with a built-in type', () => {
    const clash = dianne();
    clash.descriptor = { ...clash.descriptor, type: PlotType.HEATMAP, label: 'Impostor' };
    const { component } = harness([clash]);
    expect(component.plotTypeOptions.filter((d) => d.type === PlotType.HEATMAP)).toHaveLength(1);
    expect(component.plotTypeOptions.find((d) => d.type === PlotType.HEATMAP)?.label).toBe('Heatmap');
  });
});

describe('contributed plot types — routing and lifecycle', () => {
  it('routes a contributed id to its base type for every rendering decision', async () => {
    const { component, plot, imageInfo$, renderPhase } = harness([dianne()]);
    imageInfo$.next(infoFor('a.tif'));
    component.onSelectPlotType('dianne');

    expect(component.selectedPlotType).toBe('dianne');
    expect(component.plotType).toBe(PlotType.IMAGE);
    expect(component.basePlotType).toBe(PlotType.IMAGE);
    expect(plot.setPlotType).toHaveBeenLastCalledWith(PlotType.IMAGE);
    expect(component.isImageView).toBe(true);
    expect(component.isHeatmap).toBe(true);
    const plotted = await renderPhase();
    expect(plotted[4]).toBe(PlotType.IMAGE);
  });

  it('activates once the base view has plotted, with the public visualizer and its viewport', () => {
    const mode = dianne();
    const viewport = mockViewport();
    const { component, plot, state, imageInfo$, finish } = harness([mode], viewport);
    imageInfo$.next(infoFor('a.tif'));
    finish();
    expect(mode.activate).not.toHaveBeenCalled(); // Image is not a contributed mode

    component.onSelectPlotType('dianne');
    expect(mode.activate).not.toHaveBeenCalled(); // not before the base has plotted
    finish();

    expect(mode.activate).toHaveBeenCalledTimes(1);
    const ctx = (mode.activate as jest.Mock).mock.calls[0][0] as PlotModeContext;
    expect(ctx.visualizer).toBe(plot);
    expect(ctx.viewport).toBe(viewport);
    expect(ctx.imageInfo$).toBe(state.getImageInfo$());
  });

  it('deactivates exactly once when another type is picked, before that type is set up', () => {
    const mode = dianne();
    const { component, imageInfo$, finish } = harness([mode]);
    imageInfo$.next(infoFor('a.tif'));
    component.onSelectPlotType('dianne');
    finish();
    events = [];

    component.onSelectPlotType(PlotType.HEATMAP);
    finish();
    expect(mode.sessions[0].deactivate).toHaveBeenCalledTimes(1);
    expect(events.indexOf('deactivate')).toBeLessThan(events.indexOf(`setPlotType:${PlotType.HEATMAP}`));
    expect(events.indexOf('deactivate')).toBeLessThan(events.indexOf('reset'));
    expect(mode.activate).toHaveBeenCalledTimes(1);
  });

  it('ends the session on an image switch before the next render, and starts a fresh one after it', () => {
    const mode = dianne();
    const { component, imageInfo$, finish } = harness([mode]);
    imageInfo$.next(infoFor('a.tif'));
    component.onSelectPlotType('dianne');
    finish();
    events = [];

    imageInfo$.next(infoFor('b.tif'));
    expect(events.slice(0, 2)).toEqual(['deactivate', 'reset']);
    expect(mode.sessions[0].deactivate).toHaveBeenCalledTimes(1);
    expect(component.selectedPlotType).toBe('dianne');

    finish();
    expect(mode.activate).toHaveBeenCalledTimes(2);
    expect(mode.sessions[1].deactivate).not.toHaveBeenCalled();
  });

  it('deactivates on destroy, once', () => {
    const mode = dianne();
    const { component, imageInfo$, finish } = harness([mode]);
    imageInfo$.next(infoFor('a.tif'));
    component.onSelectPlotType('dianne');
    finish();
    component.ngOnDestroy();
    expect(mode.sessions[0].deactivate).toHaveBeenCalledTimes(1);
  });

  it('never re-activates a render that was superseded', () => {
    const mode = dianne();
    const { component, imageInfo$ } = harness([mode]);
    imageInfo$.next(infoFor('a.tif'));
    component.onSelectPlotType('dianne');
    const stale = orchestratorHosts[orchestratorHosts.length - 1];
    imageInfo$.next(infoFor('b.tif'));
    stale.finished(false, 'stale');
    expect(mode.activate).not.toHaveBeenCalled();
  });

  it('an explicit selection clears recorded cleanup failures before re-activating', () => {
    const { component } = harness([dianne()]);
    const modes = (component as any).plotModes;
    const clear = jest.spyOn(modes, 'clearCleanupFailures');
    const deactivate = jest.spyOn(modes, 'deactivate');
    component.onSelectPlotType('dianne');
    expect(clear).toHaveBeenCalled();
    expect(clear.mock.invocationCallOrder[0]).toBeLessThan(deactivate.mock.invocationCallOrder[0]!);
  });

  it('falls back to Image for a stale contributed id (its provider is gone)', () => {
    const { component, plot, imageInfo$ } = harness([]);
    imageInfo$.next(infoFor('a.tif'));
    component.onSelectPlotType('dianne');
    expect(component.selectedPlotType).toBe(PlotType.IMAGE);
    expect(plot.setPlotType).toHaveBeenLastCalledWith(PlotType.IMAGE);

    // …and a selection restored behind the component's back is reconciled too.
    component.selectedPlotType = 'dianne';
    (component as any).reconcileSelectedPlotType();
    expect(component.selectedPlotType).toBe(PlotType.IMAGE);
  });
});

describe('contributed plot types — isolation', () => {
  function expectFellBack(h: ReturnType<typeof harness>) {
    expect(h.component.selectedPlotType).toBe(PlotType.IMAGE);
    expect(h.component.plotType).toBe(PlotType.IMAGE);
    expect(h.component.plotModePanel).toBeNull();
    expect(h.messages.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warn' }));
  }

  it('a throwing activate() falls back to the base type without breaking the render', () => {
    const mode = dianne({ activate: jest.fn(() => { throw new Error('boom'); }) });
    const h = harness([mode]);
    h.imageInfo$.next(infoFor('a.tif'));
    h.component.onSelectPlotType('dianne');
    expect(() => h.finish()).not.toThrow();
    expectFellBack(h);
  });

  it('a rejected activate() falls back to the base type', async () => {
    const mode = dianne({ activate: jest.fn(() => Promise.reject(new Error('nope'))) });
    const h = harness([mode]);
    h.imageInfo$.next(infoFor('a.tif'));
    h.component.onSelectPlotType('dianne');
    h.finish();
    await new Promise((r) => setTimeout(r, 0));
    expectFellBack(h);
  });

  it('a throwing deactivate() does not stop the next mode', () => {
    const mode = dianne({
      activate: jest.fn(() => ({ deactivate: () => { throw new Error('bad'); } })),
    });
    const h = harness([mode]);
    h.imageInfo$.next(infoFor('a.tif'));
    h.component.onSelectPlotType('dianne');
    h.finish();
    expect(() => h.component.onSelectPlotType(PlotType.HEATMAP)).not.toThrow();
    expect(h.component.selectedPlotType).toBe(PlotType.HEATMAP);
  });

  it('falls back when the backend on screen offers no viewport (e.g. OSD fell back to Plotly)', () => {
    const mode = dianne();
    const h = harness([mode], null);
    h.imageInfo$.next(infoFor('a.tif'));
    h.component.onSelectPlotType('dianne');
    h.finish();
    expect(mode.activate).not.toHaveBeenCalled();
    expectFellBack(h);
  });
});

describe('contributed plot types — panel state', () => {
  it('a component panel gets PLOT_MODE_CONTEXT and PLOT_MODE_SESSION, and goes on deactivate', () => {
    class Panel {}
    const mode = dianne({ panel: { title: 'DIANNE', component: Panel } });
    const { component, imageInfo$, finish } = harness([mode]);
    imageInfo$.next(infoFor('a.tif'));
    component.onSelectPlotType('dianne');
    finish();

    const panel = component.plotModePanel!;
    expect(panel.title).toBe('DIANNE');
    expect(panel.component).toBe(Panel);
    expect(panel.injector!.get(PLOT_MODE_SESSION)).toBe(mode.sessions[0]);
    expect(panel.injector!.get(PLOT_MODE_CONTEXT).viewport).toBeTruthy();

    component.onSelectPlotType(PlotType.HEATMAP);
    expect(component.plotModePanel).toBeNull();
  });

  it('a mount panel is handed a host element, torn down before deactivate', () => {
    const teardown = jest.fn(() => events.push('teardown'));
    const mount = jest.fn((host: HTMLElement) => { host.textContent = 'mounted'; return teardown; });
    const mode = dianne({ panel: { title: 'DIANNE', mount } });
    const { component, imageInfo$, finish } = harness([mode]);
    imageInfo$.next(infoFor('a.tif'));
    component.onSelectPlotType('dianne');
    finish();

    const host = component.plotModePanel!.host!;
    expect(host.textContent).toBe('mounted');
    expect(mount).toHaveBeenCalledWith(host, expect.any(Object), mode.sessions[0]);
    events = [];
    component.onSelectPlotType(PlotType.HEATMAP);
    expect(events.slice(0, 2)).toEqual(['teardown', 'deactivate']);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(component.plotModePanel).toBeNull();
  });
});

/**
 * The real template: the panel is rendered through NgComponentOutlet in the
 * right-hand dialog, and the contributed component resolves the context and
 * session from its injector. Registered exactly as a contributing package would
 * — a plain object on the multi token, no decorators on the contributor's side.
 */
describe('contributed plot types — panel rendering', () => {
  @Component({ selector: 'test-mode-panel', template: '<span class="probe">{{ label }}</span>' })
  class ModePanelComponent {
    label: string;
    constructor(@Inject(PLOT_MODE_CONTEXT) ctx: PlotModeContext,
                @Inject(PLOT_MODE_SESSION) session: PlotModeSession) {
      this.label = `${ctx.viewport.isReady() ? 'ready' : 'not-ready'}:${typeof session.deactivate}`;
    }
  }

  async function mount(panel: PlotTypeContribution['panel']) {
    const mode = dianne({ panel });
    const plot = selfCompleting(plotBase(mockViewport()));
    const imageInfo$ = new BehaviorSubject<any>(null);
    const state = selfCompleting({
      getImageInfo$: () => imageInfo$,
      getCacheProgress$: () => new BehaviorSubject(null),
      getFilename$: () => new BehaviorSubject(undefined),
      getImageLoadingMessage$: () => new BehaviorSubject(''),
    });
    await TestBed.configureTestingModule({
      declarations: [VisualizerComponent, ModePanelComponent],
      imports: [CommonModule, DialogModule, NoopAnimationsModule],
      providers: [
        { provide: IMAGE_STATE_PORT, useValue: state },
        { provide: VISUALIZER, useValue: plot },
        { provide: PLOT_TYPE_CONTRIBUTIONS, useValue: mode, multi: true },
        { provide: MessageService, useValue: { add: jest.fn(), clear: jest.fn() } },
        { provide: SamToolService, useValue: toolFeeds() },
        { provide: SamPointToolService, useValue: toolFeeds() },
        { provide: CellSegmentToolService, useValue: toolFeeds() },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
    const fixture = TestBed.createComponent(VisualizerComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    imageInfo$.next(infoFor('a.tif'));
    component.onSelectPlotType('dianne');
    orchestratorHosts[orchestratorHosts.length - 1].finished(false, 'done');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, component, mode };
  }

  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.querySelectorAll('.p-dialog').forEach((el) => el.remove());
  });

  it('renders the component panel with the context and session injected, titled, and removes it on leave', async () => {
    const { fixture, component, mode } = await mount({ title: 'DIANNE panel', component: ModePanelComponent });

    expect(document.body.querySelector('.probe')?.textContent).toBe('ready:function');
    expect(document.body.querySelector('.plot-mode-panel')?.textContent).toContain('DIANNE panel');

    component.onSelectPlotType(PlotType.HEATMAP);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.body.querySelector('.probe')).toBeNull();
    expect(mode.sessions[0].deactivate).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('attaches a mount panel\'s host inside the dialog', async () => {
    const teardown = jest.fn();
    const { fixture, component } = await mount({
      title: 'DIANNE',
      mount: (host) => { host.innerHTML = '<b class="mounted">hi</b>'; return teardown; },
    });
    const slot = document.body.querySelector('.plot-mode-panel-slot');
    expect(slot?.querySelector('.mounted')?.textContent).toBe('hi');

    component.onSelectPlotType(PlotType.HEATMAP);
    fixture.detectChanges();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('.mounted')).toBeNull();
    fixture.destroy();
  });
});
