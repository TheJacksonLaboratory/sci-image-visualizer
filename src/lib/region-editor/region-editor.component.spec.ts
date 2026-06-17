import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { EMPTY, of, throwError } from 'rxjs';

import { RegionEditorComponent } from './region-editor.component';
import { RoutingVisualizerService } from '../routing-visualizer.service';
import { REGION_EDITOR_API } from '../contracts/region-editor-api.contract';
import { MockService } from 'ng-mocks';
import { ConfirmationService, MessageService } from 'primeng/api';
import { Polygon, Rectangle, Region, MultiPolygon } from '../models/region';
import { ShapeSelection } from '../models/shape';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { HexColorPickerComponent } from '../hex-color-picker/hex-color-picker.component';
import { REGION_IO_PORT, RegionIoPort } from '../contracts/ports/region-io.port';

jest.mock('file-saver', () => ({ saveAs: jest.fn() }));
import { saveAs } from 'file-saver';

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

    await TestBed.configureTestingModule({
      declarations: [RegionEditorComponent, HexColorPickerComponent],
      imports: [FormsModule],
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
          } as RegionIoPort,
        },
      ],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(RegionEditorComponent);
    component = fixture.componentInstance;
    component.ngOnInit();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should initialize with empty regions when no shapes provided', () => {
    expect(component.regions.length).toBe(0);
  });

  it('should add a rectangle region', () => {
    component.addRectangle();
    expect(component.regions.length).toBe(1);
    expect(component.regions[0].bounds).toBeInstanceOf(Rectangle);
    const rect = component.regions[0].bounds as Rectangle;
    expect(rect.width).toBe(512);
    expect(rect.height).toBe(512);
  });

  it('should add a polygon region with 3 default points', () => {
    component.addPolygon();
    expect(component.regions.length).toBe(1);
    expect(component.regions[0].bounds).toBeInstanceOf(Polygon);
    const poly = component.regions[0].bounds as Polygon;
    expect(poly.npoints).toBe(3);
    expect(poly.coordinates.length).toBe(3);
  });

  it('should delete a region by index', () => {
    component.addRectangle();
    component.addRectangle();
    const secondBounds = component.regions[1].bounds;
    expect(component.regions.length).toBe(2);
    component.deleteRegion(0);
    expect(component.regions.length).toBe(1);
    // The surviving region is the one that was at index 1.
    expect(component.regions[0].bounds).toBe(secondBounds);
  });

  it('should delete selected regions', () => {
    component.addRectangle();
    component.addPolygon();
    component.selectedRegions = [component.regions[0]];
    component.deleteSelectedRegions();
    expect(component.regions.length).toBe(1);
    expect(component.regions[0].bounds).toBeInstanceOf(Polygon);
    expect(component.selectedRegions.length).toBe(0);
  });

  it('should not delete when no regions are selected', () => {
    component.addRectangle();
    component.selectedRegions = [];
    component.deleteSelectedRegions();
    expect(component.regions.length).toBe(1);
  });

  it('should identify rectangle regions', () => {
    const region = new Region();
    region.bounds = new Rectangle();
    expect(component.isRectangle(region)).toBe(true);
  });

  it('should identify polygon regions as not rectangle', () => {
    const region = new Region();
    region.bounds = new Polygon();
    expect(component.isRectangle(region)).toBe(false);
  });

  it('should round rectangle lengths to multiples of 512', () => {
    component.addRectangle();
    const rect = component.regions[0].bounds as Rectangle;
    rect.width = 1000;
    rect.height = 600;
    component.roundRectangleLengths();
    expect(rect.width).toBe(1024);
    expect(rect.height).toBe(512);
  });

  it('should round small rectangle lengths to 0', () => {
    component.addRectangle();
    const rect = component.regions[0].bounds as Rectangle;
    rect.width = 100;
    rect.height = 200;
    component.roundRectangleLengths();
    expect(rect.width).toBe(0);
    expect(rect.height).toBe(0);
  });

  it('should change shape color for regions matching selected label', () => {
    component.addRectangle();
    component.regions[0].label = 'tumor';
    component.regions[0].color = '#FF0000';
    component.labelColors.set('tumor', '#FF0000');
    component.selectedLabelColor = 'tumor';

    component.changeShapeColor({ value: '#00FF00' });
    expect(component.shapeColor).toBe('#00FF00');
    expect(component.regions[0].color).toBe('#00FF00');
    expect(component.labelColors.get('tumor')).toBe('#00FF00');
  });

  it('should not change color of regions with different label', () => {
    component.addRectangle();
    component.addRectangle();
    component.regions[0].label = 'tumor';
    component.regions[0].color = '#FF0000';
    component.regions[1].label = 'normal';
    component.regions[1].color = '#0000FF';
    component.labelColors.set('tumor', '#FF0000');
    component.labelColors.set('normal', '#0000FF');
    component.selectedLabelColor = 'tumor';

    component.changeShapeColor({ value: '#00FF00' });
    expect(component.regions[0].color).toBe('#00FF00');
    expect(component.regions[1].color).toBe('#0000FF');
  });

  it('live-edit: every region change immediately calls plotService.setRegions with isRegionSaveOn=true', () => {
    const setRegionsSpy = mockVisualizer.setAnnotationRegions as jest.Mock;
    setRegionsSpy.mockClear();
    component.addRectangle();
    expect(setRegionsSpy).toHaveBeenCalled();
    const lastCall = setRegionsSpy.mock.calls[setRegionsSpy.mock.calls.length - 1];
    // Signature: setRegions(regions, showLabel, isRegionSaveOn, fillColor, append?)
    expect(lastCall[2]).toBe(true);
  });

  it('table → plot: onSelectionChanged pushes the selected regions to the contract', () => {
    component.addRectangle();
    component.addRectangle();
    component.addRectangle();
    const spy = mockVisualizer.setSelectedRegions as jest.Mock;
    spy.mockClear();
    component.selectedRegions = [component.regions[0], component.regions[2]];
    component.onSelectionChanged();
    expect(spy).toHaveBeenCalledWith([component.regions[0], component.regions[2]]);
  });

  it('table → plot: clearing the selection emits an empty index array', () => {
    component.addRectangle();
    const spy = mockVisualizer.setSelectedRegions as jest.Mock;
    spy.mockClear();
    component.selectedRegions = [];
    component.onSelectionChanged();
    expect(spy).toHaveBeenCalledWith([]);
  });

  it('deleteSelectedRegions removes every selected region and clears the plot selection', () => {
    component.addRectangle();
    component.addRectangle();
    component.addRectangle();
    component.selectedRegions = [component.regions[0], component.regions[2]];
    const setSelSpy = mockVisualizer.setSelectedRegions as jest.Mock;
    setSelSpy.mockClear();
    component.deleteSelectedRegions();
    expect(component.regions.length).toBe(1);
    expect(component.selectedRegions.length).toBe(0);
    // Last call to setSelectedShapeIndices clears the plot's highlight.
    expect(setSelSpy.mock.calls[setSelSpy.mock.calls.length - 1][0]).toEqual([]);
  });

  it('deleteRegion drops the deleted region from selectedRegions and re-syncs', () => {
    component.addRectangle();
    component.addRectangle();
    component.addRectangle();
    component.selectedRegions = [component.regions[0], component.regions[2]];
    const setSelSpy = mockVisualizer.setSelectedRegions as jest.Mock;
    setSelSpy.mockClear();
    // Delete index 0 — also removes it from selectedRegions.
    component.deleteRegion(0);
    expect(component.regions.length).toBe(2);
    expect(component.selectedRegions.length).toBe(1);
    // The remaining selected region (formerly at index 2) is now at index 1.
    const lastCall = setSelSpy.mock.calls[setSelSpy.mock.calls.length - 1][0];
    expect(lastCall).toEqual([component.regions[1]]);
  });

  it('should update label colors when label is edited', () => {
    component.addRectangle();
    component.regions[0].label = 'tissue';
    component.labelRegionUpdate(component.regions[0]);
    expect(component.labelColors.has('tissue')).toBe(true);
  });

  it('should show help dialog', () => {
    expect(component.displayHelpDialog).toBe(false);
    component.showHelp();
    expect(component.displayHelpDialog).toBe(true);
  });

  it('should stop arrow key propagation', () => {
    const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
    const spy = jest.spyOn(event, 'stopPropagation');
    component.disableArrowKeys(event);
    expect(spy).toHaveBeenCalled();
  });

  it('should not stop non-arrow key propagation', () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter' });
    const spy = jest.spyOn(event, 'stopPropagation');
    component.disableArrowKeys(event);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('RegionEditorComponent with shapes', () => {
  let component: RegionEditorComponent;
  let fixture: ComponentFixture<RegionEditorComponent>;

  const mockShapes = [
    {
      name: 'shape0',
      type: 'rect',
      x0: 100, y0: 200, x1: 612, y1: 714,
      line: { color: '#FF0000' },
      legend: 'tumor'
    },
    {
      name: 'shape1',
      type: 'path',
      path: 'M10,20L30,40L50,60Z',
      line: { color: '#00FF00' },
      legend: 'normal'
    },
    {
      name: 'shape2',
      type: 'rect',
      x0: 0, y0: 0, x1: 512, y1: 512,
      line: {},
      legend: undefined
    }
  ];

  describe('Class cell editing', () => {
    let region: Region;

    beforeEach(() => {
      region = new Region();
      region.name = 'shape0';
      region.label = 'legend';
      region.bounds = new Rectangle();
      component.regions = [region];
    });

    it('isEditingLabel returns false by default', () => {
      expect(component.isEditingLabel(region)).toBe(false);
    });

    it('startEditLabel adds the region to the editing set and stops event propagation', () => {
      const event = { stopPropagation: jest.fn() } as unknown as Event;
      component.startEditLabel(region, event);

      expect(component.isEditingLabel(region)).toBe(true);
      expect(component.editingLabelRegions.has(region)).toBe(true);
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('startEditLabel works without an event argument', () => {
      expect(() => component.startEditLabel(region)).not.toThrow();
      expect(component.isEditingLabel(region)).toBe(true);
    });

    it('startEditLabel can track multiple regions independently', () => {
      const r2 = new Region();
      r2.name = 'shape1';
      r2.label = 'other';
      component.regions = [region, r2];

      component.startEditLabel(region);
      component.startEditLabel(r2);

      expect(component.isEditingLabel(region)).toBe(true);
      expect(component.isEditingLabel(r2)).toBe(true);
      expect(component.editingLabelRegions.size).toBe(2);
    });

    it('stopEditLabel(commit=false) removes the region without calling labelRegionUpdate', () => {
      const event = { stopPropagation: jest.fn() } as unknown as Event;
      component.startEditLabel(region);
      const spy = jest.spyOn(component, 'labelRegionUpdate');

      component.stopEditLabel(region, false, event);

      expect(component.isEditingLabel(region)).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('stopEditLabel(commit=true) removes the region and commits the edit', () => {
      component.startEditLabel(region);
      const spy = jest.spyOn(component, 'labelRegionUpdate');

      component.stopEditLabel(region, true);

      expect(component.isEditingLabel(region)).toBe(false);
      expect(spy).toHaveBeenCalledWith(region, true);
    });

    it('stopEditLabel is a no-op (for the set) if the region is not in edit mode', () => {
      expect(component.isEditingLabel(region)).toBe(false);
      expect(() => component.stopEditLabel(region, false)).not.toThrow();
      expect(component.editingLabelRegions.size).toBe(0);
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
      getAnnotationRegions: () => mockShapes.map(s => Object.assign(new ShapeSelection(), s as any).getRegion()),
      setAnnotationRegions: jest.fn(),
    });

    await TestBed.configureTestingModule({
      declarations: [RegionEditorComponent, HexColorPickerComponent],
      imports: [FormsModule],
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
          } as RegionIoPort,
        },
      ],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(RegionEditorComponent);
    component = fixture.componentInstance;
    component.ngOnInit();
  });

  it('should initialize regions from rect shapes', () => {
    expect(component.regions.length).toBe(3);
    const rect = component.regions[0].bounds as Rectangle;
    expect(rect.x).toBe(100);
    expect(rect.y).toBe(200);
    expect(rect.width).toBe(512);
    expect(rect.height).toBe(514);
  });

  it('should initialize regions from path shapes', () => {
    const poly = component.regions[1].bounds as Polygon;
    expect(poly.coordinates.length).toBe(3);
    expect(poly.coordinates[0]).toEqual([10, 20]);
    expect(poly.xpoints).toEqual([10, 30, 50]);
    expect(poly.ypoints).toEqual([20, 40, 60]);
    expect(poly.closed).toBe(true);
  });

  it('should set region color from shape line color', () => {
    expect(component.regions[0].color).toBe('#FF0000');
    expect(component.regions[1].color).toBe('#00FF00');
  });

  it('should fall back to shapeColor when line color is missing', () => {
    expect(component.regions[2].color).toBe('#00FFFF');
  });

  it('should set region labels from shape legend', () => {
    expect(component.regions[0].label).toBe('tumor');
    expect(component.regions[1].label).toBe('normal');
  });

  it('should populate labelColors map from labeled regions', () => {
    expect(component.labelColors.get('tumor')).toBe('#FF0000');
    expect(component.labelColors.get('normal')).toBe('#00FF00');
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
      legend: 'annotation'
    }
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
        openPathShapes.map(s => Object.assign(new ShapeSelection(), s as any).getRegion()),
      setAnnotationRegions: jest.fn(),
    });

    await TestBed.configureTestingModule({
      declarations: [RegionEditorComponent, HexColorPickerComponent],
      imports: [FormsModule],
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
          } as RegionIoPort,
        },
      ],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(RegionEditorComponent);
    component = fixture.componentInstance;
    component.ngOnInit();
  });

  it('should initialize open polyline with closed=false', () => {
    expect(component.regions.length).toBe(1);
    const poly = component.regions[0].bounds as Polygon;
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
    });

    mockRegionIo = {
      getSelectedFileName: jest.fn(() => fakeSelectedFile.name),
      roiFileExists: jest.fn(() => of(false)),
      saveGeoJson: jest.fn(() => of(void 0)),
    } as unknown as RegionIoPort;

    mockMessageService = MockService(MessageService, {
      add: jest.fn(),
    });

    mockConfirmationService = MockService(ConfirmationService, {
      confirm: jest.fn(),
    });

    await TestBed.configureTestingModule({
      declarations: [RegionEditorComponent, HexColorPickerComponent],
      imports: [FormsModule],
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

    component.addRectangle();
  });

  // --- persistRegions (opens the save-as dialog) ---

  it('should open save-as dialog with default geojson filename', () => {
    component.persistRegions();

    expect(component.showSaveAsDialog).toBe(true);
    expect(component.saveAsFilename).toBe('slide_001.geojson');
    expect(component.saveAsFileExists).toBe(false);
  });

  it('should not open save-as dialog when no file is selected', () => {
    (mockRegionIo.getSelectedFileName as jest.Mock).mockReturnValue(undefined);

    component.persistRegions();

    expect(component.showSaveAsDialog).toBe(false);
  });

  it('should not open save-as dialog when there are no regions', () => {
    component.regions = [];

    component.persistRegions();

    expect(component.showSaveAsDialog).toBe(false);
  });

  // --- checkSaveAsFileExists (debounced existence check) ---

  it('should update saveAsFileExists to true when file exists', fakeAsync(() => {
    (mockRegionIo.roiFileExists as jest.Mock).mockReturnValue(of(true));

    component.saveAsFilename = 'slide_001.geojson';
    component.checkSaveAsFileExists();
    tick(500);

    expect(mockRegionIo.roiFileExists).toHaveBeenCalledWith('slide_001.geojson');
    expect(component.saveAsFileExists).toBe(true);
  }));

  it('should update saveAsFileExists to false when file does not exist', fakeAsync(() => {
    (mockRegionIo.roiFileExists as jest.Mock).mockReturnValue(of(false));

    component.saveAsFilename = 'new_name.geojson';
    component.checkSaveAsFileExists();
    tick(500);

    expect(component.saveAsFileExists).toBe(false);
  }));

  it('should debounce rapid existence checks', fakeAsync(() => {
    (mockRegionIo.roiFileExists as jest.Mock).mockReturnValue(of(false));

    component.saveAsFilename = 'a.geojson';
    component.checkSaveAsFileExists();
    tick(100);
    component.saveAsFilename = 'b.geojson';
    component.checkSaveAsFileExists();
    tick(100);
    component.saveAsFilename = 'c.geojson';
    component.checkSaveAsFileExists();
    tick(500);

    expect(mockRegionIo.roiFileExists).toHaveBeenCalledTimes(1);
    expect(mockRegionIo.roiFileExists).toHaveBeenCalledWith('c.geojson');
  }));

  it('should set saveAsFileExists to false on roiFileExist error', fakeAsync(() => {
    (mockRegionIo.roiFileExists as jest.Mock).mockReturnValue(throwError(() => new Error('network')));

    component.saveAsFileExists = true;
    component.saveAsFilename = 'slide_001.geojson';
    component.checkSaveAsFileExists();
    tick(500);

    expect(component.saveAsFileExists).toBe(false);
  }));

  // --- confirmSaveAs (save action) ---

  it('should save directly when file does not exist', () => {
    component.saveAsFilename = 'new_regions.geojson';
    component.saveAsFileExists = false;
    component.showSaveAsDialog = true;

    component.confirmSaveAs();

    expect(component.showSaveAsDialog).toBe(false);
    expect(mockRegionIo.saveGeoJson).toHaveBeenCalledWith(
      '{"type":"FeatureCollection","features":[]}',
      'new_regions.geojson',
    );
    expect(mockMessageService.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'success', detail: 'Saved as new_regions.geojson' }),
    );
  });

  it('should show overwrite confirmation when file exists', () => {
    component.saveAsFilename = 'existing.geojson';
    component.saveAsFileExists = true;
    component.showSaveAsDialog = true;

    component.confirmSaveAs();

    expect(component.showSaveAsDialog).toBe(false);
    expect(mockConfirmationService.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '"existing.geojson" already exists. Do you want to overwrite it?',
        header: 'Confirm Overwrite',
      }),
    );
    expect(mockRegionIo.saveGeoJson).not.toHaveBeenCalled();
  });

  it('should save after user accepts overwrite confirmation', () => {
    component.saveAsFilename = 'existing.geojson';
    component.saveAsFileExists = true;

    component.confirmSaveAs();

    const confirmCall = (mockConfirmationService.confirm as jest.Mock).mock.calls[0][0];
    confirmCall.accept();

    expect(mockRegionIo.saveGeoJson).toHaveBeenCalledWith(
      '{"type":"FeatureCollection","features":[]}',
      'existing.geojson',
    );
    expect(mockMessageService.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'success' }),
    );
  });

  it('should show error toast when save fails', () => {
    (mockRegionIo.saveGeoJson as jest.Mock).mockReturnValue(
      throwError(() => new Error('Server error')),
    );
    component.saveAsFilename = 'regions.geojson';
    component.saveAsFileExists = false;

    component.confirmSaveAs();

    expect(mockMessageService.add).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        summary: 'Error saving regions',
        detail: 'Server error',
      }),
    );
  });

  it('should not save when filename is empty', () => {
    component.saveAsFilename = '   ';
    component.confirmSaveAs();

    expect(mockRegionIo.saveGeoJson).not.toHaveBeenCalled();
    expect(mockConfirmationService.confirm).not.toHaveBeenCalled();
  });

  it('should not save when no file is selected', () => {
    (mockRegionIo.getSelectedFileName as jest.Mock).mockReturnValue(undefined);
    component.saveAsFilename = 'test.geojson';

    component.confirmSaveAs();

    expect(mockRegionIo.saveGeoJson).not.toHaveBeenCalled();
  });

  it('should pass custom filename to saveGeoJson', () => {
    component.saveAsFilename = 'my_custom_name.geojson';
    component.saveAsFileExists = false;

    component.confirmSaveAs();

    expect(mockRegionIo.saveGeoJson).toHaveBeenCalledWith(
      expect.any(String),
      'my_custom_name.geojson',
    );
  });

  it('should trigger initial existence check when dialog opens', fakeAsync(() => {
    (mockRegionIo.roiFileExists as jest.Mock).mockReturnValue(of(true));

    component.persistRegions();
    tick(500);

    expect(mockRegionIo.roiFileExists).toHaveBeenCalledWith('slide_001.geojson');
    expect(component.saveAsFileExists).toBe(true);
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
    });

    mockRegionIo = {
      getSelectedFileName: jest.fn(() => fakeSelectedFile.name),
      roiFileExists: jest.fn(() => of(false)),
      saveGeoJson: jest.fn(() => of(void 0)),
    } as unknown as RegionIoPort;

    await TestBed.configureTestingModule({
      declarations: [RegionEditorComponent, HexColorPickerComponent],
      imports: [FormsModule],
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

    component.addRectangle();
  });

  // --- exportRois (opens the export dialog) ---

  it('should open export dialog with default filename from selected image', () => {
    component.exportRois();

    expect(component.showExportDialog).toBe(true);
    expect(component.exportFilename).toBe('slide_001.geojson');
  });

  it('should default to rois.geojson when no file is selected', () => {
    (mockRegionIo.getSelectedFileName as jest.Mock).mockReturnValue(undefined);

    component.exportRois();

    expect(component.showExportDialog).toBe(true);
    expect(component.exportFilename).toBe('rois.geojson');
  });

  it('should not open export dialog when there are no regions', () => {
    component.regions = [];

    component.exportRois();

    expect(component.showExportDialog).toBe(false);
  });

  // --- confirmExport (download action) ---

  it('should download geojson with the chosen filename', () => {
    component.exportFilename = 'my_export.geojson';
    component.showExportDialog = true;

    component.confirmExport();

    expect(component.showExportDialog).toBe(false);
    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob), 'my_export.geojson');
    const blob: Blob = (saveAs as unknown as jest.Mock).mock.calls[0][0];
    expect(blob.type).toBe('application/json');
  });

  it('should use custom filename entered by user', () => {
    component.exportFilename = 'custom_regions.geojson';

    component.confirmExport();

    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob), 'custom_regions.geojson');
  });

  it('should not download when filename is empty', () => {
    component.exportFilename = '   ';

    component.confirmExport();

    expect(saveAs).not.toHaveBeenCalled();
  });

  it('should not download when there are no regions', () => {
    component.regions = [];
    component.exportFilename = 'test.geojson';

    component.confirmExport();

    expect(saveAs).not.toHaveBeenCalled();
  });

  it('should trim whitespace from filename before downloading', () => {
    component.exportFilename = '  padded_name.geojson  ';

    component.confirmExport();

    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob), 'padded_name.geojson');
  });

  it('should close the dialog on confirm', () => {
    component.exportFilename = 'test.geojson';
    component.showExportDialog = true;

    component.confirmExport();

    expect(component.showExportDialog).toBe(false);
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

    await TestBed.configureTestingModule({
      declarations: [RegionEditorComponent, HexColorPickerComponent],
      imports: [FormsModule],
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
          } as RegionIoPort,
        },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    component = TestBed.createComponent(RegionEditorComponent).componentInstance;
    component.ngOnInit();
  });

  function rect(): Region {
    const r = new Region(); r.id = 1;
    const b = new Rectangle(); b.x = 10; b.y = 20; b.width = 30; b.height = 40;
    r.bounds = b; return r;
  }
  function poly(): Region {
    const r = new Region(); r.id = 2;
    const p = new Polygon();
    p.xpoints = [0, 10, 10, 0]; p.ypoints = [0, 0, 10, 10];
    p.coordinates = [[0, 0], [10, 0], [10, 10], [0, 10]]; p.npoints = 4; p.closed = true;
    r.bounds = p; return r;
  }

  it('xRectUpdate / yRectUpdate set the rectangle origin and commit', () => {
    const r = rect();
    (component as any).regions = [r];
    component.xRectUpdate(r, { value: 99 });
    component.yRectUpdate(r, { value: 88 });
    expect((r.bounds as Rectangle).x).toBe(99);
    expect((r.bounds as Rectangle).y).toBe(88);
    expect(api.setAnnotationRegions).toHaveBeenCalled();
  });

  it('widthRectUpdate recenters x by half the width delta', () => {
    const r = rect();
    (component as any).regions = [r];
    (component as any).regionsCopy = [{ id: 1, bounds: { x: 10, y: 20, width: 30, height: 40 } }];
    component.widthRectUpdate(r, { value: 50 }); // diff +20 → x = round(10 - 10) = 0
    expect((r.bounds as Rectangle).width).toBe(50);
    expect((r.bounds as Rectangle).x).toBe(0);
  });

  it('heightRectUpdate recenters y by half the height delta', () => {
    const r = rect();
    (component as any).regions = [r];
    (component as any).regionsCopy = [{ id: 1, bounds: { x: 10, y: 20, width: 30, height: 40 } }];
    component.heightRectUpdate(r, { value: 60 }); // diff +20 → y = round(20 - 10) = 10
    expect((r.bounds as Rectangle).height).toBe(60);
    expect((r.bounds as Rectangle).y).toBe(10);
  });

  it('widthRectUpdate ignores null/undefined values', () => {
    const r = rect();
    (component as any).regions = [r];
    component.widthRectUpdate(r, { value: null });
    expect((r.bounds as Rectangle).width).toBe(30); // unchanged
  });

  it('regionArea reports px² for rect + polygon, blank when degenerate', () => {
    expect(component.regionArea(rect())).toContain('px²'); // 30·40 = 1200
    expect(component.regionArea(poly())).toContain('px²'); // shoelace = 100
    const degenerate = rect(); (degenerate.bounds as Rectangle).width = 0;
    expect(component.regionArea(degenerate)).toBe('');
  });

  it('regionArea reports physical units when mpp is known', () => {
    (component as any).mppX = 2; (component as any).mppY = 2;
    expect(component.regionArea(rect())).toContain('µm²'); // 1200·4 = 4800 µm²
  });

  it('pickMpp reads calibration off a non-[0] entry and squares a single axis', () => {
    const pick = (m: any) => (component as any).pickMpp(m);
    // Calibration on entry 1 (entry 0 unscaled) — must not be missed.
    expect(pick([{ mppX: 0, mppY: 0 }, { mppX: 0.5, mppY: 0.5 }]))
      .toEqual({ mppX: 0.5, mppY: 0.5 });
    // Only mppX reported → square pixels (mppY = mppX), so it still shows µm².
    expect(pick([{ mppX: 0.25 }])).toEqual({ mppX: 0.25, mppY: 0.25 });
    // Genuinely unscaled → undefined → px².
    expect(pick([{ mppX: 0, mppY: 0 }])).toEqual({ mppX: undefined, mppY: undefined });
    expect(pick(undefined)).toEqual({ mppX: undefined, mppY: undefined });
  });

  it('regionArea uses physical units when calibration is on a non-[0] entry', () => {
    const { mppX, mppY } = (component as any).pickMpp([{ mppX: 0 }, { mppX: 2, mppY: 2 }]);
    (component as any).mppX = mppX;
    (component as any).mppY = mppY;
    expect(component.regionArea(rect())).toContain('µm²'); // would have been px² before
  });

  it('applyColorToSelected recolours every selected region and commits', () => {
    const a = poly(); const b = rect();
    (component as any).regions = [a, b];
    component.selectedRegions = [a, b];
    const spy = api.setAnnotationRegions as jest.Mock;
    spy.mockClear();
    component.selectedColor = '#abcdef';
    component.applyColorToSelected();
    expect(a.color).toBe('#abcdef');
    expect(b.color).toBe('#abcdef');
    expect(spy).toHaveBeenCalled();
    expect(component.showColorDialog).toBe(false);
  });

  it('openColorDialog seeds the picker from the first selected region', () => {
    const a = poly(); a.color = '#112233';
    component.selectedRegions = [a];
    component.openColorDialog();
    expect(component.selectedColor).toBe('#112233');
    expect(component.showColorDialog).toBe(true);
  });

  it('selectAllRegions selects every row and syncs the plot', () => {
    (component as any).regions = [poly(), rect()];
    const spy = api.setSelectedRegions as jest.Mock;
    spy.mockClear();
    component.selectAllRegions();
    expect(component.selectedRegions.length).toBe(2);
    expect(spy).toHaveBeenCalled();
  });

  it('changeRegionColor sets the region colour and commits live — jit-ui#85', () => {
    const r = poly();
    (component as any).regions = [r];
    const spy = api.setAnnotationRegions as jest.Mock;
    spy.mockClear();
    component.changeRegionColor(r, '#abcdef');
    expect(r.color).toBe('#abcdef');
    expect(spy).toHaveBeenCalled();
  });

  it('changeRegionColor is a no-op when the colour is unchanged', () => {
    const r = poly(); r.color = '#123456';
    (component as any).regions = [r];
    const spy = api.setAnnotationRegions as jest.Mock;
    spy.mockClear();
    component.changeRegionColor(r, '#123456');
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
    expect(component.regionArea(r)).toBe('125 px²');
  });

  it('regionArea subtracts hole area (donut, not filled circle) — jit-ui#85', () => {
    const donut = poly(); // 10×10 exterior = 100
    (donut.bounds as Polygon).holes = [[[3, 3], [7, 3], [7, 7], [3, 7]]]; // 4×4 hole = 16
    expect(component.regionArea(donut)).toBe('84 px²'); // 100 − 16
  });

  it('isRectangle distinguishes rectangles from polygons', () => {
    expect(component.isRectangle(rect())).toBe(true);
    expect(component.isRectangle(poly())).toBe(false);
  });

  it('label-edit lifecycle tracks the editing set and commits on stop', () => {
    const r = rect();
    (component as any).regions = [r];
    expect(component.isEditingLabel(r)).toBe(false);
    component.startEditLabel(r);
    expect(component.isEditingLabel(r)).toBe(true);
    component.stopEditLabel(r, true); // commit
    expect(component.isEditingLabel(r)).toBe(false);
    expect(api.setAnnotationRegions).toHaveBeenCalled();
  });
});
