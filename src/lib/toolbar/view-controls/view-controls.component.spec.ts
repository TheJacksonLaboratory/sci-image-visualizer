import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { VisualizationModule } from '../../visualization.module';
import { ViewControlsComponent } from './view-controls.component';

describe('ViewControlsComponent', () => {
  let fixture: ComponentFixture<ViewControlsComponent>;
  const labels = () =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('p-button button')).map((b) =>
      b.getAttribute('aria-label'),
    );

  beforeEach(async () => {
    // jsdom can't parse PrimeNG's component stylesheets; drop just that noise.
    const consoleError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) consoleError(...args);
    });
    await TestBed.configureTestingModule({
      imports: [VisualizationModule, NoopAnimationsModule],
    }).compileComponents();
    fixture = TestBed.createComponent(ViewControlsComponent);
  });

  afterEach(() => {
    fixture.destroy();
    jest.restoreAllMocks();
  });

  it('2D: the zoom tools, drag-zoom only outside the Image view', () => {
    fixture.detectChanges();
    expect(labels()).toEqual(['Zoom box', 'Pan the image', 'Zoom in', 'Zoom out']);
    fixture.componentRef.setInput('isImageView', false);
    fixture.detectChanges();
    expect(labels()[0]).toBe('Zoom drag');
    fixture.componentRef.setInput('zoomTools', false);
    fixture.detectChanges();
    expect(labels()).toEqual([]);
  });

  it('3D: camera modes, and the napari axes / wireframe toggles', () => {
    fixture.componentRef.setInput('isHeatmap', false);
    fixture.componentRef.setInput('isNapariMode', true);
    fixture.componentRef.setInput('isNapariSurfaceMode', true);
    fixture.detectChanges();
    expect(labels()).toEqual([
      'Zoom',
      'Pan',
      'Orbital rotation',
      'Turntable rotation',
      'Reset camera',
      'Toggle 3D axes',
      'Toggle wireframe',
    ]);
    const modes: string[] = [];
    fixture.componentInstance.toggleSurface3dMode.subscribe((m) => modes.push(m));
    (
      (fixture.nativeElement as HTMLElement).querySelector('button[aria-label="Orbital rotation"]') as HTMLElement
    ).click();
    expect(modes).toEqual(['orbit']);
  });
});
