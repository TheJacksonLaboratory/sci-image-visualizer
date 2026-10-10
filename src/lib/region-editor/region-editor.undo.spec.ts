import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { EMPTY, of } from 'rxjs';
import { ConfirmationService, MessageService } from 'primeng/api';
import { TableModule } from 'primeng/table';
import { DropdownModule } from 'primeng/dropdown';
import { InputTextModule } from 'primeng/inputtext';
import { RadioButtonModule } from 'primeng/radiobutton';
import { SelectButtonModule } from 'primeng/selectbutton';
import { CheckboxModule } from 'primeng/checkbox';

import { RegionEditorComponent } from './region-editor.component';
import { REGION_EDITOR_API } from '../contracts/region-editor-api.contract';
import { REGION_IO_PORT, RegionIoPort } from '../contracts/ports/region-io.port';
import { RegionStore } from '../store/region-store.service';
import { VisualizerStore } from '../store/visualizer-store.service';
import { Polygon, Rectangle, Region } from '../models/region';
import { ClassPreset } from '../models/class-preset';

jest.mock('file-saver', () => ({ saveAs: jest.fn() }));
jest.mock('./mask-worker', () => ({ createMaskWorker: jest.fn() }));

/**
 * Region Editor edits must be undoable (review RT-1) and a cancelled label edit
 * must leave the region alone (RT-18).
 *
 * The editor's rows are the RegionStore's live instances, and the store takes
 * its undo snapshot when an edit commits. Editing those instances in place
 * before committing put the edited values into the snapshot, so Ctrl+Z restored
 * the edit. These tests drive the editor against a real RegionStore through the
 * same annotation surface the router exposes.
 */
