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
import { TOOLBAR_TOOLS, ToolbarDialogToolContribution } from './contracts/toolbar-tool.contract';
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

function harness(contributions: unknown[] | undefined, viewport: PlotModeViewport | null = mockViewport(),
                 toolContributions?: unknown[]) {
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
    toolContributions as any, // TOOLBAR_TOOLS
    undefined, // SPATIAL_DATA_PORT
    contributions as any, // PLOT_TYPE_CONTRIBUTIONS
    Injector.create({ providers: [] }),
  );
  component.ngOnInit();
  /** Land the most recent render, as RenderOrchestrator would once it finished. */
  const finish = () => orchestratorHosts[orchestratorHosts.length - 1].finished(false);
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
  const types = (c: VisualizerComponent) => c.plotTypeMenu.map((d) => d.type);

  it('is unchanged when nothing is contributed', () => {
    const withNone = harness(undefined).component;
    const withEmpty = harness([]).component;
    expect(types(withNone)).toContain(PlotType.IMAGE);
    expect(types(withNone).every((t) => (Object.values(PlotType) as string[]).includes(t))).toBe(true);
    expect(withEmpty.plotTypeMenu).toEqual(withNone.plotTypeMenu);
    // …and a contribution only ever adds to the end of that list.
    const withOne = harness([dianne()]).component;
    expect(withOne.plotTypeMenu.slice(0, -1)).toEqual(withNone.plotTypeMenu);
  });

  it('appends contributed modes after every built-in one, under the production label', () => {
    const { component } = harness([dianne()]);
    const opts = component.plotTypeMenu;
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
    expect(component.plotTypeMenu.find((d) => d.type === 'dianne')?.label)
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

  it('keeps plotTypeOptions / selectedPlotType with their original types and meaning', () => {
    const none = harness([]).component;
    const { component } = harness([dianne()]);
    // plotTypeOptions: still exactly the built-in list, as before contributions existed.
    expect(component.plotTypeOptions).toEqual(none.plotTypeOptions);
    expect(component.plotTypeOptions.every((d) => Object.values(PlotType).includes(d.type))).toBe(true);
    expect(component.plotTypeMenu.map((d) => d.type)).toContain('dianne');
    // selectedPlotType: the built-in type on screen; equals the selection for built-ins.
    component.onSelectPlotType(PlotType.HEATMAP);
    expect(component.selectedPlotType).toBe(PlotType.HEATMAP);
    component.onSelectPlotType('dianne');
    expect(component.selectedPlotTypeId).toBe('dianne');
    expect(component.selectedPlotType).toBe(PlotType.IMAGE); // its baseType
    component.selectedPlotType = PlotType.HEATMAP; // writing still selects a built-in
    expect(component.selectedPlotTypeId).toBe(PlotType.HEATMAP);
  });

  it('drops a contribution whose id clashes with a built-in type', () => {
    const clash = dianne();
    clash.descriptor = { ...clash.descriptor, type: PlotType.HEATMAP, label: 'Impostor' };
    const { component } = harness([clash]);
    expect(component.plotTypeMenu.filter((d) => d.type === PlotType.HEATMAP)).toHaveLength(1);
    expect(component.plotTypeMenu.find((d) => d.type === PlotType.HEATMAP)?.label).toBe('Heatmap');
  });
});

describe('contributed plot types — routing and lifecycle', () => {
  it('routes a contributed id to its base type for every rendering decision', async () => {
    const { component, plot, imageInfo$, renderPhase } = harness([dianne()]);
    imageInfo$.next(infoFor('a.tif'));
    component.onSelectPlotType('dianne');

    expect(component.selectedPlotTypeId).toBe('dianne');
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
    expect(component.selectedPlotTypeId).toBe('dianne');

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
    stale.finished(false);
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
    expect(component.selectedPlotTypeId).toBe(PlotType.IMAGE);
    expect(plot.setPlotType).toHaveBeenLastCalledWith(PlotType.IMAGE);

    // …and a selection restored behind the component's back is reconciled too.
    component.selectedPlotTypeId = 'dianne';
    (component as any).reconcileSelectedPlotType();
    expect(component.selectedPlotTypeId).toBe(PlotType.IMAGE);
  });
});

