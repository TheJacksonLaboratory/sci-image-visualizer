import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { Component, NO_ERRORS_SCHEMA } from '@angular/core';
import { EventEmitter } from '@angular/core';

import { ToolbarComponent } from './toolbar.component';
import { PlotType, PlotTypeId } from '../contracts/plot-type';
import { ToolbarDialogToolContribution } from '../contracts/toolbar-tool.contract';

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

  it('uses OnPush change detection (RT-35)', () => {
    expect((ToolbarComponent as unknown as { ɵcmp: { onPush: boolean } }).ɵcmp.onPush).toBe(true);
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('offers the plot modes for a spatial dataset that brings no image', () => {
    // jit-ui opening a Xenium zip: no image loaded, but Spatial omics is still a choice.
    component.imageInfo = undefined;
    component.hasSpatialDataset = false;
    expect(component.showPlotTypes).toBe(false);
    component.hasSpatialDataset = true;
    expect(component.showPlotTypes).toBe(true);
  });

  it('isImageView is true only for the Image plot type', () => {
    component.selectedPlotType = PlotType.IMAGE;
    expect(component.isImageView).toBe(true);
    component.selectedPlotType = PlotType.HEATMAP;
    expect(component.isImageView).toBe(false);
  });

  it('a contributed plot mode gets exactly its base type\'s tools', () => {
    component.selectedPlotType = 'dianne';
    component.basePlotType = PlotType.IMAGE;
    expect(component.effectivePlotType).toBe(PlotType.IMAGE);
    expect(component.isImageView).toBe(true);
    expect(component.supportsRegionVertexTools).toBe(true);
    expect(component.showsLiveSliceScrubber).toBe(true);
    expect(component.isIntensityCapable).toBe(true);
    expect(component.isNapariMode).toBe(false);
    // Unbound base: a non-built-in selection is treated as the default Image view.
    component.basePlotType = null;
    expect(component.effectivePlotType).toBe(PlotType.IMAGE);
    component.selectedPlotType = PlotType.HEATMAP;
    expect(component.effectivePlotType).toBe(PlotType.HEATMAP);
  });

  // isPiIcon is covered in plot-type-selector.component.spec.ts.

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
    const seen: PlotTypeId[] = [];
    component.selectPlotType.subscribe((t) => seen.push(t));
    component.selectPlotType.emit(PlotType.SURFACE);
    expect(seen).toEqual([PlotType.SURFACE]);
  });

  it('renders a p-toolbar', () => {
    const toolbar = fixture.nativeElement.querySelector('p-toolbar');
    expect(toolbar).toBeTruthy();
  });

  // The SAM / contributed-tool model menus are covered in segmentation-tools.component.spec.ts.

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

describe('ToolbarComponent — dialog tools', () => {
  @Component({
    template: `
      <plotting-toolbar [selectedPlotType]="type" [dialogTools]="dialogTools"
                        [openDialogToolId]="openId" (toggleDialogTool)="toggled.push($event)">
        <button class="host-pipeline">pipeline</button>
      </plotting-toolbar>`,
  })
  class HostComponent {
    type: PlotTypeId = PlotType.IMAGE;
    openId: string | null = null;
    toggled: string[] = [];
    dialogTools: ToolbarDialogToolContribution[] = [{
      kind: 'dialog', id: 'dianne', label: 'DIANNE', icon: { pi: 'pi-pencil' },
      tooltip: 'Digital Pathology - DIANNE',
      activate: () => ({ deactivate: () => undefined }),
      mount: () => () => undefined,
    }];
  }

  let fixture: ComponentFixture<HostComponent>;
  // Only a dialog tool's button carries aria-pressed.
  const button = (): HTMLElement | null => fixture.nativeElement.querySelector('p-button[aria-pressed]');

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ToolbarComponent, HostComponent],
      imports: [FormsModule],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  it('shows the button in the Image view, right after the host\'s own buttons', () => {
    const b = button();
    expect(b).not.toBeNull();
    const pipeline = fixture.nativeElement.querySelector('.host-pipeline') as HTMLElement;
    // Next element after the projected host content is the dialog tool.
    expect(pipeline.nextElementSibling).toBe(b);
    expect(b!.querySelector('i.pi-pencil')).not.toBeNull();
  });

  it('gives the icon-only button an accessible name', () => {
    const de = fixture.debugElement.query((d) => d.nativeElement === button());
    expect(de.properties['ariaLabel']).toBe('DIANNE');
  });

  it('hides it outside the Image view', () => {
    fixture.componentInstance.type = PlotType.HEATMAP;
    fixture.detectChanges();
    expect(button()).toBeNull();
  });

  it('marks it pressed while its dialog is open, and emits its id on click', () => {
    expect(button()!.getAttribute('aria-pressed')).toBe('false');
    fixture.componentInstance.openId = 'dianne';
    fixture.detectChanges();
    expect(button()!.getAttribute('aria-pressed')).toBe('true');

    button()!.dispatchEvent(new CustomEvent('onClick'));
    expect(fixture.componentInstance.toggled).toEqual(['dianne']);
  });
});
