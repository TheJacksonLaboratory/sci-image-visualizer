import { CommonModule } from '@angular/common';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { EMPTY, NEVER, Subject, of, throwError, BehaviorSubject } from 'rxjs';

import { RegionEditorComponent } from './region-editor.component';
import { RoutingVisualizerService } from '../routing-visualizer.service';
import { REGION_EDITOR_API } from '../contracts/region-editor-api.contract';
import type { RegionSourceView } from '../region-source/region-source';
import { MockService } from 'ng-mocks';
import { ConfirmationService, MessageService } from 'primeng/api';
import { Polygon, Rectangle, Region, MultiPolygon } from '../models/region';
import { ShapeSelection } from '../models/shape';
import { Component, NO_ERRORS_SCHEMA } from '@angular/core';
import { REGION_IO_PORT, RegionIoPort, ServerRegionPick } from '../contracts/ports/region-io.port';
import { importFile } from '../region-import/region-import';
import { PresetSet } from '../models/class-preset';
import { pickMpp } from './region-metrics';
import { IImageMetadata } from '../contracts/image.contract';

jest.mock('file-saver', () => ({ saveAs: jest.fn() }));
import { saveAs } from 'file-saver';

// The real factory uses `import.meta.url` (ESM-only), which ts-jest's CommonJS
// compile rejects — mock it; tests drive a FakeMaskWorker via createMaskWorker.
jest.mock('./mask-worker', () => ({ createMaskWorker: jest.fn() }));

/** Stand-in for the mask Web Worker — lets tests drive onmessage/onerror and
 *  assert postMessage/terminate without constructing a real worker URL. */
class FakeMaskWorker {
  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  postMessage = jest.fn();
  terminate = jest.fn();
  emit(data: any) {
    this.onmessage?.({ data });
  }
}

/** Seed a 512×512 rectangle row and commit it, as the toolbar's drawing would. */
function addRect(component: RegionEditorComponent): void {
  const region = new Region();
  region.bounds = Object.assign(new Rectangle(), { width: 512, height: 512 });
  region.label = 'Region';
  component['regions'] = [...component['regions'], region];
  (component as any).commit();
}

/** Seed a triangle row and commit it. */
function addPoly(component: RegionEditorComponent): void {
  const region = new Region();
  const p = new Polygon();
  p.xpoints = [0, 10, 5];
  p.ypoints = [0, 0, 10];
  p.coordinates = [
    [0, 0],
    [10, 0],
    [5, 10],
  ];
  p.npoints = 3;
  region.bounds = p;
  region.label = 'Region';
  component['regions'] = [...component['regions'], region];
  (component as any).commit();
}

/** Render the editor's own template only: its children and PrimeNG stay unknown elements. */
function shallowEditor(): void {
  TestBed.overrideComponent(RegionEditorComponent, {
    set: { imports: [CommonModule, FormsModule], schemas: [NO_ERRORS_SCHEMA] },
  });
}

