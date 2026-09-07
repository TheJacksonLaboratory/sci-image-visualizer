import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { EventEmitter } from '@angular/core';

import { ToolbarComponent } from './toolbar.component';
import { PlotType } from '../contracts/plot-type';
import { ToolbarToolContribution } from '../contracts/toolbar-tool.contract';

/** A contributed tool with two checkpoints, enough to exercise the menu. */
function contributedTool(): ToolbarToolContribution {
  return {
    id: 'detect',
    label: 'Detect',
    icon: { pi: 'pi-search' },
    runTooltip: 'Detect things',
    models: () => [
      { id: 'model-a', label: 'A', info: 'the first one' },
      { id: 'model-b', label: 'B', info: 'the second one' },
    ],
    defaultModelId: () => 'model-a',
    params: [],
    defaultParams: () => ({}),
    progress: { status$: null as never, busy$: null as never, progress$: null as never },
    run: async () => 0,
  };
}

describe('ToolbarComponent', () => {
  let component: ToolbarComponent;
  let fixture: ComponentFixture<ToolbarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ToolbarComponent],
      imports: [FormsModule],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(ToolbarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('isImageView is true only for the Image plot type', () => {
    component.selectedPlotType = PlotType.IMAGE;
    expect(component.isImageView).toBe(true);
    component.selectedPlotType = PlotType.HEATMAP;
    expect(component.isImageView).toBe(false);
  });

  it('isPiIcon distinguishes PrimeNG glyphs from SVG asset paths', () => {
    expect(component.isPiIcon('pi pi-image')).toBe(true);
    expect(component.isPiIcon('assets/plotting/surface.svg')).toBe(false);
    expect(component.isPiIcon(undefined)).toBe(false);
  });

  it('isIsosurfaceMode is true only for the Isosurface plot type', () => {
    component.selectedPlotType = PlotType.ISOSURFACE;
    expect(component.isIsosurfaceMode).toBe(true);
    component.selectedPlotType = PlotType.HEATMAP;
    expect(component.isIsosurfaceMode).toBe(false);
  });

  it('showsLiveSliceScrubber for the live-scrub views incl. the napari surface (stack slider)', () => {
    // The 2D spatial view scrubs too: over a 3D dataset the registered volume IS
    // the image, and the slider picks the section whose observations are drawn.
    for (const t of [
      PlotType.IMAGE, PlotType.NAPARI_IMAGE, PlotType.NAPARI_SURFACE, PlotType.SPATIAL_OMICS,
    ]) {
      component.selectedPlotType = t;
      expect(component.showsLiveSliceScrubber).toBe(true);
    }
    // Volume/isosurface render the whole stack at once — no per-slice scrubber —
    // and the 3D cloud has no plane to pick.
    for (const t of [
      PlotType.NAPARI_VOLUME, PlotType.NAPARI_ISOSURFACE, PlotType.HEATMAP,
      PlotType.SPATIAL_OMICS_3D,
    ]) {
      component.selectedPlotType = t;
      expect(component.showsLiveSliceScrubber).toBe(false);
    }
  });

  it('isNapariSurfaceMode is true only for the napari surface, isNapari3dMode for all napari 3D', () => {
    component.selectedPlotType = PlotType.NAPARI_SURFACE;
    expect(component.isNapariSurfaceMode).toBe(true);
    for (const t of [PlotType.NAPARI_VOLUME, PlotType.SURFACE, PlotType.NAPARI_IMAGE]) {
      component.selectedPlotType = t;
      expect(component.isNapariSurfaceMode).toBe(false);
    }
    // The Resolution control shows for every napari 3D type.
    for (const t of [PlotType.NAPARI_VOLUME, PlotType.NAPARI_ISOSURFACE, PlotType.NAPARI_SURFACE]) {
      component.selectedPlotType = t;
      expect(component.isNapari3dMode).toBe(true);
    }
    component.selectedPlotType = PlotType.NAPARI_IMAGE;
    expect(component.isNapari3dMode).toBe(false);
  });

  it('showHelp opens the help dialog', () => {
    expect(component.displayHelpDialog).toBe(false);
    component.showHelp();
    expect(component.displayHelpDialog).toBe(true);
  });

  it('exposes the toolbar actions as outputs', () => {
    expect(component.selectPlotType).toBeInstanceOf(EventEmitter);
    expect(component.toggleDragMode).toBeInstanceOf(EventEmitter);
    expect(component.deleteRegion).toBeInstanceOf(EventEmitter);
    expect(component.autoscaleImage).toBeInstanceOf(EventEmitter);
  });

  it('emits the chosen plot type to the host', () => {
    const seen: PlotType[] = [];
    component.selectPlotType.subscribe((t) => seen.push(t));
    component.selectPlotType.emit(PlotType.SURFACE);
    expect(seen).toEqual([PlotType.SURFACE]);
  });

  it('renders a p-toolbar', () => {
    const toolbar = fixture.nativeElement.querySelector('p-toolbar');
    expect(toolbar).toBeTruthy();
  });

  it('carries each SAM model description on its menu item as `tooltip`', () => {
    component.samModels = [{ id: 'microsam-vit-t-lm', label: 'micro-sam ViT-T' }];
    component.samModelId = 'microsam-vit-t-lm';
    component.ngOnChanges({ samModels: {} as never });

    // The item template turns `tooltip` into the hover info icon, so an empty
    // one would silently drop the icon rather than fail.
    expect(component.samMenuItems[0].tooltip).toContain('TinyViT');
    // Active model still marked, and selecting still emits.
    expect(component.samMenuItems[0].icon).toBe('pi pi-check');
  });

  it('builds a contributed tool\'s menu from the tool\'s own model info', () => {
    // Contributed tools describe their own checkpoints: this library ships no
    // copy for models it does not know about, so the description must come off
    // the contribution rather than out of MODEL_INFO.
    component.contributedTools = [contributedTool()];
    component.toolModelIds = { detect: 'model-b' };
    component.ngOnChanges({ contributedTools: {} as never });

    const items = component.toolMenuItems['detect']!;
    expect(items[0].tooltip).toContain('the first one');
    expect(items[1].icon).toBe('pi pi-check');
    expect(items[0].icon).toBe('pi pi-fw');
  });

  it('emits the tool id alongside the model when a contributed model is picked', () => {
    // Without the id the host cannot tell which tool's parameters to re-seed.
    component.contributedTools = [contributedTool()];
    component.ngOnChanges({ contributedTools: {} as never });
    const picked: { toolId: string; modelId: string }[] = [];
    component.toolModelChange.subscribe((e) => picked.push(e));

    component.toolMenuItems['detect']![1].command!({} as never);

    expect(picked).toEqual([{ toolId: 'detect', modelId: 'model-b' }]);
  });

  it('leaves `tooltip` undefined for a model with no description', () => {
    component.samModels = [{ id: 'some-unregistered-model', label: 'Unknown' }];
    component.ngOnChanges({ samModels: {} as never });
    expect(component.samMenuItems[0].tooltip).toBeUndefined();
  });
  describe('spatial-omics controls button', () => {
    it('offers the panel in BOTH spatial modes', () => {
      // REGRESSION: the gate matched only the 2D type, so adding the 3D mode left
      // its toolbar button hidden — and with it the only route to the legend,
      // colouring and category selection. The 3D cloud needs that panel more than
      // the 2D view does, not less: a million overlapping points are unreadable
      // without a colour source.
      component.selectedPlotType = PlotType.SPATIAL_OMICS;
      expect(component.isSpatialMode).toBe(true);

      component.selectedPlotType = PlotType.SPATIAL_OMICS_3D;
      expect(component.isSpatialMode).toBe(true);
    });

    it('hides it for every non-spatial mode', () => {
      for (const t of [PlotType.IMAGE, PlotType.NAPARI_VOLUME, PlotType.SCATTER]) {
        component.selectedPlotType = t;
        expect(component.isSpatialMode).toBe(false);
      }
    });
  });
});

describe('ToolbarComponent — model info accessibility', () => {
  it('strips markup so a screen reader does not announce tags', () => {
    // The copy is written for a visual tooltip rendered with [escape]="false",
    // so it carries <b> and <br>. Passed to aria-label verbatim those get read
    // out literally.
    const c = new ToolbarComponent();

    const out = c.plainText('<b>VNet 2D</b><br>~590&nbsp;MB download &amp; 6&times; slower.');

    expect(out).toBe('VNet 2D. ~590 MB download & 6x slower.');
    expect(out).not.toMatch(/[<>]/);
  });

  it('survives an empty or missing description', () => {
    const c = new ToolbarComponent();
    expect(c.plainText('')).toBe('');
    expect(c.plainText(undefined as never)).toBe('');
  });
});
