import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject, of } from 'rxjs';

import { SpatialControlsComponent } from './spatial-controls.component';
import { SpatialKeyComponent } from './spatial-key/spatial-key.component';
import { SpatialColorByComponent } from './spatial-color-by/spatial-color-by.component';
import { SpatialCellsPanelComponent } from './spatial-cells-panel/spatial-cells-panel.component';
import { SpatialGroupsPanelComponent } from './spatial-groups-panel/spatial-groups-panel.component';
import { SpatialTranscriptsPanelComponent } from './spatial-transcripts-panel/spatial-transcripts-panel.component';
import { SpatialGeneTreeComponent } from './spatial-gene-tree/spatial-gene-tree.component';
import { SpatialObservationsPanelComponent } from './spatial-observations-panel/spatial-observations-panel.component';
import { SpatialMarkerGenesFormComponent } from './spatial-marker-genes-form/spatial-marker-genes-form.component';
import { SpatialSelectionTranscriptsComponent } from './spatial-selection-transcripts/spatial-selection-transcripts.component';
import { SpatialSelectionObservationsComponent } from './spatial-selection-observations/spatial-selection-observations.component';
import { VISUALIZER, ISpatialControls } from '../contracts/visualizer.contract';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import {
  DEFAULT_SPATIAL_VIEW,
  ObservationsInSelection,
  SpatialViewState,
  TranscriptsInSelection,
} from '../contracts/display-types';
import { COLORMAP_OPTIONS } from '../plot.utilities';
import { SpatialSelectionMask, emptySelection } from '../spatial/spatial-selection';
import {
  accessorOf,
  afterLabel,
  click,
  fire,
  one,
  panelNamed,
  rowLabelled,
  shallowPanel,
} from '../testing/spatial-panel-testing';

/**
 * DOM-level characterization of the spatial-omics dialog: for every section, which
 * `setViewState` partial (or port call) each control in the RENDERED template emits.
 *
 * Written before the dialog was split into child panels, and kept as the contract the
 * split must hold: every child writes only through `controls.setViewState`, so the store
 * is the single observable surface, and this spec pins it from the outside. The behaviour
 * behind each control is specified next to the code that owns it.
 */
const dataset: SpatialDataset = {
  id: 'xenium',
  name: 'Xenium demo',
  observations: { count: 4, x: new Float32Array(4), y: new Float32Array(4) },
  columns: [
    { kind: 'categorical', name: 'graphclust', categories: ['A', 'B'], colors: ['#f00', '#00f'] },
    {
      kind: 'categorical',
      name: 'kmeans_2',
      categories: ['k0', 'k1'],
      section: 'Clusters',
      family: { id: 'kmeans', label: 'K-means', variant: 'k = 2' },
    },
    {
      kind: 'categorical',
      name: 'kmeans_3',
      categories: ['k0', 'k1', 'k2'],
      section: 'Clusters',
      family: { id: 'kmeans', label: 'K-means', variant: 'k = 3' },
    },
    { kind: 'continuous', name: 'total_counts', unit: 'counts' },
  ],
  features: { count: 3, names: ['Ttr', 'Mbp', 'Snap25'] },
  imageRef: {},
  volume: { width: 2, height: 2, depth: 2, voxelSize: [1, 1, 1] },
  polygonTiles: {
    bounds: [0, 0, 100, 100],
    sets: [
      { name: 'nucleus', label: 'Nuclei' },
      { name: 'cell', label: 'Cells' },
    ],
    defaultSet: 'cell',
    levels: [{ tileSize: 250 }],
  },
  transcriptTiles: {
    bounds: [0, 0, 100, 100],
    geneCount: 3,
    hasZ: true,
    levels: [{ tileSize: 250, aggregated: false }],
  },
  density: { gridSize: [10, 10], origin: [0, 0], rows: 10, cols: 10 },
  transcriptBins: {
    bounds: [0, 0, 100, 100],
    origin: [0, 0],
    count: 1000,
    levels: [{ binSize: 2, tileSize: 128 }],
  },
} as SpatialDataset;