describe('contributed plot types — isolation', () => {
  function expectFellBack(h: ReturnType<typeof harness>) {
    expect(h.component.selectedPlotTypeId).toBe(PlotType.IMAGE);
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
    expect(h.component.selectedPlotTypeId).toBe(PlotType.HEATMAP);
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
    return mountWith([], panel);
  }

  async function mountWith(extra: any[], panel: PlotTypeContribution['panel']) {
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
      declarations: [VisualizerComponent, ModePanelComponent, ...extra],
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
    orchestratorHosts[orchestratorHosts.length - 1].finished(false);
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

  it('falls back to Image when the component panel throws while it is created', async () => {
    @Component({ selector: 'test-broken-panel', template: '<i></i>' })
    class BrokenPanelComponent {
      constructor() { throw new Error('panel constructor failed'); }
    }
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, component, mode } = await mountWith([BrokenPanelComponent], {
      title: 'Broken', component: BrokenPanelComponent,
    });
    expect(component.selectedPlotTypeId).toBe(PlotType.IMAGE);
    expect(mode.sessions[0].deactivate).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('.plot-mode-panel')).toBeNull();
    errors.mockRestore();
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

describe('contributed plot types — toolbar tools (ctx.tools)', () => {
  function activeCtx() {
    const mode = dianne();
    const h = harness([mode]);
    h.imageInfo$.next(infoFor('a.tif'));
    h.component.onSelectPlotType('dianne');
    h.finish();
    const ctx = (mode.activate as jest.Mock).mock.calls[0][0] as PlotModeContext;
    const tools = ctx.tools!;
    const armed: (string | null)[] = [];
    tools.activeTool$.subscribe((t) => armed.push(t));
    return { ...h, tools, armed };
  }

  it('armBrush arms the toolbar brush with the class, and activeTool$ follows', () => {
    const { component, plot, tools, armed } = activeCtx();

    tools.armBrush({ label: 'dianne:positive', color: '#1E88E5' });

    expect(component.activeDragMode).toBe('brush');
    expect(plot.setActiveTool).toHaveBeenLastCalledWith('brush', {
      size: component.brushSize, label: 'dianne:positive', color: '#1E88E5',
    });
    expect(armed[armed.length - 1]).toBe('brush');
  });

  it('arming again while the brush is armed switches class without re-arming', () => {
    const { component, plot, tools } = activeCtx();
    tools.armBrush({ label: 'pos', color: '#00f' });
    const armCalls = plot.setActiveTool.mock.calls.length;

    tools.armBrush({ label: 'neg', color: '#f00' });

    expect(plot.setActiveTool.mock.calls.length).toBe(armCalls);
    expect(plot.setBrushOptions).toHaveBeenLastCalledWith({ size: component.brushSize, label: 'neg', color: '#f00' });
    expect(component.activeDragMode).toBe('brush');
  });

  it('the size slider keeps the class (size-only update)', () => {
    const { component, plot, tools } = activeCtx();
    tools.armBrush({ label: 'pos', color: '#00f' });

    component.onBrushSizeChange(12);

    expect(plot.setBrushOptions).toHaveBeenLastCalledWith({ size: 12 });
  });

  it('a tool picked from the toolbar is the plain tool again', () => {
    const { component, plot, tools, armed } = activeCtx();
    tools.armBrush({ label: 'pos', color: '#00f' });

    component.toggleDragMode('pan');
    expect(armed[armed.length - 1]).toBe('pan');
    component.toggleDragMode('brush');

    expect(plot.setActiveTool).toHaveBeenLastCalledWith('brush', { size: component.brushSize });
  });

  it('disarm clears the armed tool', () => {
    const { component, plot, tools, armed } = activeCtx();
    tools.armBrush({ label: 'pos' });

    tools.disarm();

    expect(component.activeDragMode).toBeNull();
    expect(plot.setActiveTool).toHaveBeenLastCalledWith(null, undefined);
    expect(armed[armed.length - 1]).toBeNull();
  });
});

describe('dialog tools (TOOLBAR_TOOLS, kind: dialog)', () => {
  // No template in these specs, so nothing attaches the dialog body's host: `attach()`
  // does what the rendered dialog does, then runs the frame the component waits on.
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    frames = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });
  afterEach(() => document.body.querySelectorAll('.tool-dialog-body').forEach((el) => el.remove()));
  function runFrames(n = 1) {
    for (let i = 0; i < n; i++) {
      const pending = frames;
      frames = [];
      pending.forEach((cb) => cb(0));
    }
  }

  function dialogTool(over: Partial<ToolbarDialogToolContribution> = {}) {
    const sessions: PlotModeSession[] = [];
    const teardowns: jest.Mock[] = [];
    const tool: ToolbarDialogToolContribution = {
      kind: 'dialog',
      id: 'dianne',
      label: 'DIANNE',
      icon: { pi: 'pi-pencil' },
      tooltip: 'Digital Pathology - DIANNE',
      activate: jest.fn(() => {
        events.push('activate');
        const s = { deactivate: jest.fn(() => events.push('deactivate')) };
        sessions.push(s);
        return s;
      }),
      mount: jest.fn((host: HTMLElement) => {
        events.push(`mount:${host.isConnected ? 'connected' : 'detached'}`);
        host.textContent = 'body';
        const t = jest.fn(() => events.push('teardown'));
        teardowns.push(t);
        return t;
      }),
      ...over,
    };
    return { tool, sessions, teardowns };
  }

  function opened(over: Partial<ToolbarDialogToolContribution> = {}, attach = true) {
    const d = dialogTool(over);
    const h = harness(undefined, mockViewport(), [d.tool]);
    h.imageInfo$.next(infoFor('a.tif'));
    h.finish();
    h.component.toggleDialogTool('dianne');
    const attachHost = () => {
      const host = h.component.toolDialog?.host;
      if (host) document.body.appendChild(host);
      runFrames();
    };
    if (attach) attachHost();
    return { ...h, ...d, attachHost };
  }

  it('lists dialog tools apart from the run tools', () => {
    const { component } = opened();
    expect(component.dialogTools.map((t) => t.id)).toEqual(['dianne']);
    expect(component.contributedTools).toEqual([]);
  });

  it('opening starts a session with the Image view context and mounts the body in the dialog', () => {
    const { component, plot, tool } = opened();
    expect(tool.activate).toHaveBeenCalledTimes(1);
    const ctx = (tool.activate as jest.Mock).mock.calls[0][0];
    expect(ctx.visualizer).toBe(plot);
    expect(typeof ctx.tools.armBrush).toBe('function');
    expect(component.openDialogToolId).toBe('dianne');
    expect(component.toolDialog?.title).toBe('DIANNE');
    expect(component.toolDialog?.host.textContent).toBe('body');
  });

  it('mounts the body only once its host is in the document', () => {
    const { component, tool, attachHost } = opened({}, false);
    expect(tool.activate).toHaveBeenCalledTimes(1);
    expect(component.toolDialog).not.toBeNull(); // the dialog renders first
    expect(tool.mount).not.toHaveBeenCalled();
    runFrames(3); // still detached: keeps waiting
    expect(tool.mount).not.toHaveBeenCalled();

    attachHost();

    expect(tool.mount).toHaveBeenCalledTimes(1);
    expect(events).toContain('mount:connected');
  });

  it('mounts anyway, with a warning, if the host never attaches', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { tool } = opened({}, false);
    runFrames(61);
    expect(tool.mount).toHaveBeenCalledTimes(1);
    expect(events).toContain('mount:detached');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('never attached'));
  });

  it('closing before the host attaches never mounts, and ends the session once', () => {
    const { component, tool, sessions } = opened({}, false);
    component.closeDialogTool();
    runFrames(61);
    expect(tool.mount).not.toHaveBeenCalled();
    expect(sessions[0].deactivate).toHaveBeenCalledTimes(1);
  });

  it('a throwing mount() closes it with a warning and ends the session once', () => {
    const { component, sessions, messages } = opened({
      mount: jest.fn(() => { throw new Error('mount failed'); }),
    });
    expect(component.openDialogToolId).toBeNull();
    expect(component.toolDialog).toBeNull();
    expect(sessions[0].deactivate).toHaveBeenCalledTimes(1);
    expect(messages.add).toHaveBeenCalledWith(expect.objectContaining({ summary: 'DIANNE is unavailable' }));
  });

  it('a throwing teardown is logged and the session still ends', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { component, sessions } = opened({
      mount: jest.fn(() => () => { throw new Error('teardown failed'); }),
    });
    component.closeDialogTool();
    expect(sessions[0].deactivate).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('teardown threw'), expect.any(Error));
  });

  it('clicking again closes it: body torn down, then the session ends, once', () => {
    const { component, sessions } = opened();
    events = [];
    component.toggleDialogTool('dianne');
    expect(events).toEqual(['teardown', 'deactivate']);
    expect(sessions[0].deactivate).toHaveBeenCalledTimes(1);
    expect(component.openDialogToolId).toBeNull();
    expect(component.toolDialog).toBeNull();
  });

  it('closing the dialog (X) ends the session', () => {
    const { component, sessions } = opened();
    component.closeDialogTool();
    expect(sessions[0].deactivate).toHaveBeenCalledTimes(1);
    expect(component.toolDialog).toBeNull();
  });

  it('an image switch ends the session and starts a fresh one once the new view has plotted', async () => {
    const { component, imageInfo$, tool, sessions, finish, renderPhase, teardowns, attachHost } = opened();
    imageInfo$.next(infoFor('b.tif'));
    await renderPhase();
    expect(teardowns[0]).toHaveBeenCalledTimes(1);
    expect(sessions[0].deactivate).toHaveBeenCalledTimes(1);
    expect(component.openDialogToolId).toBe('dianne'); // still open
    finish();
    attachHost();
    expect(tool.activate).toHaveBeenCalledTimes(2);
    expect(tool.mount).toHaveBeenCalledTimes(2);
    expect(component.toolDialog).not.toBeNull();
  });

  it('leaving the Image view closes the dialog', () => {
    const { component, sessions } = opened();
    component.onSelectPlotType(PlotType.HEATMAP);
    expect(sessions[0].deactivate).toHaveBeenCalledTimes(1);
    expect(component.openDialogToolId).toBeNull();
  });

  it('a throwing activate() closes it with a warning, and the viewer keeps working', () => {
    const { component, messages } = opened({ activate: jest.fn(() => { throw new Error('boom'); }) });
    expect(component.openDialogToolId).toBeNull();
    expect(component.toolDialog).toBeNull();
    expect(messages.add).toHaveBeenCalledWith(expect.objectContaining({ summary: 'DIANNE is unavailable' }));
  });

  it('does not open over a backend with no viewport', () => {
    const d = dialogTool();
    const h = harness(undefined, null, [d.tool]);
    h.imageInfo$.next(infoFor('a.tif'));
    h.finish();
    h.component.toggleDialogTool('dianne');
    expect(d.tool.activate).not.toHaveBeenCalled();
    expect(h.component.openDialogToolId).toBeNull();
  });

  it('ends the session on destroy, once', () => {
    const { component, sessions } = opened();
    component.ngOnDestroy();
    expect(sessions[0].deactivate).toHaveBeenCalledTimes(1);
  });
});