describe('RegionEditorComponent', () => {
  let component: RegionEditorComponent;
  let fixture: ComponentFixture<RegionEditorComponent>;
  let mockVisualizer: RoutingVisualizerService;

  beforeEach(async () => {
    // Mirror the id-mint side effect of the real RoutingVisualizerService.setRegions —
    // the editor relies on it to give each region a stable identity for
    // selection/deletion comparisons.
    let testIdCounter = 1;
    mockVisualizer = MockService(RoutingVisualizerService, {
      getShowShapeLabel: () => false,
      getShapeColor: () => '#00FFFF',
      getFillColor: () => 'rgba(0,0,0,0)',
      getClassificationColors: () => new Map<string, string>(),
      getRegionUpdateEvent: () => EMPTY,
      getSelectedRegions$: () => EMPTY,
      getImageMeta: () => EMPTY,
      setSelectedRegions: jest.fn(),
      getAnnotationRegions: () => [],
      setAnnotationRegions: jest.fn((regions: Region[]) => {
        for (const r of regions ?? []) {
          if (r.id == null) r.id = testIdCounter++;
        }
      }),
      importRegions: jest.fn(),
      exportRegions: jest.fn(),
    });

    shallowEditor();
    await TestBed.configureTestingModule({
      imports: [RegionEditorComponent, FormsModule],
      providers: [
        { provide: REGION_EDITOR_API, useValue: mockVisualizer },
        { provide: MessageService, useValue: MockService(MessageService) },
        { provide: ConfirmationService, useValue: MockService(ConfirmationService) },
        {
          provide: REGION_IO_PORT,
          useValue: {
            getSelectedFileName: () => undefined,
            roiFileExists: () => of(false),
            saveGeoJson: () => of(void 0),
            saveSliceGeoJsons: () => of(void 0),
          } as RegionIoPort,
        },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(RegionEditorComponent);
    component = fixture.componentInstance;
    component.ngOnInit();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should initialize with empty regions when no shapes provided', () => {
    expect(component['regions'].length).toBe(0);
  });

  it('should delete a region by index', () => {
    addRect(component);
    addRect(component);
    const secondBounds = component['regions'][1].bounds;
    expect(component['regions'].length).toBe(2);
    component['deleteRegion'](0);
    expect(component['regions'].length).toBe(1);
    // The surviving region is the one that was at index 1.
    expect(component['regions'][0].bounds).toBe(secondBounds);
  });

  it('should delete selected regions', () => {
    addRect(component);
    addPoly(component);
    component['selectedRegions'] = [component['regions'][0]];
    component['deleteSelectedRegions']();
    expect(component['regions'].length).toBe(1);
    expect(component['regions'][0].bounds).toBeInstanceOf(Polygon);
    expect(component['selectedRegions'].length).toBe(0);
  });

  it('should not delete when no regions are selected', () => {
    addRect(component);
    component['selectedRegions'] = [];
    component['deleteSelectedRegions']();
    expect(component['regions'].length).toBe(1);
  });

  it('should round rectangle lengths to multiples of 512', () => {
    addRect(component);
    const rect = component['regions'][0].bounds as Rectangle;
    rect.width = 1000;
    rect.height = 600;
    component['roundRectangleLengths']();
    // Committed as a replacement (copy-on-write, RT-1): read the row back.
    const rounded = component['regions'][0].bounds as Rectangle;
    expect(rounded.width).toBe(1024);
    expect(rounded.height).toBe(512);
  });

  it('should round small rectangle lengths to 0', () => {
    addRect(component);
    const rect = component['regions'][0].bounds as Rectangle;
    rect.width = 100;
    rect.height = 200;
    component['roundRectangleLengths']();
    const rounded = component['regions'][0].bounds as Rectangle;
    expect(rounded.width).toBe(0);
    expect(rounded.height).toBe(0);
  });

  it('live-edit: every region change immediately calls plotService.setRegions with isRegionSaveOn=true', () => {
    const setRegionsSpy = mockVisualizer.setAnnotationRegions as jest.Mock;
    setRegionsSpy.mockClear();
    addRect(component);
    expect(setRegionsSpy).toHaveBeenCalled();
    const lastCall = setRegionsSpy.mock.calls[setRegionsSpy.mock.calls.length - 1];
    // Signature: setRegions(regions, showLabel, isRegionSaveOn, fillColor, append?)
    expect(lastCall[2]).toBe(true);
  });

  it('table → plot: onSelectionChanged pushes the selected regions to the contract', () => {
    addRect(component);
    addRect(component);
    addRect(component);
    const spy = mockVisualizer.setSelectedRegions as jest.Mock;
    spy.mockClear();
    component['selectedRegions'] = [component['regions'][0], component['regions'][2]];
    component['onSelectionChanged']();
    expect(spy).toHaveBeenCalledWith([component['regions'][0], component['regions'][2]]);
  });

  it('table → plot: clearing the selection emits an empty index array', () => {
    addRect(component);
    const spy = mockVisualizer.setSelectedRegions as jest.Mock;
    spy.mockClear();
    component['selectedRegions'] = [];
    component['onSelectionChanged']();
    expect(spy).toHaveBeenCalledWith([]);
  });

  it('deleteSelectedRegions removes every selected region and clears the plot selection', () => {
    addRect(component);
    addRect(component);
    addRect(component);
    component['selectedRegions'] = [component['regions'][0], component['regions'][2]];
    const setSelSpy = mockVisualizer.setSelectedRegions as jest.Mock;
    setSelSpy.mockClear();
    component['deleteSelectedRegions']();
    expect(component['regions'].length).toBe(1);
    expect(component['selectedRegions'].length).toBe(0);
    // Last call to setSelectedShapeIndices clears the plot's highlight.
    expect(setSelSpy.mock.calls[setSelSpy.mock.calls.length - 1][0]).toEqual([]);
  });

  it('deleteRegion drops the deleted region from selectedRegions and re-syncs', () => {
    addRect(component);
    addRect(component);
    addRect(component);
    component['selectedRegions'] = [component['regions'][0], component['regions'][2]];
    const setSelSpy = mockVisualizer.setSelectedRegions as jest.Mock;
    setSelSpy.mockClear();
    // Delete index 0 — also removes it from selectedRegions.
    component['deleteRegion'](0);
    expect(component['regions'].length).toBe(2);
    expect(component['selectedRegions'].length).toBe(1);
    // The remaining selected region (formerly at index 2) is now at index 1.
    const lastCall = setSelSpy.mock.calls[setSelSpy.mock.calls.length - 1][0];
    expect(lastCall).toEqual([component['regions'][1]]);
  });

  it('should update label colors when label is edited', () => {
    addRect(component);
    component['regions'][0].label = 'tissue';
    component['labelRegionUpdate'](component['regions'][0]);
    // A colourless row takes its class colour (preset or fallback).
    expect(component['regions'][0].color).toBe(component['colorForName']('tissue'));
  });

  it('save/export propose <name>.geojson for an extension-less file name (RT-19)', () => {
    const io = (component as any).persistence.io as RegionIoPort;
    io.getSelectedFileName = () => 'image';
    component['regions'] = [Object.assign(new Region(), { id: 1, bounds: new Rectangle() })];
    component['persistRegions']();
    expect(component['saveAsFilename']).toBe('image.geojson');
    component['exportRois']();
    expect(component['exportFilename']).toBe('image.geojson');
    io.getSelectedFileName = () => 'slide.ome.tif';
    component['persistRegions']();
    expect(component['saveAsFilename']).toBe('slide.ome.geojson');
  });

  it('pagedRegions hands the table a stable array until regions or the page change (RT-20)', () => {
    for (let i = 0; i < 12; i++) addRect(component);
    const page = component['pagedRegions'];
    expect(page).toHaveLength(10);
    expect(component['pagedRegions']).toBe(page); // no new array per change-detection pass
    component['onPageChange']({ first: 10, rows: 10 });
    expect(component['pagedRegions']).toHaveLength(2);
    expect(component['pagedRegions']).not.toBe(page);
  });

  it('rejects an imported preset file that is not a preset set, with an error toast (RT-32)', () => {
    const api = mockVisualizer as unknown as { setPresetSet: jest.Mock };
    api.setPresetSet = jest.fn();
    const add = jest.spyOn(component['messageService'], 'add');
    (component as any).applyImportedPresets('{"classes": "nope"}');
    expect(api.setPresetSet).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error', key: expect.any(String) }));
  });

  it('a failed region import shows its error toast in the library outlet (RT-32)', async () => {
    (mockVisualizer.importRegions as jest.Mock).mockImplementation(() => {
      throw new Error('bad geojson');
    });
    const add = jest.spyOn(component['messageService'], 'add');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await (component as any).applyImportedRois('garbage');
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error', key: expect.any(String) }));
  });

  it("replaces the slice's region source with a small imported file's regions", async () => {
    const api = mockVisualizer as unknown as { importRegionSource: jest.Mock; dropRegionSource: jest.Mock };
    const order: string[] = [];
    api.importRegionSource = jest.fn().mockResolvedValue(false);
    api.dropRegionSource = jest.fn(async () => {
      order.push('drop');
    });
    (mockVisualizer.importRegions as jest.Mock).mockReturnValue([]);
    (mockVisualizer.setAnnotationRegions as jest.Mock).mockImplementation(() => order.push('commit'));
    await (component as any).applyImportedRois('{"type":"FeatureCollection","features":[]}');
    expect(order).toEqual(['drop', 'commit']);

    // A file that does not parse leaves the source alone.
    api.dropRegionSource.mockClear();
    (mockVisualizer.importRegions as jest.Mock).mockImplementation(() => {
      throw new Error('bad geojson');
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await (component as any).applyImportedRois('garbage');
    expect(api.dropRegionSource).not.toHaveBeenCalled();
  });

  it('stops the save-as exists check on destroy (RT-32)', fakeAsync(() => {
    const io = (component as any).persistence.io as RegionIoPort;
    const exists = jest.fn(() => of(true));
    io.roiFileExists = exists;
    fixture.destroy();
    component['saveAsFilename'] = 'a.geojson';
    component['checkSaveAsFileExists']();
    tick(500);
    expect(exists).not.toHaveBeenCalled();
  }));

  it('should show help dialog', () => {
    expect(component['displayHelpDialog']).toBe(false);
    component['showHelp']();
    expect(component['displayHelpDialog']).toBe(true);
  });
});

describe('RegionEditorComponent with shapes', () => {
  let component: RegionEditorComponent;
  let fixture: ComponentFixture<RegionEditorComponent>;

  const mockShapes = [
    {
      name: 'shape0',
      type: 'rect',
      x0: 100,
      y0: 200,
      x1: 612,
      y1: 714,
      line: { color: '#FF0000' },
      legend: 'tumor',
    },
    {
      name: 'shape1',
      type: 'path',
      path: 'M10,20L30,40L50,60Z',
      line: { color: '#00FF00' },
      legend: 'normal',
    },
    {
      name: 'shape2',
      type: 'rect',
      x0: 0,
      y0: 0,
      x1: 512,
      y1: 512,
      line: {},
      legend: undefined,
    },
  ];

  describe('Class cell editing', () => {
    let region: Region;

    beforeEach(() => {
      region = new Region();
      region.name = 'shape0';
      region.label = 'legend';
      region.bounds = new Rectangle();
      component['regions'] = [region];
    });

    it('isEditingLabel returns false by default', () => {
      expect(component['isEditingLabel'](region)).toBe(false);
    });

    it('startEditLabel adds the region to the editing set and stops event propagation', () => {
      const event = { stopPropagation: jest.fn() } as unknown as Event;
      component['startEditLabel'](region, event);

      expect(component['isEditingLabel'](region)).toBe(true);
      expect(component['editingLabelRegions'].has(region)).toBe(true);
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('startEditLabel works without an event argument', () => {
      expect(() => component['startEditLabel'](region)).not.toThrow();
      expect(component['isEditingLabel'](region)).toBe(true);
    });

    it('startEditLabel can track multiple regions independently', () => {
      const r2 = new Region();
      r2.name = 'shape1';
      r2.label = 'other';
      component['regions'] = [region, r2];

      component['startEditLabel'](region);
      component['startEditLabel'](r2);

      expect(component['isEditingLabel'](region)).toBe(true);
      expect(component['isEditingLabel'](r2)).toBe(true);
      expect(component['editingLabelRegions'].size).toBe(2);
    });

    it('stopEditLabel(commit=false) removes the region without calling labelRegionUpdate', () => {
      const event = { stopPropagation: jest.fn() } as unknown as Event;
      component['startEditLabel'](region);
      const spy = jest.spyOn(component as unknown as { labelRegionUpdate(): void }, 'labelRegionUpdate');

      component['stopEditLabel'](region, false, event);

      expect(component['isEditingLabel'](region)).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('stopEditLabel(commit=true) removes the region and commits the edit', () => {
      component['startEditLabel'](region);
      const spy = jest.spyOn(component as unknown as { labelRegionUpdate(): void }, 'labelRegionUpdate');

      component['stopEditLabel'](region, true);

      expect(component['isEditingLabel'](region)).toBe(false);
      expect(spy).toHaveBeenCalledWith(region, true);
    });

    it('stopEditLabel is a no-op (for the set) if the region is not in edit mode', () => {
      expect(component['isEditingLabel'](region)).toBe(false);
      expect(() => component['stopEditLabel'](region, false)).not.toThrow();
      expect(component['editingLabelRegions'].size).toBe(0);
    });
  });

  beforeEach(async () => {
    const mockVisualizer = MockService(RoutingVisualizerService, {
      getShowShapeLabel: () => true,
      getShapeColor: () => '#00FFFF',
      getFillColor: () => 'rgba(0,0,0,0)',
      getClassificationColors: () => new Map<string, string>(),
      getRegionUpdateEvent: () => EMPTY,
      getSelectedRegions$: () => EMPTY,
      getImageMeta: () => EMPTY,
      setSelectedRegions: jest.fn(),
      getAnnotationRegions: () => mockShapes.map((s) => Object.assign(new ShapeSelection(), s as any).getRegion()),
      setAnnotationRegions: jest.fn(),
    });

    shallowEditor();
    await TestBed.configureTestingModule({
      imports: [RegionEditorComponent, FormsModule],
      providers: [
        { provide: REGION_EDITOR_API, useValue: mockVisualizer },
        { provide: MessageService, useValue: MockService(MessageService) },
        { provide: ConfirmationService, useValue: MockService(ConfirmationService) },
        {
          provide: REGION_IO_PORT,
          useValue: {
            getSelectedFileName: () => undefined,
            roiFileExists: () => of(false),
            saveGeoJson: () => of(void 0),
            saveSliceGeoJsons: () => of(void 0),
          } as RegionIoPort,
        },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(RegionEditorComponent);
    component = fixture.componentInstance;
    component.ngOnInit();
  });

  it('should initialize regions from rect shapes', () => {
    expect(component['regions'].length).toBe(3);
    const rect = component['regions'][0].bounds as Rectangle;
    expect(rect.x).toBe(100);
    expect(rect.y).toBe(200);
    expect(rect.width).toBe(512);
    expect(rect.height).toBe(514);
  });

  it('should initialize regions from path shapes', () => {
    const poly = component['regions'][1].bounds as Polygon;
    expect(poly.coordinates.length).toBe(3);
    expect(poly.coordinates[0]).toEqual([10, 20]);
    expect(poly.xpoints).toEqual([10, 30, 50]);
    expect(poly.ypoints).toEqual([20, 40, 60]);
    expect(poly.closed).toBe(true);
  });

  it('should set region color from shape line color', () => {
    expect(component['regions'][0].color).toBe('#FF0000');
    expect(component['regions'][1].color).toBe('#00FF00');
  });

  it('should fall back to shapeColor when line color is missing', () => {
    expect(component['regions'][2].color).toBe('#00FFFF');
  });

  it('should set region labels from shape legend', () => {
    expect(component['regions'][0].label).toBe('tumor');
    expect(component['regions'][1].label).toBe('normal');
  });

  it("keeps each labelled region's own colour (class colours are derived, not cached)", () => {
    expect(component['regions'].map((r) => [r.label, r.color]).slice(0, 2)).toEqual([
      ['tumor', '#FF0000'],
      ['normal', '#00FF00'],
    ]);
  });
});

describe('SelectionDialogComponent with open path shape', () => {
  let component: RegionEditorComponent;
  let fixture: ComponentFixture<RegionEditorComponent>;

  const openPathShapes = [
    {
      name: 'shape0',
      type: 'path',
      path: 'M10,20L30,40L50,60',
      line: { color: '#FF0000' },
      legend: 'annotation',
    },
  ];

  beforeEach(async () => {
    const mockVisualizer = MockService(RoutingVisualizerService, {
      getShowShapeLabel: () => false,
      getShapeColor: () => '#00FFFF',
      getFillColor: () => 'rgba(0,0,0,0)',
      getClassificationColors: () => new Map<string, string>(),
      getRegionUpdateEvent: () => EMPTY,
      getSelectedRegions$: () => EMPTY,
      getImageMeta: () => EMPTY,
      setSelectedRegions: jest.fn(),
      getAnnotationRegions: () =>
        openPathShapes.map((s) => Object.assign(new ShapeSelection(), s as any).getRegion()),
      setAnnotationRegions: jest.fn(),
    });

    shallowEditor();
    await TestBed.configureTestingModule({
      imports: [RegionEditorComponent, FormsModule],
      providers: [
        { provide: REGION_EDITOR_API, useValue: mockVisualizer },
        { provide: MessageService, useValue: MockService(MessageService) },
        { provide: ConfirmationService, useValue: MockService(ConfirmationService) },
        {
          provide: REGION_IO_PORT,
          useValue: {
            getSelectedFileName: () => undefined,
            roiFileExists: () => of(false),
            saveGeoJson: () => of(void 0),
            saveSliceGeoJsons: () => of(void 0),
          } as RegionIoPort,
        },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(RegionEditorComponent);
    component = fixture.componentInstance;
    component.ngOnInit();
  });

  it('should initialize open polyline with closed=false', () => {
    expect(component['regions'].length).toBe(1);
    const poly = component['regions'][0].bounds as Polygon;
    expect(poly).toBeInstanceOf(Polygon);
    expect(poly.closed).toBe(false);
    expect(poly.npoints).toBe(3);
    expect(poly.xpoints).toEqual([10, 30, 50]);
    expect(poly.ypoints).toEqual([20, 40, 60]);
  });
});

describe('RegionEditorComponent persist / save-as', () => {
  let component: RegionEditorComponent;
  let fixture: ComponentFixture<RegionEditorComponent>;
  let mockRegionIo: RegionIoPort;
  let mockVisualizer: RoutingVisualizerService;
  let mockMessageService: MessageService;
  let mockConfirmationService: ConfirmationService;

  const fakeProject = { id: 1, name: 'test-project' };

  const fakeSelectedFile = {
    project: fakeProject,
    name: 'slide_001.tif',
    type: 'image',
    relPath: 'images/slide_001.tif',
  };

  beforeEach(async () => {
    mockVisualizer = MockService(RoutingVisualizerService, {
      getShowShapeLabel: () => false,
      getShapeColor: () => '#00FFFF',
      getFillColor: () => 'rgba(0,0,0,0)',
      getClassificationColors: () => new Map<string, string>(),
      getRegionUpdateEvent: () => EMPTY,
      getSelectedRegions$: () => EMPTY,
      getImageMeta: () => EMPTY,
      setSelectedRegions: jest.fn(),
      getAnnotationRegions: () => [],
      setAnnotationRegions: jest.fn(),
      getGeoJsonString: jest.fn(() => '{"type":"FeatureCollection","features":[]}'),
      getMaskImageSize: jest.fn(() => ({ width: 8, height: 8 })),
    });

    mockRegionIo = {
      getSelectedFileName: jest.fn(() => fakeSelectedFile.name),
      roiFileExists: jest.fn(() => of(false)),
      saveGeoJson: jest.fn(() => of(void 0)),
      saveSliceGeoJsons: jest.fn(() => of(void 0)),
    } as unknown as RegionIoPort;

    mockMessageService = MockService(MessageService, {
      add: jest.fn(),
    });

    mockConfirmationService = MockService(ConfirmationService, {
      confirm: jest.fn(),
    });

    shallowEditor();
    await TestBed.configureTestingModule({
      imports: [RegionEditorComponent, FormsModule],
      providers: [
        { provide: REGION_EDITOR_API, useValue: mockVisualizer },
        { provide: MessageService, useValue: mockMessageService },
        { provide: ConfirmationService, useValue: mockConfirmationService },
        { provide: REGION_IO_PORT, useValue: mockRegionIo },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(RegionEditorComponent);
    component = fixture.componentInstance;
    component.ngOnInit();

    addRect(component);
  });

  // --- persistRegions (opens the save-as dialog) ---

  it('should open save-as dialog with default geojson filename', () => {
    component['persistRegions']();

    expect(component['showSaveAsDialog']).toBe(true);
    expect(component['saveAsFilename']).toBe('slide_001.geojson');
    expect(component['saveAsFileExists']).toBe(false);
  });

  it('should not open save-as dialog when no file is selected', () => {
    (mockRegionIo.getSelectedFileName as jest.Mock).mockReturnValue(undefined);

    component['persistRegions']();

    expect(component['showSaveAsDialog']).toBe(false);
  });

  it('should not open save-as dialog when there are no regions', () => {
    component['regions'] = [];

    component['persistRegions']();

    expect(component['showSaveAsDialog']).toBe(false);
  });

  // --- save mask (rasterize regions → PNG, jit-ui#95) ---

  it('opens the save-mask dialog with a basename_mask.png default and binary mode', () => {
    component['openSaveMaskDialog']();

    expect(component['showSaveMaskDialog']).toBe(true);
    expect(component['saveMaskFilename']).toBe('slide_001_mask.png');
    expect(component['maskMode']).toBe('binary');
  });

  it('keeps the whole name as the mask stem when the filename has no extension — jit-ui#100', () => {
    (mockRegionIo.getSelectedFileName as jest.Mock).mockReturnValue('slide001');

    component['openSaveMaskDialog']();

    expect(component['saveMaskFilename']).toBe('slide001_mask.png'); // not "_mask.png"
  });

  it('does not open the save-mask dialog when there are no regions', () => {
    component['regions'] = [];

    component['openSaveMaskDialog']();

    expect(component['showSaveMaskDialog']).toBe(false);
  });

  // createMaskWorker() is async (dynamic import), so the worker is wired up on a
  // microtask — flush before asserting postMessage/onmessage-driven behavior.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('confirmSaveMask runs the worker off-thread with the chosen mode, then downloads on completion', async () => {
    (saveAs as unknown as jest.Mock).mockClear();
    const worker = new FakeMaskWorker();
    (component as any).maskExport.createWorker = () => Promise.resolve(worker);

    component['openSaveMaskDialog']();
    component['maskMode'] = 'multiclass';
    component['confirmSaveMask']();
    expect(component['maskBusy']).toBe(true); // busy set synchronously

    await flush(); // worker resolves + wires up

    // Worker started with the image size + serialized regions; UI shows progress.
    expect(mockVisualizer.getMaskImageSize).toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ width: 8, height: 8, mode: 'multiclass' }),
    );
    expect(saveAs).not.toHaveBeenCalled(); // nothing downloaded yet — non-blocking

    // Progress + completion messages drive the UI and the download.
    worker.emit({ type: 'progress', done: 1, total: 2 });
    expect(component['maskProgress']).toBe(50);
    worker.emit({ type: 'done', png: new Uint8Array([1, 2, 3]) });

    expect(component['maskBusy']).toBe(false);
    expect(component['showSaveMaskDialog']).toBe(false);
    expect(worker.terminate).toHaveBeenCalled();
    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob), 'slide_001_mask.png');
  });

  it('cancelSaveMask before the worker resolves terminates it and clears the busy state', async () => {
    const worker = new FakeMaskWorker();
    (component as any).maskExport.createWorker = () => Promise.resolve(worker);
    component['openSaveMaskDialog']();
    component['confirmSaveMask']();
    expect(component['maskBusy']).toBe(true);

    component['cancelSaveMask']();
    expect(component['maskBusy']).toBe(false);

    await flush(); // worker resolves into a cancelled state → terminated, not wired
    expect(worker.terminate).toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('confirmSaveMask shows an error and does not start the worker when no image size is known', () => {
    (saveAs as unknown as jest.Mock).mockClear();
    (mockVisualizer.getMaskImageSize as jest.Mock).mockReturnValueOnce(null);
    const worker = new FakeMaskWorker();
    (component as any).maskExport.createWorker = () => Promise.resolve(worker);
    component['openSaveMaskDialog']();

    component['confirmSaveMask']();

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(component['maskBusy']).toBe(false);
    expect(mockMessageService.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', summary: 'Could not create mask' }),
    );
    expect(saveAs).not.toHaveBeenCalled();
  });

  it('confirmSaveMask surfaces a worker error as a toast', async () => {
    const worker = new FakeMaskWorker();
    (component as any).maskExport.createWorker = () => Promise.resolve(worker);
    component['openSaveMaskDialog']();
    component['confirmSaveMask']();
    await flush();

    worker.emit({ type: 'error', error: 'boom' });

    expect(component['maskBusy']).toBe(false);
    expect(worker.terminate).toHaveBeenCalled();
    expect(mockMessageService.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', summary: 'Could not create mask', detail: 'boom' }),
    );
  });

  // --- checkSaveAsFileExists (debounced existence check) ---

  it('should update saveAsFileExists to true when file exists', fakeAsync(() => {
    (mockRegionIo.roiFileExists as jest.Mock).mockReturnValue(of(true));

    component['saveAsFilename'] = 'slide_001.geojson';
    component['checkSaveAsFileExists']();
    tick(500);

    expect(mockRegionIo.roiFileExists).toHaveBeenCalledWith('slide_001.geojson');
    expect(component['saveAsFileExists']).toBe(true);
  }));

  it('should update saveAsFileExists to false when file does not exist', fakeAsync(() => {
    (mockRegionIo.roiFileExists as jest.Mock).mockReturnValue(of(false));

    component['saveAsFilename'] = 'new_name.geojson';
    component['checkSaveAsFileExists']();
    tick(500);

    expect(component['saveAsFileExists']).toBe(false);
  }));

  it('should debounce rapid existence checks', fakeAsync(() => {
    (mockRegionIo.roiFileExists as jest.Mock).mockReturnValue(of(false));

    component['saveAsFilename'] = 'a.geojson';
    component['checkSaveAsFileExists']();
    tick(100);
    component['saveAsFilename'] = 'b.geojson';
    component['checkSaveAsFileExists']();
    tick(100);
    component['saveAsFilename'] = 'c.geojson';
    component['checkSaveAsFileExists']();
    tick(500);

    expect(mockRegionIo.roiFileExists).toHaveBeenCalledTimes(1);
    expect(mockRegionIo.roiFileExists).toHaveBeenCalledWith('c.geojson');
  }));

  it('should set saveAsFileExists to false on roiFileExist error', fakeAsync(() => {
    (mockRegionIo.roiFileExists as jest.Mock).mockReturnValue(throwError(() => new Error('network')));

    component['saveAsFileExists'] = true;
    component['saveAsFilename'] = 'slide_001.geojson';
    component['checkSaveAsFileExists']();
    tick(500);

    expect(component['saveAsFileExists']).toBe(false);
  }));

  it('keeps checking after a failed existence check', fakeAsync(() => {
    (mockRegionIo.roiFileExists as jest.Mock).mockReturnValueOnce(throwError(() => new Error('network')));
    component['saveAsFilename'] = 'a.geojson';
    component['checkSaveAsFileExists']();
    tick(500);
    (mockRegionIo.roiFileExists as jest.Mock).mockReturnValue(of(true));
    component['saveAsFilename'] = 'b.geojson';
    component['checkSaveAsFileExists']();
    tick(500);
    expect(component['saveAsFileExists']).toBe(true);
  }));

  // --- confirmSaveAs (save action) ---

  it('should save directly when file does not exist', fakeAsync(() => {
    component['saveAsFilename'] = 'new_regions.geojson';
    component['saveAsFileExists'] = false;
    component['showSaveAsDialog'] = true;

    component['confirmSaveAs']();
    tick(); // flush the deferred serialize + upload

    expect(component['showSaveAsDialog']).toBe(false);
    expect(component['saveAsBusy']).toBe(false);
    expect(mockRegionIo.saveGeoJson).toHaveBeenCalledWith(
      '{"type":"FeatureCollection","features":[]}',
      'new_regions.geojson',
    );
    expect(mockMessageService.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'success', detail: 'Saved as new_regions.geojson' }),
    );
  }));

  it('should show overwrite confirmation when file exists', () => {
    component['saveAsFilename'] = 'existing.geojson';
    component['saveAsFileExists'] = true;
    component['showSaveAsDialog'] = true;

    component['confirmSaveAs']();

    // The Save-As dialog stays open (behind the confirm dialog) until the user decides.
    expect(component['showSaveAsDialog']).toBe(true);
    expect(mockConfirmationService.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '"existing.geojson" already exists. Do you want to overwrite it?',
        header: 'Confirm Overwrite',
      }),
    );
    expect(mockRegionIo.saveGeoJson).not.toHaveBeenCalled();
  });

  it('should save after user accepts overwrite confirmation', fakeAsync(() => {
    component['saveAsFilename'] = 'existing.geojson';
    component['saveAsFileExists'] = true;

    component['confirmSaveAs']();
    const confirmCall = (mockConfirmationService.confirm as jest.Mock).mock.calls[0][0];
    confirmCall.accept();
    tick();

    expect(mockRegionIo.saveGeoJson).toHaveBeenCalledWith(
      '{"type":"FeatureCollection","features":[]}',
      'existing.geojson',
    );
    expect(mockMessageService.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'success' }));
  }));

  it('saves EVERY slice as one combined z-indexed geojson for a single-file z-stack — jit-ui#93', fakeAsync(() => {
    // Stack mode with the combined layout: the current slice may hold only some
    // regions, but save must serialize the whole stack (getSliceAnnotationRegions).
    const allSlices = [{}, {}, {}] as any[]; // 3 regions across slices
    mockVisualizer.isStackMode = jest.fn(() => true);
    mockVisualizer.getStackSaveLayout = jest.fn(() => 'combined');
    mockVisualizer.getSliceAnnotationRegions = jest.fn(() => allSlices);
    (mockVisualizer.getGeoJsonString as jest.Mock).mockImplementation((regs: any[]) =>
      JSON.stringify({ count: regs.length }),
    );

    component['saveAsFilename'] = 'stack.geojson';
    component['saveAsFileExists'] = false;

    component['confirmSaveAs']();
    tick();

    expect(mockVisualizer.getSliceAnnotationRegions).toHaveBeenCalled();
    expect(mockVisualizer.getGeoJsonString).toHaveBeenCalledWith(allSlices);
    expect(mockRegionIo.saveGeoJson).toHaveBeenCalledWith(JSON.stringify({ count: 3 }), 'stack.geojson');
  }));

  it('saves one geojson per slice-file for a folder stack (per-slice-file layout) — jit-ui#93', async () => {
    // Folder stack: persistRegions should skip the single-file save-as dialog
    // and write each slice's regions back to its own slice-file's geojson.
    const s0 = new Region();
    s0.bounds = Object.assign(new Rectangle(), { x: 0, y: 0, width: 4, height: 4 });
    const s2 = new Region();
    s2.bounds = Object.assign(new Rectangle(), { x: 2, y: 2, width: 4, height: 4 });
    const bySlice = new Map<number, Region[]>([
      [0, [s0]],
      [2, [s2]],
    ]);

    mockVisualizer.isStackMode = jest.fn(() => true);
    mockVisualizer.getStackSaveLayout = jest.fn(() => 'per-slice-file');
    mockVisualizer.getStackSaveAnnotationSlices = jest.fn(() => bySlice);
    (mockVisualizer.getGeoJsonString as jest.Mock).mockImplementation((regs: any[]) =>
      JSON.stringify({ n: regs.length, z: regs[0]?.z }),
    );

    component['persistRegions']();
    await new Promise((r) => setTimeout(r)); // the slices serialize first

    // No single-file dialog for a folder stack.
    expect(component['showSaveAsDialog']).toBe(false);
    // One saveSliceGeoJsons call carrying both slices; each serialized on the
    // default plane (z reset to 0 — the file itself is the slice).
    expect(mockRegionIo.saveSliceGeoJsons).toHaveBeenCalledTimes(1);
    const arg = (mockRegionIo.saveSliceGeoJsons as jest.Mock).mock.calls[0][0];
    expect(arg.map((s: any) => s.z).sort()).toEqual([0, 2]);
    expect(arg.every((s: any) => JSON.parse(s.geoJsonStr).z === 0)).toBe(true);
    expect(mockRegionIo.saveGeoJson).not.toHaveBeenCalled();
  });

  it("ignores a folder stack's Save while its save is still uploading, and destroy cancels that one", async () => {
    // The toolbar Save stays enabled during a stack save (there is no dialog);
    // a second click must not start a duplicate write and orphan the first.
    const s0 = new Region();
    s0.bounds = Object.assign(new Rectangle(), { x: 0, y: 0, width: 4, height: 4 });
    mockVisualizer.isStackMode = jest.fn(() => true);
    mockVisualizer.getStackSaveLayout = jest.fn(() => 'per-slice-file');
    mockVisualizer.getStackSaveAnnotationSlices = jest.fn(() => new Map([[0, [s0]]]));
    const upload = new Subject<void>();
    (mockRegionIo.saveSliceGeoJsons as jest.Mock).mockReturnValue(upload);

    component['persistRegions']();
    component['persistRegions']();
    await new Promise((r) => setTimeout(r)); // the slices serialize first

    expect(mockRegionIo.saveSliceGeoJsons).toHaveBeenCalledTimes(1);
    expect(upload.observed).toBe(true);
    component.ngOnDestroy();
    expect(upload.observed).toBe(false);
  });

  it('should show error toast when save fails', fakeAsync(() => {
    (mockRegionIo.saveGeoJson as jest.Mock).mockReturnValue(throwError(() => new Error('Server error')));
    component['saveAsFilename'] = 'regions.geojson';
    component['saveAsFileExists'] = false;

    component['confirmSaveAs']();
    tick();

    expect(component['saveAsBusy']).toBe(false);
    expect(mockMessageService.add).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        summary: 'Error saving regions',
        detail: 'Server error',
      }),
    );
  }));

  it('cancelSaveAs aborts an in-flight upload and clears the busy state', fakeAsync(() => {
    (mockRegionIo.saveGeoJson as jest.Mock).mockReturnValue(NEVER); // never completes
    component['saveAsFilename'] = 'regions.geojson';
    component['saveAsFileExists'] = false;

    component['confirmSaveAs']();
    tick();
    expect(component['saveAsBusy']).toBe(true);

    component['cancelSaveAs']();
    expect(component['saveAsBusy']).toBe(false);
  }));

  it('cancelSaveAs before the deferred timer fires aborts the save entirely — jit-ui#100', fakeAsync(() => {
    component['saveAsFilename'] = 'regions.geojson';
    component['saveAsFileExists'] = false;

    component['confirmSaveAs']();
    // Cancel BEFORE the setTimeout callback runs.
    component['cancelSaveAs']();
    tick();

    expect(mockRegionIo.saveGeoJson).not.toHaveBeenCalled();
    expect(component['saveAsBusy']).toBe(false);
  }));

  it('ngOnDestroy clears a pending save timer so it never uploads after teardown — jit-ui#100', fakeAsync(() => {
    component['saveAsFilename'] = 'regions.geojson';
    component['saveAsFileExists'] = false;

    component['confirmSaveAs']();
    component.ngOnDestroy();
    tick();

    expect(mockRegionIo.saveGeoJson).not.toHaveBeenCalled();
  }));

  it('should not save when filename is empty', () => {
    component['saveAsFilename'] = '   ';
    component['confirmSaveAs']();

    expect(mockRegionIo.saveGeoJson).not.toHaveBeenCalled();
    expect(mockConfirmationService.confirm).not.toHaveBeenCalled();
  });

  it('should not save when no file is selected', () => {
    (mockRegionIo.getSelectedFileName as jest.Mock).mockReturnValue(undefined);
    component['saveAsFilename'] = 'test.geojson';

    component['confirmSaveAs']();

    expect(mockRegionIo.saveGeoJson).not.toHaveBeenCalled();
  });

  it('should pass custom filename to saveGeoJson', fakeAsync(() => {
    component['saveAsFilename'] = 'my_custom_name.geojson';
    component['saveAsFileExists'] = false;

    component['confirmSaveAs']();
    tick();

    expect(mockRegionIo.saveGeoJson).toHaveBeenCalledWith(expect.any(String), 'my_custom_name.geojson');
  }));

  it('should trigger initial existence check when dialog opens', fakeAsync(() => {
    (mockRegionIo.roiFileExists as jest.Mock).mockReturnValue(of(true));

    component['persistRegions']();
    tick(500);

    expect(mockRegionIo.roiFileExists).toHaveBeenCalledWith('slide_001.geojson');
    expect(component['saveAsFileExists']).toBe(true);
  }));
});

describe('RegionEditorComponent export', () => {
  let component: RegionEditorComponent;
  let fixture: ComponentFixture<RegionEditorComponent>;
  let mockRegionIo: RegionIoPort;
  let mockVisualizer: RoutingVisualizerService;

  const fakeProject = { id: 1, name: 'test-project' };

  const fakeSelectedFile = {
    project: fakeProject,
    name: 'slide_001.tif',
    type: 'image',
    relPath: 'images/slide_001.tif',
  };

  beforeEach(async () => {
    (saveAs as unknown as jest.Mock).mockClear();

    mockVisualizer = MockService(RoutingVisualizerService, {
      getShowShapeLabel: () => false,
      getShapeColor: () => '#00FFFF',
      getFillColor: () => 'rgba(0,0,0,0)',
      getClassificationColors: () => new Map<string, string>(),
      getRegionUpdateEvent: () => EMPTY,
      getSelectedRegions$: () => EMPTY,
      getImageMeta: () => EMPTY,
      setSelectedRegions: jest.fn(),
      getAnnotationRegions: () => [],
      setAnnotationRegions: jest.fn(),
      getGeoJsonString: jest.fn(() => '{"type":"FeatureCollection","features":[]}'),
      getMaskImageSize: jest.fn(() => ({ width: 8, height: 8 })),
    });

    mockRegionIo = {
      getSelectedFileName: jest.fn(() => fakeSelectedFile.name),
      roiFileExists: jest.fn(() => of(false)),
      saveGeoJson: jest.fn(() => of(void 0)),
      saveSliceGeoJsons: jest.fn(() => of(void 0)),
    } as unknown as RegionIoPort;

    shallowEditor();
    await TestBed.configureTestingModule({
      imports: [RegionEditorComponent, FormsModule],
      providers: [
        { provide: REGION_EDITOR_API, useValue: mockVisualizer },
        { provide: MessageService, useValue: MockService(MessageService) },
        { provide: ConfirmationService, useValue: MockService(ConfirmationService) },
        { provide: REGION_IO_PORT, useValue: mockRegionIo },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(RegionEditorComponent);
    component = fixture.componentInstance;
    component.ngOnInit();

    addRect(component);
  });

  // --- exportRois (opens the export dialog) ---

  it('should open export dialog with default filename from selected image', () => {
    component['exportRois']();

    expect(component['showExportDialog']).toBe(true);
    expect(component['exportFilename']).toBe('slide_001.geojson');
  });

  it('should default to rois.geojson when no file is selected', () => {
    (mockRegionIo.getSelectedFileName as jest.Mock).mockReturnValue(undefined);

    component['exportRois']();

    expect(component['showExportDialog']).toBe(true);
    expect(component['exportFilename']).toBe('rois.geojson');
  });

  it('should not open export dialog when there are no regions', () => {
    component['regions'] = [];

    component['exportRois']();

    expect(component['showExportDialog']).toBe(false);
  });

  // --- confirmExport (download action) ---

  it('should download geojson with the chosen filename', async () => {
    component['exportFilename'] = 'my_export.geojson';
    component['showExportDialog'] = true;

    component['confirmExport']();
    await new Promise((r) => setTimeout(r)); // the download serializes first

    expect(component['showExportDialog']).toBe(false);
    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob), 'my_export.geojson');
    const blob: Blob = (saveAs as unknown as jest.Mock).mock.calls[0][0];
    expect(blob.type).toBe('application/json');
  });

  it('should use custom filename entered by user', async () => {
    component['exportFilename'] = 'custom_regions.geojson';

    component['confirmExport']();
    await new Promise((r) => setTimeout(r)); // the download serializes first

    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob), 'custom_regions.geojson');
  });

  it('should not download when filename is empty', () => {
    component['exportFilename'] = '   ';

    component['confirmExport']();

    expect(saveAs).not.toHaveBeenCalled();
  });

  it('should not download when there are no regions', () => {
    component['regions'] = [];
    component['exportFilename'] = 'test.geojson';

    component['confirmExport']();

    expect(saveAs).not.toHaveBeenCalled();
  });

  it('should trim whitespace from filename before downloading', async () => {
    component['exportFilename'] = '  padded_name.geojson  ';

    component['confirmExport']();
    await new Promise((r) => setTimeout(r)); // the download serializes first

    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob), 'padded_name.geojson');
  });

  it('should close the dialog on confirm', () => {
    component['exportFilename'] = 'test.geojson';
    component['showExportDialog'] = true;

    component['confirmExport']();

    expect(component['showExportDialog']).toBe(false);
  });
});

describe('RegionEditorComponent — coordinate + geometry editing', () => {
  let component: RegionEditorComponent;
  let api: any;

  beforeEach(async () => {
    let idc = 1;
    api = MockService(RoutingVisualizerService, {
      getShowShapeLabel: () => false,
      getShapeColor: () => '#00FFFF',
      getFillColor: () => 'rgba(0,0,0,0)',
      getClassificationColors: () => new Map<string, string>(),
      getRegionUpdateEvent: () => EMPTY,
      getSelectedRegions$: () => EMPTY,
      getImageMeta: () => EMPTY,
      setSelectedRegions: jest.fn(),
      getAnnotationRegions: () => [],
      setAnnotationRegions: jest.fn((regions: Region[]) => {
        for (const r of regions ?? []) if (r.id == null) r.id = idc++;
      }),
      importRegions: jest.fn(),
      exportRegions: jest.fn(),
    });

    shallowEditor();
    await TestBed.configureTestingModule({
      imports: [RegionEditorComponent, FormsModule],
      providers: [
        { provide: REGION_EDITOR_API, useValue: api },
        { provide: MessageService, useValue: MockService(MessageService) },
        { provide: ConfirmationService, useValue: MockService(ConfirmationService) },
        {
          provide: REGION_IO_PORT,
          useValue: {
            getSelectedFileName: () => undefined,
            roiFileExists: () => of(false),
            saveGeoJson: () => of(void 0),
            saveSliceGeoJsons: () => of(void 0),
          } as RegionIoPort,
        },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    component = TestBed.createComponent(RegionEditorComponent).componentInstance;
    component.ngOnInit();
  });

  function rect(): Region {
    const r = new Region();
    r.id = 1;
    const b = new Rectangle();
    b.x = 10;
    b.y = 20;
    b.width = 30;
    b.height = 40;
    r.bounds = b;
    return r;
  }
  function poly(): Region {
    const r = new Region();
    r.id = 2;
    const p = new Polygon();
    p.xpoints = [0, 10, 10, 0];
    p.ypoints = [0, 0, 10, 10];
    p.coordinates = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    p.npoints = 4;
    p.closed = true;
    r.bounds = p;
    return r;
  }

  it('regionArea reports px² for rect + polygon, blank when degenerate', () => {
    expect(component['regionArea'](rect())).toContain('px²'); // 30·40 = 1200
    expect(component['regionArea'](poly())).toContain('px²'); // shoelace = 100
    const degenerate = rect();
    (degenerate.bounds as Rectangle).width = 0;
    expect(component['regionArea'](degenerate)).toBe('');
  });

  it('regionArea reports physical units when mpp is known', () => {
    component['mpp'] = { mppX: 2, mppY: 2 };
    expect(component['regionArea'](rect())).toContain('µm²'); // 1200·4 = 4800 µm²
  });

  // pickMpp itself is covered in region-metrics.spec.ts.

  it('regionArea uses physical units when calibration is on a non-[0] entry', () => {
    component['mpp'] = pickMpp([{ mppX: 0 }, { mppX: 2, mppY: 2 }] as IImageMetadata[]);
    expect(component['regionArea'](rect())).toContain('µm²'); // would have been px² before
  });

  it('applyColorToSelected recolours each selected region by its class and commits', () => {
    const a = poly();
    a.label = 'Tumor';
    const b = poly();
    b.label = 'Tumor';
    const c = rect();
    c.label = 'Stroma';
    (component as any).regions = [a, b, c];
    component['selectedRegions'] = [a, b, c];
    const spy = api.setAnnotationRegions as jest.Mock;
    spy.mockClear();
    component['classColorEdits'] = [
      { label: 'Tumor', color: '#abcdef' },
      { label: 'Stroma', color: '#123456' },
    ];
    component['applyColorToSelected']();
    expect(component['regions'].map((r) => r.color)).toEqual(['#abcdef', '#abcdef', '#123456']);
    expect(component['selectedRegions']).toEqual(component['regions']); // the selection follows the copies
    expect(spy).toHaveBeenCalled();
    expect(component['showColorDialog']).toBe(false);
  });

  it('openColorDialog builds one colour editor per unique class in the selection', () => {
    const a = poly();
    a.label = 'Tumor';
    a.color = '#112233';
    const b = poly();
    b.label = 'Tumor';
    b.color = '#999999';
    const c = poly();
    c.label = 'Stroma';
    c.color = '#445566';
    const d = poly();
    d.label = '';
    d.color = '#778899';
    component['selectedRegions'] = [a, b, c, d];
    component['openColorDialog']();
    expect(component['classColorEdits']).toEqual([
      { label: 'Tumor', color: '#112233' },
      { label: 'Stroma', color: '#445566' },
      { label: '', color: '#778899' },
    ]);
    expect(component['showColorDialog']).toBe(true);
  });

  it('openColorDialog seeds a class picker with its class colour when the region has none', () => {
    const a = poly();
    a.label = 'Tumor';
    component['selectedRegions'] = [a];
    component['openColorDialog']();
    expect(component['classColorEdits']).toEqual([{ label: 'Tumor', color: component['colorForName']('Tumor') }]);
  });

  it('selectAllRegions selects every row and syncs the plot', () => {
    (component as any).regions = [poly(), rect()];
    const spy = api.setSelectedRegions as jest.Mock;
    spy.mockClear();
    component['selectAllRegions']();
    expect(component['selectedRegions'].length).toBe(2);
    expect(spy).toHaveBeenCalled();
  });

  it('changeRegionColor sets the region colour and commits live — jit-ui#85', () => {
    const r = poly();
    (component as any).regions = [r];
    const spy = api.setAnnotationRegions as jest.Mock;
    spy.mockClear();
    component['changeRegionColor'](r, '#abcdef');
    expect(component['regions'][0].color).toBe('#abcdef');
    expect(r.color).toBeUndefined(); // committed as a copy; the original is untouched (RT-1)
    expect(spy).toHaveBeenCalled();
  });

  it('changeRegionColor is a no-op when the colour is unchanged', () => {
    const r = poly();
    r.color = '#123456';
    (component as any).regions = [r];
    const spy = api.setAnnotationRegions as jest.Mock;
    spy.mockClear();
    component['changeRegionColor'](r, '#123456');
    expect(spy).not.toHaveBeenCalled();
  });

  it('regionArea sums MultiPolygon parts (minus their holes) — jit-ui#85', () => {
    const sq = (x0: number, w: number) => {
      const p = new Polygon();
      p.xpoints = [x0, x0 + w, x0 + w, x0];
      p.ypoints = [0, 0, w, w];
      p.npoints = 4;
      p.coordinates = p.xpoints.map((x, i) => [x, p.ypoints[i]]);
      p.closed = true;
      return p;
    };
    const r = new Region();
    const mp = new MultiPolygon();
    mp.polygons = [sq(0, 10), sq(20, 5)]; // 100 + 25
    r.bounds = mp;
    expect(component['regionArea'](r)).toBe('125 px²');
  });

  it('regionArea subtracts hole area (donut, not filled circle) — jit-ui#85', () => {
    const donut = poly(); // 10×10 exterior = 100
    (donut.bounds as Polygon).holes = [
      [
        [3, 3],
        [7, 3],
        [7, 7],
        [3, 7],
      ],
    ]; // 4×4 hole = 16
    expect(component['regionArea'](donut)).toBe('84 px²'); // 100 − 16
  });

  it('label-edit lifecycle tracks the editing set and commits on stop', () => {
    const r = rect();
    (component as any).regions = [r];
    expect(component['isEditingLabel'](r)).toBe(false);
    component['startEditLabel'](r);
    expect(component['isEditingLabel'](r)).toBe(true);
    component['stopEditLabel'](r, true); // commit
    expect(component['isEditingLabel'](r)).toBe(false);
    expect(api.setAnnotationRegions).toHaveBeenCalled();
  });
});

describe('RegionEditorComponent — annotation-class presets (jit-ui#70)', () => {
  let component: RegionEditorComponent;
  let fixture: ComponentFixture<RegionEditorComponent>;
  let api: RoutingVisualizerService;
  let currentSet: PresetSet;

  const makeSet = (): PresetSet => ({
    classes: [
      { name: 'Tumor', color: '#FF4444' },
      { name: 'Stroma', color: '#44AAFF' },
    ],
    fallbackPalette: ['#111111', '#222222', '#333333'],
    autoPromote: false,
    matchMode: 'exact',
  });

  beforeEach(async () => {
    currentSet = makeSet();
    let idc = 1;
    api = MockService(RoutingVisualizerService, {
      getShowShapeLabel: () => false,
      getShapeColor: () => '#00FFFF',
      getFillColor: () => 'rgba(0,0,0,0)',
      getClassificationColors: () => new Map<string, string>(),
      getRegionUpdateEvent: () => EMPTY,
      getSelectedRegions$: () => EMPTY,
      getImageMeta: () => EMPTY,
      setSelectedRegions: jest.fn(),
      getAnnotationRegions: () => [],
      setAnnotationRegions: jest.fn((regions: Region[]) => {
        for (const r of regions ?? []) {
          if (r.id == null) r.id = idc++;
        }
      }),
      getPresetSet: () => currentSet,
      getPresetSet$: () => of(currentSet),
      setPresetSet: jest.fn((s: PresetSet) => {
        currentSet = s;
      }),
      upsertClass: jest.fn(),
      removeClass: jest.fn(),
      resetPresets: jest.fn(),
      setClassificationColor: jest.fn(),
    });

    shallowEditor();
    await TestBed.configureTestingModule({
      imports: [RegionEditorComponent, FormsModule],
      providers: [
        { provide: REGION_EDITOR_API, useValue: api },
        { provide: MessageService, useValue: MockService(MessageService) },
        { provide: ConfirmationService, useValue: MockService(ConfirmationService) },
        {
          provide: REGION_IO_PORT,
          useValue: {
            getSelectedFileName: () => undefined,
            roiFileExists: () => of(false),
            saveGeoJson: () => of(void 0),
            saveSliceGeoJsons: () => of(void 0),
          } as RegionIoPort,
        },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(RegionEditorComponent);
    component = fixture.componentInstance;
    component.ngOnInit();
  });

  it('mirrors the preset set from the API on init', () => {
    expect(component['presetSet'].classes.map((c) => c.name)).toEqual(['Tumor', 'Stroma']);
  });

  it('colorForName returns the preset colour, else a deterministic fallback', () => {
    expect(component['colorForName']('Tumor')).toBe('#FF4444');
    const unknown = component['colorForName']('Mitosis');
    expect(currentSet.fallbackPalette).toContain(unknown);
    expect(component['colorForName']('Mitosis')).toBe(unknown); // stable across calls
  });

  it('applyPresetToRegion stamps the class + preset colour, clears the override, and commits', () => {
    const r = Object.assign(new Region(), { id: 1, label: 'x', color: '#000000', colorOverridden: true });
    component['regions'] = [r];
    component['applyPresetToRegion'](r, 'Tumor');
    expect(component['regions'][0].label).toBe('Tumor');
    expect(component['regions'][0].color).toBe('#FF4444');
    expect(component['regions'][0].colorOverridden).toBe(false);
    expect(api.setAnnotationRegions).toHaveBeenCalled();
  });

  it('applyPresetToRegion gives an unknown class a deterministic fallback colour', () => {
    const r = Object.assign(new Region(), { id: 1 });
    component['regions'] = [r];
    component['applyPresetToRegion'](r, 'Mitosis');
    expect(component['regions'][0].label).toBe('Mitosis');
    expect(currentSet.fallbackPalette).toContain(component['regions'][0].color);
  });

  it('selectActiveClass sets the active class and applies it to the selection', () => {
    const a = Object.assign(new Region(), { id: 1 });
    const b = Object.assign(new Region(), { id: 2 });
    component['regions'] = [a, b];
    component['selectedRegions'] = [a, b];
    component['selectActiveClass']('Stroma');
    expect(component['activeClass']).toBe('Stroma');
    expect(component['regions'][0].label).toBe('Stroma');
    expect(component['regions'][1].color).toBe('#44AAFF');
    expect(api.setAnnotationRegions).toHaveBeenCalled();
  });

  it('openManageDialog clones the set into an isolated draft', () => {
    component['openManageDialog']();
    expect(component['showManageDialog']).toBe(true);
    expect(component['presetDraft']).toBeTruthy();
    component['presetDraft']!.classes[0].name = 'Changed';
    // mutating the draft must not touch the live set
    expect(component['presetSet'].classes[0].name).toBe('Tumor');
  });

  it('applyManageDialog drops blank/duplicate names, persists, and recolours regions', () => {
    component['openManageDialog']();
    component['presetDraft']!.classes = [
      { name: 'Tumor', color: '#FF0000' },
      { name: '   ', color: '#000000' }, // blank -> dropped
      { name: 'Tumor', color: '#00FF00' }, // duplicate -> dropped
      { name: 'New', color: '#123456' },
    ];
    component['applyManageDialog'](true);
    expect(api.setPresetSet).toHaveBeenCalled();
    const saved = (api.setPresetSet as jest.Mock).mock.calls[0][0] as PresetSet;
    expect(saved.classes.map((c) => c.name)).toEqual(['Tumor', 'New']);
    expect(api.setAnnotationRegions).toHaveBeenCalled();
    expect(component['showManageDialog']).toBe(false);
  });

  it('applyManageDialog de-duplicates case/whitespace variants in normalized mode', () => {
    component['openManageDialog']();
    component['presetDraft']!.matchMode = 'normalized';
    component['presetDraft']!.classes = [
      { name: 'Tumor', color: '#FF0000' },
      { name: '  tumor ', color: '#00FF00' }, // same key under normalization -> dropped
      { name: 'Stroma', color: '#0000FF' },
    ];
    component['applyManageDialog'](true);
    const saved = (api.setPresetSet as jest.Mock).mock.calls.at(-1)![0] as PresetSet;
    expect(saved.classes.map((c) => c.name)).toEqual(['Tumor', 'Stroma']);
  });

  it('deleteClass reverts its regions to the default "Region" class', () => {
    component['presetSet'] = {
      classes: [
        { name: 'Tumor', color: '#FF4444' },
        { name: 'Region', color: '#00FFFF' },
      ],
      fallbackPalette: ['#111111'],
      autoPromote: false,
      matchMode: 'exact',
    };
    const a = Object.assign(new Region(), { id: 1, label: 'Tumor', color: '#FF4444', colorOverridden: true });
    const b = Object.assign(new Region(), { id: 2, label: 'Stroma', color: '#44AAFF' });
    component['regions'] = [a, b];

    component['deleteClass']('Tumor');

    expect(component['regions'][0].label).toBe('Region');
    expect(component['regions'][0].color).toBe('#00FFFF'); // the Region class colour
    expect(component['regions'][0].colorOverridden).toBe(false);
    expect(component['regions'][1]).toBe(b); // other regions untouched
    expect(b.label).toBe('Stroma');
    expect(api.removeClass).toHaveBeenCalledWith('Tumor');
  });

  it('applyManageDialog reverts regions of a dropped class to "Region"', () => {
    component['presetSet'] = {
      classes: [
        { name: 'Tumor', color: '#FF4444' },
        { name: 'Region', color: '#00FFFF' },
      ],
      fallbackPalette: ['#111111'],
      autoPromote: false,
      matchMode: 'exact',
    };
    const a = Object.assign(new Region(), { id: 1, label: 'Tumor', color: '#FF4444' });
    component['regions'] = [a];

    component['openManageDialog']();
    component['presetDraft']!.classes = [{ name: 'Region', color: '#00FFFF' }]; // drop Tumor
    component['applyManageDialog'](true);

    expect(component['regions'][0].label).toBe('Region');
    expect(component['regions'][0].colorOverridden).toBe(false);
  });

  // The delete-class tooltip / disabled state is covered in classes-panel.component.spec.ts.

  it('auto-adds classes found on loaded regions (not already presets), ignoring legend/empty', () => {
    const loaded = [
      Object.assign(new Region(), { id: 1, label: 'Tumor', color: '#FF4444' }), // already a preset
      Object.assign(new Region(), { id: 2, label: 'Optic-disc', color: '#123456' }), // new -> added
      Object.assign(new Region(), { id: 3, label: 'legend', color: '#00FFFF' }), // placeholder -> ignored
      Object.assign(new Region(), { id: 4, label: '', color: '#000000' }), // empty -> ignored
    ];
    (component as any).syncClassesFromRegions(loaded);
    const added = (api.upsertClass as jest.Mock).mock.calls.map((c) => c[0]);
    const names = added.map((p) => p.name);
    expect(names).toContain('Optic-disc');
    expect(names).not.toContain('Tumor');
    expect(names).not.toContain('legend');
    expect(names).not.toContain('');
    expect(added.find((p) => p.name === 'Optic-disc').color).toBe('#123456');
  });

  // The draft's add/remove helpers are covered in manage-classes-dialog.component.spec.ts.

  // ── docked Classes panel ──
  it('classCount reflects region labels', () => {
    (component as any).regions = [
      Object.assign(new Region(), { id: 1, label: 'Tumor' }),
      Object.assign(new Region(), { id: 2, label: 'Tumor' }),
      Object.assign(new Region(), { id: 3, label: 'Stroma' }),
    ];
    (component as any).recomputeClassCounts();
    expect(component['classCount']('Tumor')).toBe(2);
    expect(component['classCount']('Stroma')).toBe(1);
    expect(component['classCount']('Necrosis')).toBe(0);
  });

  it('displayClasses is ordered by region count, descending', () => {
    (component as any).regions = [
      Object.assign(new Region(), { id: 1, label: 'Stroma' }),
      Object.assign(new Region(), { id: 2, label: 'Stroma' }),
      Object.assign(new Region(), { id: 3, label: 'Tumor' }),
    ];
    (component as any).recomputeClassCounts();
    expect(component['displayClasses'].map((c) => c.name)).toEqual(['Stroma', 'Tumor']); // 2 before 1
  });

  it('committing a region with a new class label adds that class', () => {
    (component as any).regions = [Object.assign(new Region(), { id: 1, label: 'BrandNewClass' })];
    (component as any).commit();
    expect(api.upsertClass).toHaveBeenCalledWith(expect.objectContaining({ name: 'BrandNewClass' }));
  });

  it('setClassColor upserts the class colour and commits a recolour', () => {
    component['setClassColor']('Tumor', '#010203');
    expect(api.setClassificationColor).toHaveBeenCalledWith('Tumor', '#010203');
    expect(api.setAnnotationRegions).toHaveBeenCalled();
  });

  it('deleteClass removes the class and reverts its in-use regions to "Region"', () => {
    const t = Object.assign(new Region(), { id: 1, label: 'Tumor' });
    component['regions'] = [t];
    component['deleteClass']('Tumor'); // in use -> removed, its region reverts to Region
    expect(api.removeClass).toHaveBeenCalledWith('Tumor');
    expect(component['regions'][0].label).toBe('Region');
    (api.removeClass as jest.Mock).mockClear();
    component['deleteClass']('Necrosis'); // unused -> removed
    expect(api.removeClass).toHaveBeenCalledWith('Necrosis');
  });

  it('applyBulkClass sets the chosen class on the selection', () => {
    const a = Object.assign(new Region(), { id: 1 });
    component['regions'] = [a];
    component['selectedRegions'] = [a];
    component['bulkClass'] = 'Stroma';
    component['applyBulkClass']();
    expect(component['regions'][0].label).toBe('Stroma');
    expect(component['regions'][0].color).toBe('#44AAFF');
    expect(api.setAnnotationRegions).toHaveBeenCalled();
  });

  it('addAndApplyBulkClass adds a new class and sets it on the selection', () => {
    const a = Object.assign(new Region(), { id: 1 });
    component['regions'] = [a];
    component['selectedRegions'] = [a];
    component['newBulkClass'] = 'Mitosis';
    component['addAndApplyBulkClass']();
    expect(api.upsertClass).toHaveBeenCalledWith(expect.objectContaining({ name: 'Mitosis' }));
    expect(component['regions'][0].label).toBe('Mitosis');
    expect(component['newBulkClass']).toBe('');
  });
});

describe('RegionEditorComponent — OnPush', () => {
  @Component({ standalone: true, imports: [RegionEditorComponent], template: '<region-editor></region-editor>' })
  class HostComponent {}

  it('re-renders when the viewer changes the regions (an async update, not a template event)', async () => {
    const updates = new Subject<Region[]>();
    let regions: Region[] = [];
    const api = MockService(RoutingVisualizerService, {
      getShowShapeLabel: () => false,
      getShapeColor: () => '#00FFFF',
      getFillColor: () => 'rgba(0,0,0,0)',
      getClassificationColors: () => new Map<string, string>(),
      getRegionUpdateEvent: () => updates,
      getSelectedRegions$: () => EMPTY,
      getImageMeta: () => EMPTY,
      getAnnotationRegions: () => regions,
    });
    // Template only, no FormsModule either: the PrimeNG form controls are unknown elements here.
    TestBed.overrideComponent(RegionEditorComponent, {
      set: { imports: [CommonModule], schemas: [NO_ERRORS_SCHEMA] },
    });
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        { provide: REGION_EDITOR_API, useValue: api },
        { provide: MessageService, useValue: MockService(MessageService) },
        { provide: ConfirmationService, useValue: MockService(ConfirmationService) },
        { provide: REGION_IO_PORT, useValue: { roiFileExists: () => of(false) } as unknown as RegionIoPort },
      ],
    }).compileComponents();
    const host = TestBed.createComponent(HostComponent);
    host.detectChanges();
    // Shallow: <region-table> is an unknown element, so its [total] lands on the DOM node.
    const total = () => (host.nativeElement.querySelector('region-table') as { total?: number }).total;
    expect((RegionEditorComponent as unknown as { ɵcmp: { onPush: boolean } }).ɵcmp.onPush).toBe(true);
    expect(total()).toBe(0);

    regions = [1, 2].map((id) => Object.assign(new Region(), { id, color: '#FF0000' }));
    updates.next([]);
    host.detectChanges();
    expect(total()).toBe(2);
    host.destroy();
  });
});

describe('RegionEditorComponent with a region source', () => {
  let component: RegionEditorComponent;
  let api: RoutingVisualizerService;
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `f${i}`,
    label: i < 3 ? 'CTX' : 'MB',
    color: '#00ff00',
    bbox: [0, 0, 1, 1] as [number, number, number, number],
  }));
  const view = {
    source: {
      info: { hierarchy: [{ name: 'grey' }, { name: 'CTX', parent: 'grey' }, { name: 'MB', parent: 'grey' }] },
    },
    plane: 0,
    taken: new Set<string>(),
    colorOf: () => '#00ff00',
    style: { fillOpacity: 0, stroke: null, strokeWidth: null, highlight: null },
    labels: false,
  } as unknown as RegionSourceView;
  const settle = () => new Promise((r) => setTimeout(r));
  let presets$: BehaviorSubject<PresetSet>;
  let volume$: BehaviorSubject<boolean>;
  let slicePane$: BehaviorSubject<boolean>;
  let pickedRegionClasses$: BehaviorSubject<readonly string[]>;

  beforeEach(async () => {
    const drawn = Object.assign(new Region(), { id: 1, name: 'shape1', label: 'MB', color: '#f00' });
    // Another slice's region: counted only with the whole stack.
    const elsewhere = Object.assign(new Region(), { id: 2, name: 'shape2', label: 'CTX', color: '#0f0', z: 4 });
    volume$ = new BehaviorSubject(false);
    slicePane$ = new BehaviorSubject(false);
    pickedRegionClasses$ = new BehaviorSubject<readonly string[]>([]);
    presets$ = new BehaviorSubject<PresetSet>({
      classes: [],
      fallbackPalette: ['#123456'],
      autoPromote: false,
      matchMode: 'exact',
    });
    api = MockService(RoutingVisualizerService, {
      getPresetSet$: () => presets$,
      getShowShapeLabel: () => false,
      getShapeColor: () => '#00FFFF',
      getFillColor: () => 'rgba(0,0,0,0)',
      getClassificationColors: () => new Map<string, string>(),
      getRegionUpdateEvent: () => EMPTY,
      getSelectedRegions$: () => EMPTY,
      getImageMeta: () => EMPTY,
      setSelectedRegions: jest.fn(),
      getAnnotationRegions: () => [drawn],
      setAnnotationRegions: jest.fn(),
      getRegionSourceView$: () => new BehaviorSubject<RegionSourceView | null>(view),
      getRegionSourceIndex: jest.fn(async (q: { offset: number; limit: number }) => ({
        total: rows.length,
        rows: rows.slice(q.offset, q.offset + q.limit),
      })),
      getRegionSourceClassCounts: jest.fn(async (stack?: boolean) =>
        stack ? { CTX: 30, MB: 90 } : { CTX: 3, MB: 9 },
      ),
      getSliceAnnotationRegions: () => [drawn, elsewhere],
      getVolumeView$: () => volume$,
      getSliceEditor$: () => slicePane$,
      getClassVolumes: async () => ({}),
      selectSourceFeatures: jest.fn(async () => []),
      deleteSourceFeatures: jest.fn(),
      selectRegionClasses: jest.fn(async () => undefined),
      getPickedRegionClasses$: () => pickedRegionClasses$,
    });
    shallowEditor();
    await TestBed.configureTestingModule({
      imports: [RegionEditorComponent, FormsModule],
      providers: [
        { provide: REGION_EDITOR_API, useValue: api },
        { provide: MessageService, useValue: MockService(MessageService) },
        { provide: ConfirmationService, useValue: MockService(ConfirmationService) },
        {
          provide: REGION_IO_PORT,
          useValue: {
            getSelectedFileName: () => undefined,
            roiFileExists: () => of(false),
            saveGeoJson: () => of(void 0),
            saveSliceGeoJsons: () => of(void 0),
          } as RegionIoPort,
        },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
    component = TestBed.createComponent(RegionEditorComponent).componentInstance;
    component.ngOnInit();
    await settle();
  });

  const page = (): Region[] => (component as any).pagedRegions;

  it('toggles the regions through the volume in a volume view', async () => {
    const set = jest.fn();
    Object.assign(api, { setRegionsThroughVolume: set });
    (component as any).toggleThroughVolume();
    expect(set).toHaveBeenCalledWith(true);
  });

  it('asks the region source nothing while closed, and reads it again when opened', async () => {
    const index = api.getRegionSourceIndex as jest.Mock;
    const counts = api.getRegionSourceClassCounts as jest.Mock;
    const volumes = jest.fn(async () => ({}));
    Object.assign(api, { getClassVolumes: volumes });
    component.active = false;
    index.mockClear();
    counts.mockClear();
    volume$.next(true);
    (component as any).onPageChange({ first: 10, rows: 10 });
    await settle();
    expect(index).not.toHaveBeenCalled();
    expect(counts).not.toHaveBeenCalled();
    expect(volumes).not.toHaveBeenCalled();
    component.active = true;
    await settle();
    expect(index).toHaveBeenCalledTimes(1);
    expect(counts).toHaveBeenCalledWith(true);
    expect(volumes).toHaveBeenCalled();
  });

  it("counts the whole stack's classes in a volume view, and the slice's with its slice pane", async () => {
    const tree = () => Object.fromEntries((component as any).treeCounts);
    expect(tree()).toEqual({ MB: 10, CTX: 3 });
    volume$.next(true);
    await settle();
    // Every slice's regions and source features (the 2D slice's would be the last one shown).
    expect(tree()).toEqual({ MB: 91, CTX: 31 });
    expect((api.getRegionSourceClassCounts as jest.Mock).mock.calls.at(-1)[0]).toBe(true);
    slicePane$.next(true);
    await settle();
    expect(tree()).toEqual({ MB: 10, CTX: 3 });
    slicePane$.next(false);
    volume$.next(false);
    await settle();
    expect(tree()).toEqual({ MB: 10, CTX: 3 });
    // The table lists the slice's regions throughout.
    expect((component as any).tableTotal).toBe(13);
  });

  it('lists the regions, then the source features, in one table', () => {
    expect((component as any).tableTotal).toBe(13);
    expect(page().map((r) => r.sourceId ?? r.name)).toEqual(['shape1', ...rows.slice(0, 9).map((r) => r.id)]);
    expect((api.getRegionSourceIndex as jest.Mock).mock.calls.at(-1)[0]).toEqual({ offset: 0, limit: 9 });
  });

  it('pages into the source past the regions', async () => {
    (component as any).onPageChange({ first: 10, rows: 10 });
    await settle();
    expect((api.getRegionSourceIndex as jest.Mock).mock.calls.at(-1)[0]).toEqual({ offset: 9, limit: 10 });
    expect(page().map((r) => r.sourceId)).toEqual(['f9', 'f10', 'f11']);
  });

  it('takes selected source rows into the regions, and deletes source rows from the source', () => {
    component['selectedRegions'] = [page()[0], page()[2]];
    (component as any).onSelectionChanged();
    expect(api.setSelectedRegions).toHaveBeenCalledWith([page()[0]]);
    expect(api.selectSourceFeatures).toHaveBeenCalledWith(['f1'], true);
    (component as any).deleteRegion(3);
    expect(api.deleteSourceFeatures).toHaveBeenCalledWith(['f2']);
  });

  it('counts the source in the classes, as a tree, and a tree pick selects the subtree', async () => {
    expect((component as any).classHierarchy).toHaveLength(3);
    expect((component as any).treeCounts.get('MB')).toBe(10);
    expect((component as any).classCount('CTX')).toBe(3);
    await (component as any).pickClasses({ name: 'grey', classes: ['grey', 'CTX', 'MB'], additive: false });
    expect(api.selectRegionClasses).toHaveBeenCalledWith(['grey', 'CTX', 'MB'], false);
    expect((component as any).pickedClass).toBe('grey');
  });

  it("drops the tree's pick once another selection replaces it (a region drawn on the canvas)", async () => {
    await (component as any).pickClasses({ name: 'grey', classes: ['grey', 'CTX', 'MB'], additive: false });
    pickedRegionClasses$.next(['grey', 'CTX', 'MB']);
    expect((component as any).pickedClass).toBe('grey');

    pickedRegionClasses$.next([]);
    expect((component as any).pickedClass).toBeNull();
    expect((component as any).pickedClasses).toEqual([]);
  });

  it('shows classes in 3D in a volume view, each with its subtree, and hides them again', async () => {
    const show = jest.fn(async () => undefined);
    (api as unknown as { showRegionClasses3d: typeof show }).showRegionClasses3d = show;
    (component as any).toggleClass3d('grey', ['grey', 'CTX', 'MB']);
    (component as any).toggleClass3d('MB');
    expect(show).toHaveBeenLastCalledWith([
      { key: 'grey', classes: ['grey', 'CTX', 'MB'], color: expect.any(String), label: 'grey' },
      { key: 'MB', classes: ['MB'], color: expect.any(String), label: 'MB' },
    ]);
    (component as any).toggleClass3d('grey');
    expect(show).toHaveBeenLastCalledWith([
      { key: 'MB', classes: ['MB'], color: expect.any(String), label: 'MB' },
    ]);
    expect([...(component as any).shown3dNames]).toEqual(['MB']);
  });

  it('repaints the surfaces shown in 3D when a class colour changes', async () => {
    const show = jest.fn(async () => undefined);
    (api as unknown as { showRegionClasses3d: typeof show }).showRegionClasses3d = show;
    (component as any).toggleClass3d('MB');
    expect(show).toHaveBeenCalledTimes(1);

    presets$.next({ ...presets$.value, classes: [{ name: 'MB', color: '#ff00aa' }] });
    expect(show).toHaveBeenLastCalledWith([{ key: 'MB', classes: ['MB'], color: '#ff00aa', label: 'MB' }]);
    expect((component as any).treeColor('MB')).toBe('#ff00aa');

    // Another class's colour: the surface is left alone.
    presets$.next({ ...presets$.value, classes: [...presets$.value.classes, { name: 'CTX', color: '#00aaff' }] });
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('highlights the surfaces holding the selected classes, and a surface click picks its class', async () => {
    const highlight = jest.fn();
    const picked$ = new Subject<{ key: string | null; additive: boolean }>();
    Object.assign(api, {
      showRegionClasses3d: jest.fn(async () => undefined),
      highlightRegionClasses3d: highlight,
    });
    (component as any).toggleClass3d('grey', ['grey', 'CTX', 'MB']);
    (component as any).toggleClass3d('CTX');
    expect(highlight).not.toHaveBeenCalled();

    // A pick in the tree: every surface holding one of its classes.
    await (component as any).pickClasses({ name: 'MB', classes: ['MB'], additive: false });
    expect(highlight).toHaveBeenLastCalledWith(['grey']);

    // Rows picked in the table replace the pick: their classes count.
    (component as any).selectedRegions = [Object.assign(new Region(), { id: 7, label: 'CTX' })];
    (component as any).onSelectionChanged();
    expect(highlight).toHaveBeenLastCalledWith(['grey', 'CTX']);
    expect([...(component as any).markedClasses]).toEqual(['CTX']);

    // A click on a surface in 3D picks its class with its subtree, as the tree does.
    (component as any).onPicked3d('grey', false);
    expect((component as any).pickedClass).toBe('grey');
    expect(api.selectRegionClasses).toHaveBeenLastCalledWith(['grey', 'CTX', 'MB'], false);

    // A click beside the surfaces clears the selection and the highlight.
    (component as any).onPicked3d(null, false);
    expect((component as any).pickedClass).toBeNull();
    expect((component as any).selectedRegions).toEqual([]);
    expect(highlight).toHaveBeenLastCalledWith([]);
    picked$.complete();
  });

  it("in a volume view, asks for the volumes of the page's classes, once each", async () => {
    const volumes = jest.fn(async (classes: readonly string[]) =>
      Object.fromEntries(classes.map((c) => [c, c === 'MB' ? 900 : 40])),
    );
    Object.assign(api, { getClassVolumes: volumes });
    await settle();
    (component as any).volumeView = true;
    (component as any).resetVolumes();
    expect([...(component as any).tableVolumes.values()].every((v: unknown) => v === null)).toBe(true);
    await settle();
    expect(volumes).toHaveBeenCalledTimes(1);
    expect(new Set(volumes.mock.calls[0][0])).toEqual(new Set(['MB', 'CTX']));
    expect(Object.fromEntries((component as any).tableVolumes)).toEqual({ MB: 900, CTX: 40 });
    (component as any).requestVolumes();
    expect(volumes).toHaveBeenCalledTimes(1);

    // Back to a 2D view: areas again.
    (component as any).volumeView = false;
    (component as any).resetVolumes();
    expect((component as any).tableVolumes).toBeNull();
  });
});

describe('RegionEditorComponent importing region sets', () => {
  let component: RegionEditorComponent;
  let api: RoutingVisualizerService;
  let picked: Subject<ServerRegionPick | null>;
  let toasts: jest.Mock;
  const settle = () => new Promise((r) => setTimeout(r));

  /** A 3 × 2 × 2 uint8 NRRD (3 sections of 2 × 2): each section's top row label 1, its bottom row 2. */
  const nrrd = () => {
    const head = new TextEncoder().encode('NRRD0004\ntype: uchar\ndimension: 3\nsizes: 3 2 2\nencoding: raw\n\n');
    const data = new Uint8Array(12);
    for (let i = 0; i < 12; i++) data[i] = (Math.floor(i / 3) % 2) + 1;
    const out = new Uint8Array(head.length + data.length);
    out.set(head);
    out.set(data, head.length);
    return out;
  };
  const allen = {
    msg: [
      {
        id: 1,
        acronym: 'A',
        name: 'Area A',
        color_hex_triplet: 'FF0000',
        graph_order: 0,
        children: [{ id: 2, acronym: 'B', color_hex_triplet: '00FF00', graph_order: 1 }],
      },
    ],
  };

  beforeEach(async () => {
    picked = new Subject();
    toasts = jest.fn();
    api = MockService(RoutingVisualizerService, {
      getPresetSet$: () =>
        new BehaviorSubject<PresetSet>({
          classes: [],
          fallbackPalette: ['#123456'],
          autoPromote: false,
          matchMode: 'exact',
        }),
      getShowShapeLabel: () => false,
      getShapeColor: () => '#00FFFF',
      getFillColor: () => 'rgba(0,0,0,0)',
      getClassificationColors: () => new Map<string, string>(),
      getRegionUpdateEvent: () => EMPTY,
      getSelectedRegions$: () => EMPTY,
      getImageMeta: () => EMPTY,
      getAnnotationRegions: () => [],
      setAnnotationRegions: jest.fn(),
      setSelectedRegions: jest.fn(),
      getMaskImageSize: () => ({ width: 2, height: 2 }),
      importSliceRegionSources: jest.fn((openers: ReadonlyMap<number, unknown>) => openers.size),
      importRegionSourceOpener: jest.fn(async () => true),
    });
    shallowEditor();
    await TestBed.configureTestingModule({
      imports: [RegionEditorComponent, FormsModule],
      providers: [
        { provide: REGION_EDITOR_API, useValue: api },
        { provide: MessageService, useValue: { add: toasts } },
        { provide: ConfirmationService, useValue: MockService(ConfirmationService) },
        {
          provide: REGION_IO_PORT,
          useValue: {
            getSelectedFileName: () => 'atlas.nrrd',
            roiFileExists: () => of(false),
            saveGeoJson: () => of(void 0),
            saveSliceGeoJsons: () => of(void 0),
            pickServerRegions: () => picked,
          } as RegionIoPort,
        },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
    component = TestBed.createComponent(RegionEditorComponent).componentInstance;
    component.ngOnInit();
  });

  const importFiles = (files: Array<{ name: string; data: string | Uint8Array }>) =>
    (component as any).importRegionFiles(files.map((f) => importFile(f.data, f.name)));

  it('imports a label volume as one source per slice, its classes and tree from the ontology chosen with it', async () => {
    await importFiles([
      { name: 'annotation.nrrd', data: nrrd() },
      { name: 'ontology/structure_graph_1.json', data: JSON.stringify(allen) },
    ]);
    const openers = (api.importSliceRegionSources as jest.Mock).mock.calls[0][0] as Map<
      number,
      () => Promise<{ info: { hierarchy?: unknown[]; classColors: Record<string, string> } }>
    >;
    expect([...openers.keys()]).toEqual([0, 1, 2]);
    // A slice's source, traced when opened: classes A and B, the ontology's tree.
    const source = await openers.get(1)!();
    expect(source.info.hierarchy).toEqual([
      { name: 'A', title: 'Area A', color: '#FF0000', order: 0 },
      { name: 'B', parent: 'A', color: '#00FF00', order: 1 },
    ]);
    expect(Object.keys(source.info.classColors).sort()).toEqual(['A', 'B']);
    expect(toasts).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'success', detail: '3 slices of 2 × 2; 3 slices annotated.' }),
    );
  });

  it("imports a folder of per-slice files in name order, each with the set's class tree", async () => {
    const fc = (cls: string) =>
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: cls,
            properties: { classification: { name: cls, color: [1, 2, 3] } },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
            },
          },
        ],
      });
    await importFiles([
      { name: 'regions/s10.geojson', data: fc('C') },
      { name: 'regions/s2.geojson', data: fc('B') },
      {
        name: 'regions/regionset.json',
        data: JSON.stringify({ classHierarchy: [{ name: 'B' }, { name: 'C', parent: 'B' }] }),
      },
    ]);
    const openers = (api.importSliceRegionSources as jest.Mock).mock.calls[0][0] as Map<
      number,
      () => Promise<{ info: { hierarchy?: unknown[]; classColors: Record<string, string> } }>
    >;
    expect(openers.size).toBe(2);
    const second = await openers.get(1)!();
    expect(Object.keys(second.info.classColors)).toEqual(['C']);
    expect(second.info.hierarchy).toEqual([{ name: 'B' }, { name: 'C', parent: 'B' }]);
  });

  it('imports regions picked on the server: files as chosen files, a served set as a source', async () => {
    expect((component as any).canImportFromServer).toBe(true);
    (component as any).importFromServer();
    expect((component as any).importing).toBe(true);
    picked.next({ kind: 'files', files: [{ name: 'annotation.nrrd', data: nrrd() }] });
    await settle();
    expect(api.importSliceRegionSources).toHaveBeenCalledTimes(1);

    (component as any).importFromServer();
    picked.next({ kind: 'source', url: 'https://server/api/regions/ID/', name: 'annotation_25_coronal' });
    picked.complete();
    await settle();
    // No ticket: this host's API has no regionImportTicket.
    expect(api.importRegionSourceOpener).toHaveBeenCalledWith(expect.any(Function), undefined);
    expect((component as any).importing).toBe(false);
  });

  it('reports a GeoJSON file that does not parse, rather than rejecting', async () => {
    await expect(importFiles([{ name: 'bad.geojson', data: '{bad' }])).resolves.toBeUndefined();
    expect(toasts).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
    expect(api.importSliceRegionSources).not.toHaveBeenCalled();
  });

  it('reports a file that cannot be read, rather than rejecting', async () => {
    const unreadable = {
      name: 'gone.geojson',
      text: () => Promise.reject(new Error('the file went away')),
      bytes: () => Promise.reject(new Error('the file went away')),
    };
    await expect((component as any).importRegionFiles([unreadable])).resolves.toBeUndefined();
    expect(toasts).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', detail: expect.stringContaining('the file went away') }),
    );
  });

  it('splits a z-indexed GeoJSON file into one source per slice', async () => {
    const feature = (z: number) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 1], plane: { c: -1, z, t: 0 } },
      properties: { classification: { name: 'A' } },
    });
    await importFiles([
      {
        name: 'stack.geojson',
        data: JSON.stringify({ type: 'FeatureCollection', features: [feature(0), feature(2)] }),
      },
    ]);
    const openers = (api.importSliceRegionSources as jest.Mock).mock.calls[0][0] as Map<number, unknown>;
    expect([...openers.keys()]).toEqual([0, 1, 2]);
  });

  it('discards an import that finished after the image changed, saying so', async () => {
    (api as any).regionImportTicket = jest.fn(() => 7);
    (api.importSliceRegionSources as jest.Mock).mockReturnValueOnce(null);
    await importFiles([
      { name: 'annotation.nrrd', data: nrrd() },
      { name: 'ontology/structure_graph_1.json', data: JSON.stringify(allen) },
    ]);
    // The ticket taken before decoding travels with the import.
    expect((api.importSliceRegionSources as jest.Mock).mock.calls[0][1]).toBe(7);
    expect(toasts).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'info', summary: 'Import discarded' }),
    );
    expect(toasts).not.toHaveBeenCalledWith(expect.objectContaining({ summary: 'Regions imported' }));
  });

  it('says why when the chosen files are not regions', async () => {
    await importFiles([{ name: 'image.tif', data: 'x' }]);
    expect(api.importSliceRegionSources).not.toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', summary: 'Error importing regions' }),
    );
  });
});