describe('SpatialControlsComponent (rendered: what each control writes)', () => {
  let fixture: ComponentFixture<SpatialControlsComponent>;
  let component: SpatialControlsComponent;
  let root: HTMLElement;
  let dataset$: BehaviorSubject<SpatialDataset | null>;
  let view$: BehaviorSubject<SpatialViewState>;
  let selection$: BehaviorSubject<SpatialSelectionMask>;
  let controls: jest.Mocked<ISpatialControls>;

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Settle the async loads, then re-render. */
  const settle = async () => {
    await flush();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  };
  const lastWrite = () => {
    const calls = (controls.setViewState as jest.Mock).mock.calls;
    return calls[calls.length - 1]?.[0];
  };
  const pick = (el: Element, value: unknown) => {
    accessorOf(fixture, el).pick(value);
    fixture.detectChanges();
  };
  const emit = (el: Element, name: string, detail: Record<string, unknown> = {}) => {
    fire(el, name, detail);
    fixture.detectChanges();
  };
  /** Open a collapsible section by clicking its header. */
  const openSection = async (title: string) => {
    const panel = panelNamed(root, title);
    if (!panel.classList.contains('open')) click(one(panel, '.sc-panel-head'));
    await settle();
    return panelNamed(root, title);
  };
  /** Open the Observations section, showing them as markers (a dataset with cells shows its cells). */
  const openMarkers = async () => {
    const toggle = (await openSection('Observations')).querySelector('.sc-show-as p-selectButton');
    if (toggle) pick(toggle, 'markers');
    await settle();
    return panelNamed(root, 'Observations');
  };
  const view = (partial: Partial<SpatialViewState>) => {
    view$.next({ ...view$.value, ...partial });
    fixture.detectChanges();
  };

  async function build(opts: { is3d?: boolean } = {}) {
    TestBed.resetTestingModule();
    // The dialog and every panel it is made of, each shallow (PrimeNG unrendered).
    for (const leaf of [
      SpatialKeyComponent,
      SpatialGroupsPanelComponent,
      SpatialGeneTreeComponent,
      SpatialMarkerGenesFormComponent,
      SpatialSelectionTranscriptsComponent,
      SpatialSelectionObservationsComponent,
    ])
      shallowPanel(leaf);
    shallowPanel(SpatialCellsPanelComponent);
    shallowPanel(SpatialColorByComponent, [SpatialGroupsPanelComponent, SpatialKeyComponent]);
    shallowPanel(SpatialObservationsPanelComponent, [
      SpatialColorByComponent,
      SpatialSelectionObservationsComponent,
    ]);
    shallowPanel(SpatialTranscriptsPanelComponent, [
      SpatialGeneTreeComponent,
      SpatialMarkerGenesFormComponent,
      SpatialSelectionTranscriptsComponent,
    ]);
    shallowPanel(SpatialControlsComponent, [
      SpatialCellsPanelComponent,
      SpatialTranscriptsPanelComponent,
      SpatialObservationsPanelComponent,
    ]);
    await TestBed.configureTestingModule({
      imports: [SpatialControlsComponent],
      providers: [
        {
          provide: VISUALIZER,
          useValue: {
            getSpatialControls: () => controls,
            getColormap: () => of({ label: 'Viridis', data: { value: 'Viridis' } }),
            getReverseScale: () => of(false),
            getColormapOptions: () => COLORMAP_OPTIONS,
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SpatialControlsComponent);
    component = fixture.componentInstance;
    component.visible = true;
    component.is3d = !!opts.is3d;
    fixture.detectChanges();
    root = fixture.nativeElement as HTMLElement;
    await settle();
    (controls.setViewState as jest.Mock).mockClear();
  }

  beforeEach(() => {
    dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
    view$ = new BehaviorSubject<SpatialViewState>({ ...DEFAULT_SPATIAL_VIEW });
    selection$ = new BehaviorSubject<SpatialSelectionMask>(emptySelection());
    controls = {
      getDataset$: jest.fn(() => dataset$),
      getViewState$: jest.fn(() => view$),
      viewState: jest.fn(() => view$.value),
      setViewState: jest.fn((partial) => view$.next({ ...view$.value, ...partial })),
      colorByColumn: jest.fn((name: string) => view$.next({ ...view$.value, colorBy: { kind: 'column', name } })),
      colorByFeature: jest.fn((name: string) =>
        view$.next({ ...view$.value, colorBy: { kind: 'feature', name } }),
      ),
      clearColorBy: jest.fn(() => view$.next({ ...view$.value, colorBy: null })),
      searchFeatures: jest.fn(async () => ['Ttr']),
      categoryColors: jest.fn(async () => ['#ff0000', '#0000ff']),
      categoricalView: jest.fn(async () => ({
        name: 'graphclust',
        categories: ['A', 'B'],
        colors: ['#f00', '#00f'],
        codes: new Uint16Array([0, 0, 0, 1]),
      })),
      categoricalColumns: jest.fn(() => ['graphclust', 'kmeans_2', 'kmeans_3']),
      continuousValues: jest.fn(async () => new Float32Array(4)),
      getSelection$: jest.fn(() => selection$),
      selectFromRegions: jest.fn(async () => {
        selection$.next({ mask: new Uint8Array([1, 0, 1, 0]), count: 2 });
        return 2;
      }),
      selectCategory: jest.fn(async () => {
        selection$.next({ mask: new Uint8Array([1, 1, 1, 0]), count: 3 });
        return 3;
      }),
      clearSelection: jest.fn(() => selection$.next(emptySelection())),
      sampledSections: jest.fn(() => Float32Array.from([0, 10, 20])),
      markerGenes: jest.fn(async () => ({
        column: 'graphclust',
        groups: [
          {
            name: 'A',
            genes: [
              { name: 'Ttr', score: 3 },
              { name: 'Mbp', score: 1 },
            ],
          },
          { name: 'B', genes: [{ name: 'Mbp', score: 2 }] },
        ],
      })),
      getTranscriptEstimate$: jest.fn(() => of({ points: 150_000, max: 100_000 })),
      getGeneCountsInView$: jest.fn(() => of({ Ttr: 12 })),
      getDensityStats$: jest.fn(() => of({ lo: 0.1, hi: 0.5, max: 2 })),
    } as unknown as jest.Mocked<ISpatialControls>;
  });

  describe('Images', () => {
    it('switches the image layer from the header checkbox', async () => {
      await build();
      const panel = panelNamed(root, 'Images');
      emit(one(panel, '.sc-panel-head p-checkbox'), 'onChange', { checked: false });
      expect(lastWrite()).toEqual({ showImage: false });
      // The header click toggles the section, the checkbox does not.
      expect(panel.classList.contains('open')).toBe(false);
      await openSection('Images');
      expect(panelNamed(root, 'Images').textContent).toContain('Channels & Histogram');
      // The reference volume is 3D's.
      expect(() => panelNamed(root, 'Volume')).toThrow();
    });

    it('is not offered in 3D', async () => {
      dataset$.next({
        ...dataset,
        transcriptTiles: { ...dataset.transcriptTiles!, hasZ: false },
      } as SpatialDataset);
      await build({ is3d: true });
      expect(() => panelNamed(root, 'Images')).toThrow();
      // The Volume section takes its place.
      expect(panelNamed(root, 'Volume')).toBeTruthy();
      expect(root.querySelector('spatial-cells-panel')).toBeNull();
      // Transcripts without z have no place in the cloud.
      expect(() => panelNamed(root, 'Transcripts')).toThrow();
    });

    it("offers the Cells in 3D for a 3D segmentation's cells: by type or each cell, without the 2D boundaries", async () => {
      dataset$.next({
        ...dataset,
        polygonTiles: {
          bounds: [0, 0, 1, 1],
          levels: [],
          defaultSet: 'cell',
          sets: [
            { name: 'cell', label: 'Cells' },
            { name: '3d', label: '3D', regionSource: 'rs-3d' },
          ],
        },
      } as SpatialDataset);
      await build({ is3d: true });
      const panel = one(root, 'spatial-cells-panel');
      expect(panel.textContent).toContain('In 3D');
      expect(panel.textContent).not.toContain('Boundaries');
      expect(panel.textContent).not.toContain('View cells as');
      pick(one(panel, 'p-selectbutton'), 'cells');
      expect(lastWrite()).toEqual({ cells3d: 'cells' });
    });

    it('offers the Transcripts in 3D when they carry z', async () => {
      dataset$.next({
        ...dataset,
        transcriptTiles: { ...dataset.transcriptTiles!, hasZ: true },
      } as SpatialDataset);
      await build({ is3d: true });
      expect(panelNamed(root, 'Transcripts')).toBeTruthy();
      expect(root.querySelector('spatial-cells-panel')).toBeNull();
    });
  });

  describe('Cells', () => {
    /** The cells' drawing, in the Observations while they are shown as cells. */
    const cellsPart = () => one(panelNamed(root, 'Observations'), 'spatial-cells-panel');

    it('shows a dataset with cells as its cells, toggled with the markers, above Observations in selection', async () => {
      await build();
      const observations = panelNamed(root, 'Observations');
      expect(observations.classList.contains('open')).toBe(true);
      // No section, nor sub-sections, of their own: one toggle, Markers or Cell segmentations.
      expect(() => panelNamed(root, 'Cells')).toThrow();
      expect(observations.querySelector('.sc-subsection')).toBeNull();
      const toggle = one(observations, '.sc-show-as p-selectButton');
      expect(cellsPart().textContent).toContain('Cell segmentations');
      expect(observations.textContent).not.toContain('Point size');
      const selection = one(observations, 'spatial-selection-observations');
      expect(cellsPart().compareDocumentPosition(selection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      pick(toggle, 'markers');
      expect(lastWrite()).toEqual({ showPoints: true, showCells: false });
      fixture.detectChanges();
      expect(panelNamed(root, 'Observations').querySelector('spatial-cells-panel')).toBeNull();
      expect(panelNamed(root, 'Observations').textContent).toContain('Point size');

      // The switch hides them, either way.
      emit(one(panelNamed(root, 'Observations'), '.sc-show-as p-checkbox'), 'onChange', { checked: false });
      expect(lastWrite()).toEqual({ showPoints: false, showCells: false });
      pick(one(panelNamed(root, 'Observations'), '.sc-show-as p-selectButton'), 'cells');
      expect(lastWrite()).toEqual({ showPoints: false, showCells: false });
      emit(one(panelNamed(root, 'Observations'), '.sc-show-as p-checkbox'), 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ showCells: true, showPoints: true });
    });

    it('writes the boundaries', async () => {
      await build();
      // A switch per boundary set: the nuclei's on draws them with the cells'.
      const nuclei = one(rowLabelled(cellsPart(), 'Nuclei'), 'p-inputSwitch');
      expect(accessorOf(fixture, nuclei)).toBeTruthy();
      emit(nuclei, 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ showCells: true, cellSet: 'both' });
      // No colouring of their own: the Observations' Colour by is theirs.
      expect(cellsPart().textContent).not.toContain('Cell Color');
    });

    it('writes how cells are drawn and their fill opacity, from the slider or the box', async () => {
      await build();
      pick(afterLabel(cellsPart(), 'View cells as', 'p-selectButton'), 'both');
      expect(lastWrite()).toEqual({ cellDraw: 'both' });
      const opacity = one(cellsPart(), '.sc-row-number');
      emit(one(opacity, 'p-slider'), 'onChange', { value: 0.3 });
      expect(lastWrite()).toEqual({ cellOpacity: 0.3 });
      pick(one(opacity, 'p-inputNumber'), 40);
      expect(lastWrite()).toEqual({ cellOpacity: 0.4 });
      pick(afterLabel(cellsPart(), 'View cells as', 'p-selectButton'), 'outline');
      expect(cellsPart().querySelector('.sc-row-number')).toBeNull();
    });
  });

  describe('Colour by (markers and cells alike)', () => {
    const colourBy = () => one(panelNamed(root, 'Observations'), 'spatial-color-by');

    it('colours by a grouping: the group picker, a family variant, the group rows and All groups', async () => {
      await build();
      pick(one(colourBy(), '.sc-color-modes'), 'group');
      expect(lastWrite()).toEqual({
        cellTypeColumn: 'graphclust',
        cellColorMode: 'group',
        colorBy: { kind: 'column', name: 'graphclust' },
      });
      await settle();
      const groupPicker = one(colourBy(), '.sc-row-picker p-dropdown');
      // A k-means family is one entry; choosing it applies its first variant, to the markers too.
      pick(groupPicker, 'family:kmeans');
      expect(lastWrite()).toEqual({
        cellTypeColumn: 'kmeans_2',
        hiddenGroups: [],
        cellColorMode: 'group',
        colorBy: { kind: 'column', name: 'kmeans_2' },
      });
      await settle();
      const variant = colourBy().querySelectorAll('.sc-row-picker p-dropdown')[1];
      pick(variant, 'kmeans_3');
      expect(lastWrite()).toEqual(expect.objectContaining({ cellTypeColumn: 'kmeans_3', hiddenGroups: [] }));

      pick(one(colourBy(), '.sc-row-picker p-dropdown'), 'graphclust');
      await settle();
      const rows = colourBy().querySelectorAll('.sc-group-row:not(.sc-group-all)');
      expect(Array.from(rows).map((r) => r.querySelector('.sc-group-label')?.textContent?.trim())).toEqual([
        'A',
        'B',
      ]);
      emit(one(rows[1] as HTMLElement, 'p-checkbox'), 'onChange', { checked: false });
      expect(lastWrite()).toEqual({ hiddenGroups: ['B'] });
      emit(one(colourBy(), '.sc-group-all p-checkbox'), 'onChange', { checked: false });
      expect(lastWrite()).toEqual({ hiddenGroups: ['A', 'B'] });
      emit(one(colourBy(), '.sc-group-all p-checkbox'), 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ hiddenGroups: [] });

      // A group's name selects its observations, as the key's rows did; again, clears.
      click(one(colourBy(), '.sc-group-row:not(.sc-group-all) .sc-group-select'));
      await settle();
      expect(controls.selectCategory).toHaveBeenCalledWith('graphclust', 0);
      expect(one(colourBy(), '.sc-group-select.selected').textContent?.trim()).toBe('A');
      click(one(colourBy(), '.sc-group-select.selected'));
      await settle();
      expect(controls.clearSelection).toHaveBeenCalled();

      // The chevron collapses the rows without writing anything.
      (controls.setViewState as jest.Mock).mockClear();
      click(one(colourBy(), '.sc-group-all button'));
      fixture.detectChanges();
      expect(colourBy().querySelectorAll('.sc-group-row').length).toBe(1);
      expect(controls.setViewState).not.toHaveBeenCalled();
    });

    it('colours by a gene, through the shared gene list, with its colour bar', async () => {
      await build();
      pick(one(colourBy(), '.sc-color-modes'), 'gene');
      fixture.detectChanges();
      const gene = one(colourBy(), 'p-dropdown[inputId=sc-gene]');
      pick(gene, 'Mbp');
      expect(lastWrite()).toEqual(
        expect.objectContaining({
          colorBy: { kind: 'feature', name: 'Mbp' },
          cellColorMode: 'gene',
          cellColorGene: 'Mbp',
        }),
      );
      // The shared gene picker: the dropdown filters through it.
      emit(one(colourBy(), 'p-dropdown[inputId=sc-gene]'), 'onFilter', { filter: 'sn' });
      await settle();
      const options = (
        one(colourBy(), 'p-dropdown[inputId=sc-gene]') as unknown as { options: { value: string }[] }
      ).options;
      // The filter's match, beside the gene picked.
      expect(options.map((o) => o.value)).toContain('Snap25');
      expect(options.map((o) => o.value)).not.toContain('Ttr');
      expect(one(colourBy(), '.sc-key .sc-colorbar')).toBeTruthy();
    });

    it('colours by one colour', async () => {
      await build();
      pick(one(colourBy(), '.sc-color-modes'), 'single');
      expect(lastWrite()).toEqual({ colorBy: null, cellColorMode: 'single' });
      fixture.detectChanges();
      const color = one(rowLabelled(colourBy(), 'Colour'), 'input[type=color]') as HTMLInputElement;
      color.value = '#123456';
      emit(color, 'change');
      expect(lastWrite()).toEqual({ cellSingleColor: '#123456', colorBy: null, cellColorMode: 'single' });
    });
  });

  describe('Transcripts', () => {
    it('turns transcripts on from the header, opening the section, and off again', async () => {
      await build();
      emit(one(panelNamed(root, 'Transcripts'), '.sc-panel-head p-checkbox'), 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ transcriptMode: 'circles' });
      await settle();
      expect(panelNamed(root, 'Transcripts').classList.contains('open')).toBe(true);
      emit(one(panelNamed(root, 'Transcripts'), '.sc-panel-head p-checkbox'), 'onChange', { checked: false });
      expect(lastWrite()).toEqual({ transcriptMode: 'off' });
    });

    it('writes the gene selection, All genes, the eye toggles and the menu actions', async () => {
      await build();
      const panel = await openSection('Transcripts');
      const genes = one(panel, 'p-multiSelect');
      emit(genes, 'onChange', { value: ['Ttr', 'Mbp'] });
      expect(lastWrite()).toEqual({ transcriptGenes: ['Ttr', 'Mbp'] });
      await settle();

      // The tree: one row per gene, by name, each with its own eye.
      let tree = one(panelNamed(root, 'Transcripts'), '.sc-gene-tree');
      const leaves = tree.querySelectorAll('.sc-gene-leaf');
      expect(Array.from(leaves).map((l) => l.querySelector('.sc-group-label')?.textContent)).toEqual([
        'Mbp',
        'Ttr',
      ]);
      // The renderer's per-gene count in view, and 0 for a gene it reported none of.
      expect(Array.from(leaves).map((l) => l.querySelector('.sc-gene-count')?.textContent?.trim())).toEqual([
        '0',
        '12',
      ]);
      click(one(leaves[1] as HTMLElement, '.sc-eye'));
      expect(lastWrite()).toEqual({ transcriptHiddenGenes: ['Ttr'] });
      await settle();
      tree = one(panelNamed(root, 'Transcripts'), '.sc-gene-tree');
      click(one(tree, '.sc-gene-root .sc-eye'));
      expect(lastWrite()).toEqual({ transcriptHiddenGenes: ['Ttr', 'Mbp'] });

      // '±' — every gene, then back.
      const all = Array.from(panelNamed(root, 'Transcripts').querySelectorAll('.sc-row-picker .sc-icon-btn')).find(
        (b) => b.textContent?.trim() === '±',
      )!;
      click(all);
      expect(lastWrite()).toEqual({ transcriptAllGenes: true });

      // The '⋮' menu's items are commands; the menu itself is PrimeNG's.
      const menu = one(panelNamed(root, 'Transcripts'), 'p-menu') as unknown as {
        model: { label: string; command: () => void; disabled?: boolean }[];
      };
      const item = (label: string) => menu.model.find((m) => m.label.startsWith(label))!;
      item('Remove gene groups').command();
      expect(lastWrite()).toEqual({ transcriptGeneGroups: [] });
      item('Clear selection').command();
      expect(lastWrite()).toEqual({ transcriptGenes: [], transcriptHiddenGenes: [] });
    });

    it('adds marker genes from the form the menu opens', async () => {
      await build();
      await openSection('Transcripts');
      const menu = one(panelNamed(root, 'Transcripts'), 'p-menu') as unknown as {
        model: { label: string; command: () => void }[];
      };
      menu.model.find((m) => m.label.startsWith('Add marker genes'))!.command();
      fixture.detectChanges();
      const form = one(panelNamed(root, 'Transcripts'), '.sc-markers');
      const column = one(rowLabelled(form, 'Clusters from'), 'p-dropdown');
      await fixture.whenStable();
      expect(accessorOf(fixture, column).value).toBe('graphclust');
      pick(one(rowLabelled(form, 'Per cluster'), 'p-dropdown'), 3);
      emit(one(form, '.sc-markers-actions p-button'), 'onClick');
      await settle();
      expect(controls.markerGenes).toHaveBeenCalledWith('graphclust', 3);
      expect(lastWrite()).toEqual({
        transcriptGeneGroups: [
          { name: 'A', genes: ['Ttr'] },
          { name: 'B', genes: ['Mbp'] },
        ],
        transcriptGenes: ['Ttr', 'Mbp'],
        transcriptColorBy: 'cluster',
        transcriptMode: 'circles',
      });
      // The form closes once applied.
      expect(panelNamed(root, 'Transcripts').querySelector('.sc-markers')).toBeNull();
    });

    it('writes the point controls: mode, budget, colouring, icon, size, opacity, quality', async () => {
      await build();
      view({ transcriptMode: 'circles' });
      const panel = await openSection('Transcripts');
      pick(afterLabel(panel, 'View transcripts as', 'p-selectButton'), 'glyphs');
      expect(lastWrite()).toEqual({ transcriptMode: 'glyphs' });

      // The estimate meter, and its budget behind "Edit Max".
      expect(one(panelNamed(root, 'Transcripts'), '.sc-meter-fill').classList.contains('over')).toBe(true);
      click(
        Array.from(panelNamed(root, 'Transcripts').querySelectorAll('.sc-small-btn')).find((b) =>
          b.textContent?.includes('Edit Max'),
        )!,
      );
      fixture.detectChanges();
      pick(one(rowLabelled(panelNamed(root, 'Transcripts'), 'Max markers'), 'p-dropdown'), 200_000);
      expect(lastWrite()).toEqual({ transcriptBudget: 200_000 });

      pick(one(rowLabelled(panelNamed(root, 'Transcripts'), 'Colour by'), 'p-selectButton'), 'gene');
      expect(lastWrite()).toEqual({ transcriptColorBy: 'gene' });
      emit(one(rowLabelled(panelNamed(root, 'Transcripts'), 'Size'), 'p-slider'), 'onChange', { value: 2 });
      expect(lastWrite()).toEqual({ transcriptScale: 2 });
      emit(one(rowLabelled(panelNamed(root, 'Transcripts'), 'Opacity'), 'p-slider'), 'onChange', { value: 0.5 });
      expect(lastWrite()).toEqual({ transcriptOpacity: 0.5 });
      emit(one(panelNamed(root, 'Transcripts'), 'p-checkbox[inputId=sc-tx-lowq]'), 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ transcriptQuality: 'all' });

      // With every gene shown as icons, one icon stands for all of them.
      view({ transcriptAllGenes: true });
      pick(one(rowLabelled(panelNamed(root, 'Transcripts'), 'Icon'), 'p-dropdown'), 'square');
      expect(lastWrite()).toEqual({ transcriptGlyphs: { '*': 'square' } });
    });

    it('writes the density map controls', async () => {
      await build();
      view({ transcriptMode: 'density' });
      const panel = await openSection('Transcripts');
      const opacity = afterLabel(panel, 'Density map opacity', '.sc-row-number');
      emit(one(opacity, 'p-slider'), 'onChange', { value: 0.6 });
      expect(lastWrite()).toEqual({ densityOpacity: 0.6 });
      pick(one(opacity, 'p-inputNumber'), 30);
      expect(lastWrite()).toEqual({ densityOpacity: 0.3 });
      emit(afterLabel(panelNamed(root, 'Transcripts'), 'Density map bin size', 'p-slider'), 'onChange', {
        value: 2,
      });
      expect(lastWrite()).toEqual({ densityBin: 40 });

      // The threshold window: derived from the renderer's stats until set.
      const range = one(panelNamed(root, 'Transcripts'), '.sc-row-range');
      await fixture.whenStable();
      expect(accessorOf(fixture, one(range, 'p-slider')).value).toEqual([0.1, 0.5]);
      emit(one(range, 'p-slider'), 'onChange', { values: [0.4, 0.2] });
      expect(lastWrite()).toEqual({ densityRange: [0.2, 0.4] });
      pick(range.querySelectorAll('p-inputNumber')[1], 0.9);
      expect(lastWrite()).toEqual({ densityRange: [0.2, 0.9] });
      click(
        Array.from(panelNamed(root, 'Transcripts').querySelectorAll('.sc-small-btn')).find(
          (b) => b.textContent?.trim() === 'Auto',
        )!,
      );
      expect(lastWrite()).toEqual({ densityRange: null });

      const cmap = one(panelNamed(root, 'Transcripts'), 'p-treeSelect');
      const magma = { label: 'Magma', data: { value: 'MAGMA_LUT' } };
      emit(cmap, 'onNodeSelect', { node: magma });
      expect(lastWrite()).toEqual({ densityColormap: 'MAGMA_LUT' });
      emit(cmap, 'onClear');
      expect(lastWrite()).toEqual({ densityColormap: null });
    });
  });

  describe('Regions', () => {
    it('writes the region switch, selects from the ROIs and clears', async () => {
      await build();
      // Under the Observations.
      const regions = panelNamed(root, 'Regions');
      expect(
        panelNamed(root, 'Observations').compareDocumentPosition(regions) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // Off by default: the regions are shown only when asked for.
      const regionSwitch = one(panelNamed(root, 'Regions'), '.sc-panel-head p-checkbox');
      expect(accessorOf(fixture, regionSwitch).value).toBe(false);
      emit(regionSwitch, 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ showAnnotations: true });
      emit(one(panelNamed(root, 'Regions'), '.sc-panel-head p-checkbox'), 'onChange', { checked: false });
      expect(lastWrite()).toEqual({ showAnnotations: false });
      const panel = await openSection('Regions');
      emit(one(panel, 'p-button[label="Select from ROIs"]'), 'onClick');
      await fixture.whenStable();
      fixture.detectChanges();
      expect(controls.selectFromRegions).toHaveBeenCalled();
      expect(panelNamed(root, 'Regions').textContent).toContain('2 of 4 selected');
      emit(one(panelNamed(root, 'Regions'), 'p-button[label="Clear"]'), 'onClick');
      fixture.detectChanges();
      expect(controls.clearSelection).toHaveBeenCalled();
      expect(panelNamed(root, 'Regions').querySelector('p-button[label="Clear"]')).toBeNull();
    });
  });

  describe('Transcripts in selection (in the Transcripts section)', () => {
    it('counts while the Transcripts section holds it expanded, and lists the genes by count', async () => {
      const list$ = new BehaviorSubject<TranscriptsInSelection>({ state: 'loading' });
      controls.getTranscriptsInSelection$ = jest.fn(() => list$);
      await build();
      // No separate section.
      expect(() => panelNamed(root, 'Transcripts in selection')).toThrow();
      expect(controls.getTranscriptsInSelection$).not.toHaveBeenCalled();
      let panel = await openSection('Transcripts');
      expect(controls.getTranscriptsInSelection$).toHaveBeenCalledTimes(1);
      expect(one(panel, '.sc-seltx-toggle').textContent).toContain('Transcripts in selection');
      expect(panel.textContent).toContain('Counting transcripts');
      list$.next({
        state: 'ready',
        scope: 'cells',
        label: 'Cell c-17',
        plane: { index: 2, count: 9 },
        total: 7,
        cells: 1,
        genes: [
          { name: 'Lgr5', count: 5 },
          { name: 'Actb', count: 2 },
        ],
      });
      fixture.detectChanges();
      panel = panelNamed(root, 'Transcripts');
      expect(panel.textContent).toContain('Cell c-17');
      expect(panel.textContent).toContain('plane 3 of 9');
      expect(panel.textContent).toContain('7 transcripts');
      const rows = Array.from(panel.querySelectorAll('.sc-seltx-list li')).map((li) =>
        Array.from(li.children).map((c) => c.textContent?.trim()),
      );
      expect(rows).toEqual([
        ['Lgr5', '', '5'],
        ['Actb', '', '2'],
      ]);
      // Folded: no longer counted, and counted again when unfolded.
      click(one(panel, '.sc-seltx-toggle'));
      fixture.detectChanges();
      expect(list$.observed).toBe(false);
      expect(panelNamed(root, 'Transcripts').querySelector('.sc-seltx-list')).toBeNull();
      click(one(panelNamed(root, 'Transcripts'), '.sc-seltx-toggle'));
      fixture.detectChanges();
      expect(list$.observed).toBe(true);
      // The Transcripts section closed: not counted either.
      click(one(panelNamed(root, 'Transcripts'), '.sc-panel-head'));
      fixture.detectChanges();
      expect(list$.observed).toBe(false);
    });

    it('says what to select while nothing is', async () => {
      controls.getTranscriptsInSelection$ = jest.fn(() =>
        of<TranscriptsInSelection>({ state: 'empty', message: 'Select a cell, or pick a cell type.' }),
      );
      await build({ is3d: true });
      const panel = await openSection('Transcripts');
      expect(panel.textContent).toContain('Select a cell, or pick a cell type.');
    });
  });

  describe('Observations in selection (in the Observations section)', () => {
    it('lists the selection by group with the cell and its values, followed while unfolded', async () => {
      const list$ = new BehaviorSubject<ObservationsInSelection>({
        state: 'ready',
        scope: 'cells',
        label: 'Cell c-17',
        plane: null,
        total: 1,
        cellId: 'c-17',
        groupColumn: 'cell_type',
        groups: [{ name: 'Goblet', count: 1, color: '#ff0000' }],
        measures: [
          { name: 'cluster', value: 'k2', mean: false },
          { name: 'area', value: 123.456, unit: 'µm²', mean: false },
        ],
      });
      controls.getObservationsInSelection$ = jest.fn(() => list$);
      await build({ is3d: true });
      const panel = await openSection('Observations');
      expect(one(panel, '.sc-seltx-toggle').textContent).toContain('Observations in selection');
      expect(panel.textContent).toContain('whole volume');
      expect(panel.textContent).toContain('1 observation');
      expect(panel.textContent).toContain('c-17');
      const rows = Array.from(panel.querySelectorAll('.sc-seltx-list li')).map((li) =>
        Array.from(li.children).map((c) => c.textContent?.trim()),
      );
      expect(rows).toEqual([['Goblet', '', '1']]);
      const measures = Array.from(panel.querySelectorAll('.sc-seltx-measures dt, .sc-seltx-measures dd')).map(
        (e) => e.textContent?.trim(),
      );
      expect(measures).toEqual(['cluster', 'k2', 'area', '123 µm²']);
      click(one(panel, '.sc-seltx-toggle'));
      fixture.detectChanges();
      expect(list$.observed).toBe(false);
    });
  });

  describe('Observations', () => {
    it('writes the show switch, the colour source and the display sliders', async () => {
      await build();
      // No switch on the section itself: the observations' is the Show as row's.
      expect(panelNamed(root, 'Observations').querySelector('.sc-panel-head p-checkbox')).toBeNull();
      const panel = await openMarkers();
      emit(one(panel, '.sc-show-as p-checkbox'), 'onChange', { checked: false });
      expect(lastWrite()).toEqual({ showPoints: false, showCells: false });
      emit(one(panelNamed(root, 'Observations'), '.sc-show-as p-checkbox'), 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ showPoints: true, showCells: false });

      // A measurement colours the markers, and the cells with them.
      pick(one(panelNamed(root, 'Observations'), '.sc-color-modes'), 'measure');
      fixture.detectChanges();
      pick(one(panelNamed(root, 'Observations'), 'p-dropdown[inputId=sc-measure]'), 'total_counts');
      expect(lastWrite()).toEqual(
        expect.objectContaining({ colorBy: { kind: 'column', name: 'total_counts' }, cellColorMode: 'column' }),
      );

      emit(one(rowLabelled(panelNamed(root, 'Observations'), 'Point size'), 'p-slider'), 'onChange', { value: 2 });
      expect(lastWrite()).toEqual({ pointScale: 2 });
      emit(one(rowLabelled(panelNamed(root, 'Observations'), 'Opacity'), 'p-slider'), 'onChange', { value: 0.4 });
      expect(lastWrite()).toEqual({ opacity: 0.4 });
    });

    it('shows a colour bar and its colormap picker for a continuous source', async () => {
      await build();
      view({ colorBy: { kind: 'column', name: 'total_counts' } });
      const panel = await openSection('Observations');
      // (jsdom drops a gradient background, so only the bar's presence is checked here.)
      expect(one(panel, '.sc-key .sc-colorbar')).toBeTruthy();
      expect(panel.querySelector('.sc-legend')).toBeNull();
      const cmap = one(rowLabelled(panel, 'Colormap'), 'p-treeSelect');
      emit(cmap, 'onNodeSelect', { node: { label: 'Magma', data: { value: 'MAGMA_LUT' } } });
      expect(lastWrite()).toEqual({ continuousColormap: 'MAGMA_LUT' });
      emit(cmap, 'onClear');
      expect(lastWrite()).toEqual({ continuousColormap: null });
    });
  });

  describe('gene map', () => {
    it('is offered for a gene source, and writes its toggle, smoothing and opacity (2D)', async () => {
      await build();
      expect(root.querySelector('p-checkbox[label="Gene map (expression field)"]')).toBeNull();
      view({ colorBy: { kind: 'feature', name: 'Ttr' } });
      emit(one(root, 'p-checkbox[label="Gene map (expression field)"]'), 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ geneMap: true });
      fixture.detectChanges();
      emit(one(rowLabelled(root, 'Smoothing'), 'p-slider'), 'onChange', { value: 2 });
      expect(lastWrite()).toEqual({ geneMapSmoothing: 2 });
      emit(one(rowLabelled(root, 'Map opacity'), 'p-slider'), 'onChange', { value: 0.5 });
      expect(lastWrite()).toEqual({ geneMapOpacity: 0.5 });
      expect(root.querySelector('p-checkbox[label="Volume rendering (interpolate along z)"]')).toBeNull();
    });

    it('writes the 3D volume switch, one section and its slider', async () => {
      await build({ is3d: true });
      view({ colorBy: { kind: 'feature', name: 'Ttr' }, geneMap: true });
      emit(one(root, 'p-checkbox[label="One map section at a time"]'), 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ geneMapSection: 1 });
      fixture.detectChanges();
      const row = rowLabelled(root, 'Map section');
      expect(row.querySelector('.sc-val')?.textContent).toBe('2 of 3');
      emit(one(row, 'p-slider'), 'onChange', { value: 2 });
      expect(lastWrite()).toEqual({ geneMapSection: 2 });
      emit(one(root, 'p-checkbox[label="One map section at a time"]'), 'onChange', { checked: false });
      expect(lastWrite()).toEqual({ geneMapSection: null });
      emit(one(root, 'p-checkbox[label="Volume rendering (interpolate along z)"]'), 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ geneMapVolume: true });
      // Interpolating makes "one section" meaningless, so it goes.
      expect(root.querySelector('p-checkbox[label="One map section at a time"]')).toBeNull();
    });
  });

  describe('3D scene', () => {
    it('writes the volume (its section), its opacity, the cloud and its section', async () => {
      await build({ is3d: true });
      // The volume is the Volume section's switch, no longer a checkbox among the observations'.
      expect(root.querySelector('p-checkbox[label="Reference volume"]')).toBeNull();
      const volume = panelNamed(root, 'Volume');
      emit(one(volume, '.sc-panel-head p-checkbox'), 'onChange', { checked: false });
      expect(lastWrite()).toEqual({ showVolume: false });
      expect(volume.classList.contains('open')).toBe(false);
      view({ showVolume: true });
      const opened = await openSection('Volume');
      emit(one(rowLabelled(opened, 'Opacity'), 'p-slider'), 'onChange', { value: 0.2 });
      expect(lastWrite()).toEqual({ volumeOpacity: 0.2 });
      // The cloud is the Observations' own Show switch: no second one here.
      expect(root.querySelector('p-checkbox[label="Observations"]')).toBeNull();
      emit(one(await openSection('Observations'), '.sc-show-as p-checkbox'), 'onChange', { checked: false });
      expect(lastWrite()).toEqual({ showPoints: false });
      view({ showPoints: true });
      emit(one(root, 'p-checkbox[label="One section at a time"]'), 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ pointSection: 1 });
      fixture.detectChanges();
      const row = rowLabelled(root, 'Section');
      expect(row.querySelector('.sc-val')?.textContent).toBe('2 of 3');
      emit(one(row, 'p-slider'), 'onChange', { value: 0 });
      expect(lastWrite()).toEqual({ pointSection: 0 });
    });

    it('writes the density volumes and their smoothing, and says what they are', async () => {
      await build({ is3d: true });
      emit(one(root, 'p-checkbox[label="Cluster density volumes"]'), 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ densityVolume: true });
      fixture.detectChanges();
      const smoothing = Array.from(root.querySelectorAll<HTMLElement>('.sc-row'))
        .filter((r) => r.querySelector('.sc-lbl')?.textContent?.trim() === 'Smoothing')
        .pop()!;
      emit(one(smoothing, 'p-slider'), 'onChange', { value: 3 });
      expect(lastWrite()).toEqual({ densitySmoothing: 3 });
      expect(root.textContent).toContain('Density estimate over all cells');
    });
  });

  describe('continuous knobs', () => {
    it('writes the log scale and the clip, only for a continuous source', async () => {
      await build();
      expect(root.querySelector('p-checkbox[label="Log scale"]')).toBeNull();
      view({ colorBy: { kind: 'column', name: 'total_counts' } });
      await settle();
      emit(one(root, 'p-checkbox[label="Log scale"]'), 'onChange', { checked: true });
      expect(lastWrite()).toEqual({ logScale: true });
      pick(one(rowLabelled(root, 'Clip outliers'), 'p-dropdown'), [0.05, 0.95]);
      expect(lastWrite()).toEqual({ percentileClip: [0.05, 0.95] });
    });
  });

  describe('Distribution and Reset', () => {
    it('keeps the chart mounted, active only while expanded and visible', async () => {
      await build();
      const charts = one(root, 'spatial-charts') as unknown as { active: boolean };
      expect(charts.active).toBe(false);
      click(one(root, '.sc-disclosure'));
      fixture.detectChanges();
      expect(charts.active).toBe(true);
      expect(one(root, `#${component['chartsBodyId']}`).hidden).toBe(false);
    });

    it('resets the view to the defaults and clears the selection', async () => {
      await build();
      view({ colorBy: { kind: 'column', name: 'graphclust' } });
      emit(one(root, '.sc-btns p-button'), 'onClick');
      expect(controls.setViewState).toHaveBeenCalledWith({ ...DEFAULT_SPATIAL_VIEW });
      expect(controls.clearSelection).toHaveBeenCalled();
    });
  });
});
