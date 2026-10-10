import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { EMPTY, of } from 'rxjs';
import { ConfirmationService, MessageService } from 'primeng/api';

import { VisualizationModule } from '../visualization.module';
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
 * DOM characterization of the Region Editor (§6 RegionEditorComponent split):
 * renders the real template (through VisualizationModule, so any child
 * components it declares are used) against a real RegionStore, and pins what a
 * user sees and what the main interactions commit. It must stay green, as is,
 * across the template split.
 */
describe('RegionEditorComponent (DOM)', () => {
  let fixture: ComponentFixture<RegionEditorComponent>;
  let editor: RegionEditorComponent;
  let store: RegionStore;
  let vstore: VisualizerStore;
  let el: HTMLElement;

  function square(i: number, label: string): Region {
    const r = new Region();
    const s = 10 + i;
    const p = new Polygon();
    p.xpoints = [0, s, s, 0];
    p.ypoints = [0, 0, s, s];
    p.coordinates = p.xpoints.map((x, k) => [x, p.ypoints[k]]);
    p.npoints = 4;
    r.bounds = p;
    r.label = label;
    return r;
  }

  function box(): Region {
    const r = new Region();
    r.bounds = Object.assign(new Rectangle(), { x: 0, y: 0, width: 1000, height: 2000 });
    r.label = 'Stroma';
    return r;
  }

  const texts = (sel: string) => Array.from(el.querySelectorAll(sel)).map((n) => (n.textContent ?? '').trim());
  const render = () => { fixture.detectChanges(); };

  beforeEach(async () => {
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
      setPresetSet: (s: never) => vstore.setPresetSet(s),
      upsertClass: (p: ClassPreset) => vstore.upsertClass(p),
      removeClass: (name: string) => vstore.removeClass(name),
      resetPresets: () => vstore.resetPresets(),
      getRegionUpdateEvent: () => store.getRegionUpdateEvent(),
      getSelectedRegions$: () => EMPTY,
      setSelectedRegions: jest.fn(),
      getImageMeta: () => of([{ mppX: 0.5, mppY: 0.5 }]),
      getAnnotationRegions: () => store.getRegions().filter((r) => !r.isProfile()),
      setAnnotationRegions: (regions: Region[], show?: boolean, save?: boolean, fill?: string) =>
        store.setRegions(regions, show, save, fill),
      isStackMode: () => false,
      getMaskImageSize: () => ({ width: 100, height: 100 }),
      getGeoJsonString: () => '{}',
    };
    await TestBed.configureTestingModule({
      imports: [VisualizationModule, NoopAnimationsModule],
      providers: [
        MessageService,
        ConfirmationService,
        { provide: REGION_EDITOR_API, useValue: api },
        {
          provide: REGION_IO_PORT,
          useValue: {
            getSelectedFileName: () => 'slide.tif',
            roiFileExists: () => of(false),
            saveGeoJson: () => of(void 0),
            saveSliceGeoJsons: () => of(void 0),
          } as RegionIoPort,
        },
      ],
    }).compileComponents();
    const regions = [box(), ...Array.from({ length: 11 }, (_, i) => square(i, i < 3 ? 'Tumor' : 'Region'))];
    store.setRegions(regions, false, true);
    store.resetUndoHistory();
    fixture = TestBed.createComponent(RegionEditorComponent);
    editor = fixture.componentInstance;
    el = fixture.nativeElement;
    render();
  });

  afterEach(() => {
    store.resetUndoHistory();
    fixture?.destroy();
    jest.restoreAllMocks();
  });

  it('renders the toolbar actions, enabled by the region set', () => {
    const icons = Array.from(el.querySelectorAll('.region-toolbar p-button'))
      .map((b) => b.getAttribute('icon') ?? b.getAttribute('label') ?? '');
    expect(icons).toEqual([
      'pi pi-tag', 'pi pi-upload', 'pi pi-download', 'pi pi-save', '', 'x512',
      'pi pi-check-square', 'pi pi-tags', 'pi pi-palette', 'pi pi-trash', 'pi pi-times-circle', 'pi pi-question',
    ]);
    const disabled = Array.from(el.querySelectorAll('.region-toolbar p-button button'))
      .map((b) => (b as HTMLButtonElement).disabled);
    // Selection-dependent actions (tags, palette, trash) start disabled.
    expect(disabled).toEqual([false, false, false, false, false, false, false, true, true, true, false, false]);
  });

  it('lists the classes, most-used first, with their counts', () => {
    const names = texts('.classes-panel .class-row .row-name');
    const counts = texts('.classes-panel .class-row .row-count');
    expect(names.slice(0, 3)).toEqual(['Region', 'Tumor', 'Stroma']);
    expect(counts.slice(0, 3)).toEqual(['8', '3', '1']);
    expect(names.length).toBe(vstore.getPresetSet().classes.length);
  });

  it('pages the table at 10 rows with physical-unit areas', () => {
    expect(texts('.region-editor-table thead th').slice(0, 2)).toEqual(['Class', 'Surface']);
    expect(el.querySelectorAll('.region-editor-table tbody tr').length).toBe(10);
    // 1000×2000 px at 0.5 µm/px = 500 000 µm²; a 10×10 px square = 25 µm².
    const areas = texts('td.surface-cell');
    expect(areas[0]).toBe(`${(500000).toLocaleString()} µm²`);
    expect(areas[1]).toBe('25 µm²');
    expect(texts('.region-editor-paginator .p-paginator-current')).toEqual(['1 to 10 of 12']);
  });

  it('a row trash button deletes that region from the store', () => {
    const trash = el.querySelectorAll('.region-editor-table tbody tr td:last-child button');
    (trash[1] as HTMLButtonElement).click();
    render();
    expect(store.getRegions().length).toBe(11);
    expect(texts('.region-editor-paginator .p-paginator-current')).toEqual(['1 to 10 of 11']);
  });

  it('clicking a class row with rows selected re-classifies them', () => {
    editor['selectedRegions'] = [editor['regions'][0]];
    render();
    const rows = Array.from(el.querySelectorAll('.classes-panel .class-row'));
    const tumor = rows.find((r) => r.querySelector('.row-name')?.textContent?.trim() === 'Tumor') as HTMLElement;
    tumor.click();
    render();
    expect(store.getRegions()[0].label).toBe('Tumor');
    expect(texts('.classes-panel .class-row .row-count').slice(0, 3)).toEqual(['8', '4', '0']);
  });

  it('the pencil opens an inline label editor; Enter commits', () => {
    const pencil = el.querySelector('td.class-cell .pi-pencil') as HTMLElement;
    pencil.click();
    render();
    const input = el.querySelector('td.class-cell input') as HTMLInputElement;
    input.value = 'Necrosis';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    render();
    expect(store.getRegions()[0].label).toBe('Necrosis');
    expect(el.querySelector('td.class-cell input')).toBeNull();
  });

  it('opens the dialogs with their seeded state', async () => {
    editor['persistRegions']();
    editor['openSaveMaskDialog']();
    editor['exportRois']();
    render();
    await fixture.whenStable(); // ngModel writes its value a tick later
    render();
    // The dialogs are appended to <body>.
    const headers = Array.from(document.querySelectorAll('.p-dialog-title')).map((n) => n.textContent?.trim());
    expect(headers).toEqual(expect.arrayContaining(['Save Regions As', 'Save Mask', 'Export Regions']));
    const values = Array.from(document.querySelectorAll('.p-dialog input[type=text]'))
      .map((i) => (i as HTMLInputElement).value);
    expect(values).toEqual(expect.arrayContaining(['slide.geojson', 'slide_mask.png']));
  });
});