describe('RegionEditorComponent — edits commit undoably (RT-1 / RT-18)', () => {
  let fixture: ComponentFixture<RegionEditorComponent>;
  let editor: RegionEditorComponent;
  let store: RegionStore;
  let vstore: VisualizerStore;

  function square(label: string, color: string): Region {
    const r = new Region();
    const p = new Polygon();
    p.xpoints = [0, 10, 10, 0];
    p.ypoints = [0, 0, 10, 10];
    p.coordinates = p.xpoints.map((x, i) => [x, p.ypoints[i]]);
    p.npoints = 4;
    r.bounds = p;
    r.label = label;
    r.color = color;
    r.colorOverridden = true; // keep the seeded colour (no preset recolour)
    return r;
  }

  function rect(): Region {
    const r = new Region();
    const b = new Rectangle();
    b.x = 10; b.y = 20; b.width = 300; b.height = 700;
    r.bounds = b;
    r.label = 'Box';
    r.color = '#123456';
    r.colorOverridden = true;
    return r;
  }

  /** Seed the store as if the regions were drawn earlier, with no edit pending. */
  function seed(...regions: Region[]): void {
    store.setRegions(regions, false, true);
    store.resetUndoHistory();
    editor.ngOnInit();
    fixture.detectChanges();
  }

  const live = (i = 0) => store.getRegions()[i];

  beforeEach(async () => {
    // jsdom can't parse PrimeNG's component stylesheets and logs each one; styles
    // are irrelevant here, so drop just that message.
    const consoleError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) consoleError(...args);
    });
    vstore = new VisualizerStore();
    store = new RegionStore(vstore);
    const api = {
      getShowShapeLabel: () => false,
      getShapeColor: () => '#00ffff',
      getFillColor: () => 'rgba(0,0,0,0)',
      getClassificationColors: () => vstore.getClassificationColors(),
      setClassificationColor: (label: string, color: string) => vstore.setClassificationColor(label, color),
      getPresetSet: () => vstore.getPresetSet(),
      getPresetSet$: () => vstore.getPresetSet$(),
      upsertClass: (p: ClassPreset) => vstore.upsertClass(p),
      removeClass: (name: string) => vstore.removeClass(name),
      getRegionUpdateEvent: () => store.getRegionUpdateEvent(),
      getSelectedRegions$: () => EMPTY,
      setSelectedRegions: () => undefined,
      getImageMeta: () => EMPTY,
      getAnnotationRegions: () => store.getRegions().filter((r) => !r.isProfile()),
      setAnnotationRegions: (regions: Region[], show?: boolean, save?: boolean, fill?: string) =>
        store.setRegions(regions, show, save, fill),
    };
    await TestBed.configureTestingModule({
      declarations: [RegionEditorComponent],
      imports: [CommonModule, FormsModule, NoopAnimationsModule, TableModule, DropdownModule, InputTextModule,
        RadioButtonModule, SelectButtonModule, CheckboxModule],
      providers: [
        { provide: REGION_EDITOR_API, useValue: api },
        MessageService,
        ConfirmationService,
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
    editor = fixture.componentInstance;
  });

  afterEach(() => {
    store.resetUndoHistory(); // clears the coalescing timer
    fixture.destroy();
    jest.restoreAllMocks();
  });

  it('a per-row recolour is undone by undo()', () => {
    seed(square('Tumor', '#111111'));
    editor.changeRegionColor(editor.regions[0], '#222222');
    expect(live().color).toBe('#222222');
    store.undo();
    expect(live().color).toBe('#111111');
  });

  it('recolouring the selection is undone by undo()', () => {
    seed(square('Tumor', '#111111'));
    editor.selectedRegions = [editor.regions[0]];
    editor.classColorEdits = [{ label: 'Tumor', color: '#333333' }];
    editor.applyColorToSelected();
    expect(live().color).toBe('#333333');
    store.undo();
    expect(live().color).toBe('#111111');
    expect(live().colorOverridden).toBe(true);
  });

  it('a class change from the row dropdown is undone by undo()', () => {
    seed(square('Tumor', '#111111'));
    editor.applyPresetToRegion(editor.regions[0], 'Stroma');
    expect(live().label).toBe('Stroma');
    store.undo();
    expect(live().label).toBe('Tumor');
    expect(live().color).toBe('#111111');
  });

  it('a class applied to the selection is undone by undo()', () => {
    seed(square('Tumor', '#111111'), square('Tumor', '#111111'));
    editor.selectedRegions = [...editor.regions];
    editor.selectActiveClass('Stroma');
    expect(store.getRegions().map((r) => r.label)).toEqual(['Stroma', 'Stroma']);
    store.undo();
    expect(store.getRegions().map((r) => r.label)).toEqual(['Tumor', 'Tumor']);
  });

  it('deleting a class (its regions revert to Region) is undone by undo()', () => {
    seed(square('Tumor', '#111111'));
    editor.deleteClass('Tumor');
    expect(live().label).toBe('Region');
    store.undo();
    expect(live().label).toBe('Tumor');
    expect(live().color).toBe('#111111');
  });

  it('rounding rectangle sizes to 512 is undone by undo()', () => {
    seed(rect());
    editor.roundRectangleLengths();
    expect((live().bounds as Rectangle).width).toBe(512);
    store.undo();
    expect((live().bounds as Rectangle).width).toBe(300);
    expect((live().bounds as Rectangle).height).toBe(700);
  });

  it('showing an uncoloured region does not paint the fallback colour onto the store instance', () => {
    const plain = new Region();
    plain.bounds = Object.assign(new Rectangle(), { x: 0, y: 0, width: 5, height: 5 });
    seed(plain);
    expect(editor.regions[0].color).toBe('#00ffff'); // the editor shows the default
    expect(live().color).toBeUndefined();           // the stored region is untouched
    expect(store.canUndo()).toBe(false);
  });

  // ── label edits (RT-18) ────────────────────────────────────────────────

  function typeLabel(text: string): HTMLInputElement {
    editor.startEditLabel(editor.regions[0]);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('td.class-cell input') as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    return input;
  }

  it('typing a label does not touch the store until it is committed, and Escape discards it', () => {
    seed(square('Tumor', '#111111'));
    const input = typeLabel('Typo');
    expect(live().label).toBe('Tumor');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(live().label).toBe('Tumor');
    expect(editor.regions[0].label).toBe('Tumor');
    expect(editor.isEditingLabel(editor.regions[0])).toBe(false);
  });

  it('Enter commits the typed label, and undo() restores the old one', () => {
    seed(square('Tumor', '#111111'));
    const input = typeLabel('Necrosis');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(live().label).toBe('Necrosis');
    store.undo();
    expect(live().label).toBe('Tumor');
  });
});
