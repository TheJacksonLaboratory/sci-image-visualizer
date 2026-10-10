import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { VisualizationModule } from '../../visualization.module';
import { RegionToolsComponent } from './region-tools.component';
import { REGION_TOOL_BUTTONS } from './region-tool-buttons';
import { ToolSliderComponent } from '../tool-slider/tool-slider.component';

describe('RegionToolsComponent', () => {
  let fixture: ComponentFixture<RegionToolsComponent>;
  let tools: RegionToolsComponent;
  const el = () => fixture.nativeElement as HTMLElement;
  const labels = () => Array.from(el().querySelectorAll('p-button button'))
    .map((b) => b.getAttribute('aria-label'));

  beforeEach(async () => {
    // jsdom can't parse PrimeNG's component stylesheets; drop just that noise.
    const consoleError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) consoleError(...args);
    });
    await TestBed.configureTestingModule({ imports: [VisualizationModule, NoopAnimationsModule] })
      .compileComponents();
    fixture = TestBed.createComponent(RegionToolsComponent);
    tools = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => { fixture.destroy(); jest.restoreAllMocks(); });

  it('every button has an accessible name; the table drives the drawing tools', () => {
    expect(labels().every((l) => !!l)).toBe(true);
    expect(labels()).toEqual(['Open the Region Editor',
      ...REGION_TOOL_BUTTONS.filter((b) => b.gate !== 'vertex').map((b) => b.label),
      'Undo', 'Redo', 'Delete selected region']);
  });

  it('gates the vertex tools on the backend and the brush / polyline on 3D', () => {
    fixture.componentRef.setInput('vertexTools', true);
    fixture.detectChanges();
    expect(labels()).toContain('Add a vertex');
    fixture.componentRef.setInput('is3dRegions', true);
    fixture.detectChanges();
    expect(labels()).not.toContain('Brush');
    expect(labels()).not.toContain('Draw a polyline');
  });

  it('a tool button toggles its mode; the active tool shows its slider', () => {
    const toggled: string[] = [];
    tools.toggleDragMode.subscribe((m) => toggled.push(m));
    (el().querySelector('button[aria-label="Wand"]') as HTMLButtonElement).click();
    expect(toggled).toEqual(['wand']);

    fixture.componentRef.setInput('activeDragMode', 'wand');
    fixture.componentRef.setInput('wandSensitivity', 3.25);
    fixture.detectChanges();
    const slider = fixture.debugElement.query((d) => d.componentInstance instanceof ToolSliderComponent);
    expect((slider.componentInstance as ToolSliderComponent).label).toBe('Sens.');
    expect(el().textContent).toContain('3.3');
    const changes: (number | undefined)[] = [];
    tools.wandSensitivityChange.subscribe((v) => changes.push(v));
    (slider.componentInstance as ToolSliderComponent)['onChange']({ value: 4 });
    expect(changes).toEqual([4]);
  });

  it('undo / redo follow canUndo / canRedo', () => {
    const disabled = () => ['Undo', 'Redo']
      .map((l) => (el().querySelector(`button[aria-label="${l}"]`) as HTMLButtonElement).disabled);
    expect(disabled()).toEqual([true, true]);
    fixture.componentRef.setInput('canUndo', true);
    fixture.detectChanges();
    expect(disabled()).toEqual([false, true]);
  });
});