describe('dialog tools — rendering', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.querySelectorAll('.p-dialog').forEach((el) => el.remove());
  });

  it('renders the body inside a titled, closable dialog, and removes it on close', async () => {
    const teardown = jest.fn();
    let connectedAtMount: boolean | null = null;
    const tool: ToolbarDialogToolContribution = {
      kind: 'dialog', id: 'dianne', label: 'DIANNE', icon: { pi: 'pi-pencil' }, tooltip: 't',
      dialog: { title: 'Digital Pathology - DIANNE' },
      activate: () => ({ deactivate: jest.fn() }),
      mount: (host) => {
        connectedAtMount = host.isConnected && !!host.closest('.tool-dialog');
        host.innerHTML = '<b class="dialog-body">hi</b>';
        return teardown;
      },
    };
    const plot = selfCompleting(plotBase(mockViewport()));
    const imageInfo$ = new BehaviorSubject<any>(null);
    const state = selfCompleting({
      getImageInfo$: () => imageInfo$,
      getCacheProgress$: () => new BehaviorSubject(null),
      getFilename$: () => new BehaviorSubject(undefined),
      getImageLoadingMessage$: () => new BehaviorSubject(''),
    });
    await TestBed.configureTestingModule({
      declarations: [VisualizerComponent],
      imports: [CommonModule, DialogModule, NoopAnimationsModule],
      providers: [
        { provide: IMAGE_STATE_PORT, useValue: state },
        { provide: VISUALIZER, useValue: plot },
        { provide: TOOLBAR_TOOLS, useValue: tool, multi: true },
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
    orchestratorHosts[orchestratorHosts.length - 1].finished(false);
    component.toggleDialogTool('dianne');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    // The body is mounted on an animation frame once the dialog has attached its host.
    for (let i = 0; i < 10 && connectedAtMount === null; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    }

    expect(connectedAtMount).toBe(true); // in the document, inside the dialog, at mount()
    const dialog = document.body.querySelector('.tool-dialog');
    expect(dialog?.textContent).toContain('Digital Pathology - DIANNE');
    expect(dialog?.querySelector('.tool-dialog-slot .dialog-body')?.textContent).toBe('hi');

    component.closeDialogTool();
    fixture.detectChanges();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('.dialog-body')).toBeNull();
    fixture.destroy();
  });
});
