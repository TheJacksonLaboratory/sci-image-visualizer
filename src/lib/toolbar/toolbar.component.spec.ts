import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { EventEmitter } from '@angular/core';

import { ToolbarComponent } from './toolbar.component';
import { PlotType } from '../contracts/plot-type';

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

  it('isIsosurfaceMode is true only for the Isosurface plot type', () => {
    component.selectedPlotType = PlotType.ISOSURFACE;
    expect(component.isIsosurfaceMode).toBe(true);
    component.selectedPlotType = PlotType.HEATMAP;
    expect(component.isIsosurfaceMode).toBe(false);
  });

  it('showsLiveSliceScrubber for the live-scrub views incl. the napari surface (stack slider)', () => {
    for (const t of [PlotType.IMAGE, PlotType.NAPARI_IMAGE, PlotType.NAPARI_SURFACE]) {
      component.selectedPlotType = t;
      expect(component.showsLiveSliceScrubber).toBe(true);
    }
    // Volume/isosurface render the whole stack at once — no per-slice scrubber.
    for (const t of [PlotType.NAPARI_VOLUME, PlotType.NAPARI_ISOSURFACE, PlotType.HEATMAP]) {
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
});
