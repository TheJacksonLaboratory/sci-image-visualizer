import { By } from '@angular/platform-browser';
jest.mock('plotly.js-dist-min', () => ({
  react: jest.fn().mockResolvedValue(undefined),
  relayout: jest.fn(),
  purge: jest.fn(),
}));

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { SpatialChartsComponent } from './spatial-charts.component';
import { SpatialHeatmapControlsComponent } from './spatial-heatmap-controls/spatial-heatmap-controls.component';
import { SpatialEmbeddingControlsComponent } from './spatial-embedding-controls/spatial-embedding-controls.component';
import { SpatialChartWindowComponent } from './spatial-chart-window/spatial-chart-window.component';
import { VISUALIZER, ISpatialControls } from '../../contracts/visualizer.contract';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../../contracts/display-types';
import { SpatialSelectionMask, emptySelection } from '../../spatial/spatial-selection';
import { accessorOf, fire, one, shallowPanel } from '../../testing/spatial-panel-testing';

/**
 * The charts panel rendered with its control rows and window: what each rendered control
 * reaches. The behaviour behind them is specified in `spatial-charts.component.spec.ts`.
 */
const dataset: SpatialDataset = {
  id: 'demo', name: 'Demo',
  observations: { count: 4, x: new Float32Array(4), y: new Float32Array(4) },
  columns: [{ kind: 'categorical', name: 'region', categories: ['A', 'B'] }],
  features: { count: 2, names: ['Ttr', 'Mbp'] },
  embeddings: [{ name: 'X_umap', label: 'UMAP', dims: 2 }, { name: 'X_pca', label: 'PCA', dims: 2 }],
};

describe('SpatialChartsComponent (rendered)', () => {
  let fixture: ComponentFixture<SpatialChartsComponent>;
  let component: SpatialChartsComponent;
  let root: HTMLElement;
  let controls: jest.Mocked<ISpatialControls>;

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const settle = async () => {
    await flush();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    const view$ = new BehaviorSubject<SpatialViewState>({ ...DEFAULT_SPATIAL_VIEW });
    const selection$ = new BehaviorSubject<SpatialSelectionMask>(emptySelection());
    const dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
    controls = {
      getDataset$: () => dataset$, getViewState$: () => view$, getSelection$: () => selection$,
      continuousValues: jest.fn(async () => new Float32Array([1, 2, 3, 4])),
      categoricalView: jest.fn(async () => ({
        name: 'region', categories: ['A', 'B'], colors: ['#f00', '#00f'], codes: new Uint16Array([0, 0, 1, 1]),
      })),
      categoricalColumns: jest.fn(() => ['region']),
      getEmbedding: jest.fn(async (name: string) => ({
        meta: dataset.embeddings!.find((e) => e.name === name)!, x: new Float32Array(4), y: new Float32Array(4),
      })),
      selectIndices: jest.fn(), clearSelection: jest.fn(),
    } as unknown as jest.Mocked<ISpatialControls>;
    for (const child of [SpatialHeatmapControlsComponent, SpatialEmbeddingControlsComponent,
      SpatialChartWindowComponent]) shallowPanel(child);
    shallowPanel(SpatialChartsComponent,
      [SpatialHeatmapControlsComponent, SpatialEmbeddingControlsComponent, SpatialChartWindowComponent]);
    await TestBed.configureTestingModule({
      imports: [SpatialChartsComponent],
      providers: [{ provide: VISUALIZER, useValue: { getSpatialControls: () => controls } }],
    }).compileComponents();
    fixture = TestBed.createComponent(SpatialChartsComponent);
    component = fixture.componentInstance;
    root = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    await settle();
  });

  afterEach(() => fixture.destroy());

  it('offers the heatmap row only on the heatmap tab, and wires its genes and z-score', async () => {
    expect(root.querySelector('spatial-heatmap-controls')).toBeNull();
    accessorOf(fixture, one(root, 'p-selectButton')).pick('heatmap');
    await settle();
    const row = one(root, 'spatial-heatmap-controls');
    const genes = one(row, 'p-multiSelect');
    expect((genes as unknown as { options: { value: string }[] }).options.map((o) => o.value)).toEqual(['Ttr', 'Mbp']);
    accessorOf(fixture, genes).pick(['Mbp']);
    await settle();
    expect(component['heatmapGenes']).toEqual(['Mbp']);
    fire(genes, 'onFilter', { filter: 'tt' });
    fixture.detectChanges();
    expect(component['geneOptions'].map((o) => o.value)).toEqual(['Mbp', 'Ttr']);
    fire(one(row, 'p-checkbox'), 'onChange', { checked: false });
    expect(component['heatmapZScore']).toBe(false);
  });

  it('offers the embedding picker on the embedding tab, and Detach on every tab', async () => {
    const row = one(root, 'spatial-embedding-controls');
    expect(row.querySelector('p-dropdown')).toBeNull();
    accessorOf(fixture, one(root, 'p-selectButton')).pick('embedding');
    await settle();
    const picker = one(row, 'p-dropdown');
    accessorOf(fixture, picker).pick('X_pca');
    await settle();
    expect(component['embedding']?.name).toBe('X_pca');
    // PCA, no t-SNE, four cells: a t-SNE is offered, with its estimate.
    expect(component['embeddings'].map((e) => e.name)).toContain('local:tsne');

    const detach = Array.from(row.querySelectorAll('p-button')).pop()!;
    expect((detach as unknown as { label: string }).label).toBe('Detach');
    fire(detach, 'onClick');
    fixture.detectChanges();
    expect(component['detached']).toBe(true);
  });

  it('shows the Compute button for a t-SNE to compute, and starts it', async () => {
    const spy = jest.spyOn(component as unknown as { computeEmbedding(): Promise<void> }, 'computeEmbedding')
      .mockResolvedValue();
    accessorOf(fixture, one(root, 'p-selectButton')).pick('embedding');
    await settle();
    accessorOf(fixture, one(root, 'spatial-embedding-controls p-dropdown')).pick('local:tsne');
    await settle();
    const compute = Array.from(root.querySelectorAll('spatial-embedding-controls p-button'))
      .find((b) => (b as unknown as { label?: string }).label?.startsWith('Compute'));
    expect(compute).toBeTruthy();
    fire(compute!, 'onClick');
    expect(spy).toHaveBeenCalled();
  });

  it('opens the detached window with the plot div and the hints, and puts the chart back on close', async () => {
    // Through the embedding controls' Detach output, as a click would: the OnPush panel
    // re-renders on its child's event.
    fixture.debugElement.query(By.directive(SpatialEmbeddingControlsComponent))
      .componentInstance.detachedToggle.emit();
    fixture.detectChanges();
    const window = one(document.body, 'spatial-chart-window');
    expect(window.querySelector(`#${component['detachedDiv']}`)).toBeTruthy();
    expect(root.querySelector(`#${component['chartDiv']}`)).toBeNull();
    expect(window.querySelector('.sx-hint')).toBeTruthy();
    const draw = jest.spyOn(component as unknown as { render: () => Promise<void> }, 'render');
    fire(one(window, 'p-dialog'), 'onShow');
    expect(draw).toHaveBeenCalled();
    fire(one(window, 'p-dialog'), 'visibleChange');
    fixture.detectChanges();
    expect(component['detached']).toBe(false);
    expect(root.querySelector('spatial-chart-window')).toBeNull();
  });
});
