import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { SpatialGeneTreeComponent } from './spatial-gene-tree.component';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import {
  SpatialControlsFake, TILED_DATASET, bindInputs, fakeSpatialControls, shallowPanel,
} from '../../testing/spatial-panel-testing';

describe('SpatialGeneTreeComponent', () => {
  let fake: SpatialControlsFake;
  let fixture: ComponentFixture<SpatialGeneTreeComponent>;
  let component: SpatialGeneTreeComponent;
  let root: HTMLElement;

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const setView = (partial: object) => fake.view$.next({ ...fake.view$.value, ...partial });

  async function build(inputs: Record<string, unknown> = {}) {
    shallowPanel(SpatialGeneTreeComponent);
    await TestBed.configureTestingModule({ imports: [SpatialGeneTreeComponent] }).compileComponents();
    fixture = TestBed.createComponent(SpatialGeneTreeComponent);
    component = fixture.componentInstance;
    root = fixture.nativeElement as HTMLElement;
    bindInputs(fixture, {
      controls: fake.controls, dataset: fake.dataset$, view: fake.view$, geneTotal: 27000, ...inputs,
    });
    await flush();
  }

  beforeEach(() => {
    fake = fakeSpatialControls(TILED_DATASET);
  });

  it('draws each row from the derived row view: eye, swatch and count follow the inputs', async () => {
    await build();
    fake.controls.setViewState({
      transcriptGenes: ['DMBT1', 'KRT5'], transcriptGeneColors: { KRT5: '#123456' },
      transcriptHiddenGenes: ['DMBT1'],
    });
    fixture.componentRef.setInput('geneCounts', { KRT5: 9 });
    fixture.detectChanges();
    const leaves = Array.from(root.querySelectorAll('.sc-gene-leaf'));
    expect(leaves.map((l) => l.querySelector('.sc-eye i')!.classList.contains('pi-eye'))).toEqual([false, true]);
    expect((leaves[1].querySelector('.sc-gene-icon') as HTMLElement).style.color).toBe('rgb(18, 52, 86)');
    expect(leaves.map((l) => l.querySelector('.sc-gene-count')?.textContent?.trim())).toEqual(['0', '9']);
    // The root eye is open while any gene is shown.
    expect(root.querySelector('.sc-gene-root .sc-eye i')!.classList.contains('pi-eye')).toBe(true);
  });

  it('builds the selected-genes tree from gene groups, and hides genes with the eye', async () => {
    await build();
    fake.controls.setViewState({
      transcriptGenes: ['DMBT1', 'MUC5AC', 'KRT5'],
      transcriptGeneGroups: [{ name: 'Endocervical', genes: ['DMBT1', 'MUC5AC', 'PIGR'] }],
    });
    expect(component['geneTree']).toEqual([
      { name: 'Endocervical', genes: ['DMBT1', 'MUC5AC'] },
      { name: null, genes: ['KRT5'] },
    ]);
    // Rebuilt with the view, never per change-detection pass.
    expect(component['geneTree']).toBe(component['geneTree']);
    expect(root.querySelectorAll('.sc-gene-leaf').length).toBe(3);
    component['onGenesShown'](['DMBT1', 'MUC5AC'], false);
    expect(fake.view$.value.transcriptHiddenGenes).toEqual(['DMBT1', 'MUC5AC']);
    expect(component['areGenesShown'](['DMBT1', 'MUC5AC'])).toBe(false);
    component['onGeneColor']('KRT5', '#123456');
    expect(component['geneColorOf']('KRT5')).toBe('#123456');
    // A collapsed group hides its genes, not the others.
    (root.querySelector('.sc-gene-group .sc-icon-btn') as HTMLElement).click();
    fixture.detectChanges();
    expect(component['collapsedGeneGroups'].has('Endocervical')).toBe(true);
    expect(root.querySelectorAll('.sc-gene-leaf').length).toBe(1);
  });

  it('counts the selection against the panel, every gene when all are shown', async () => {
    await build();
    setView({ transcriptGenes: ['A', 'B'] });
    expect(root.querySelector('.sc-gene-footer')?.textContent?.trim()).toBe('2/27,000 genes selected');
    setView({ transcriptAllGenes: true });
    expect(root.querySelector('.sc-gene-footer')?.textContent?.trim()).toBe('27,000/27,000 genes selected');
    // The root eye then goes back to the chosen list.
    (root.querySelector('.sc-gene-root .sc-eye') as HTMLElement).click();
    expect(fake.view$.value.transcriptAllGenes).toBe(false);
  });

  it('gives each gene a glyph by position until one is chosen', async () => {
    await build();
    expect(component['glyphOf']('A', 0)).toBe('circle');
    expect(component['glyphOf']('B', 1)).toBe('star');
    component['onGlyph']('B', 'hexagon');
    expect(fake.view$.value.transcriptGlyphs).toEqual({ B: 'hexagon' });
    expect(component['glyphOf']('B', 1)).toBe('hexagon');
  });

  it('opens one icon and colour picker per gene, as Xenium Explorer does', async () => {
    await build();
    jest.useFakeTimers();
    setView({ transcriptGenes: ['A', 'B'] });
    const panel = { toggle: jest.fn(), hide: jest.fn() };
    const click = new MouseEvent('click');
    component['openGeneStyle'](click, 'B', panel);
    expect(component['styleGene']).toBe('B');
    expect(component['styleGlyph']).toBe('star'); // B's default, by position
    jest.runAllTimers();
    expect(panel.toggle).toHaveBeenCalledWith(click);
    // Clicking the same gene again just toggles the panel.
    component['openGeneStyle'](click, 'B', panel);
    expect(panel.toggle).toHaveBeenCalledTimes(2);
    // Choosing an icon and a colour writes the view state; the picker follows it.
    component['onGlyph']('B', 'diamond');
    expect(component['styleGlyph']).toBe('diamond');
    component['onGeneColor']('B', component['colorPresets'][3]);
    expect(fake.view$.value.transcriptGeneColors).toEqual({ B: component['colorPresets'][3] });
    jest.useRealTimers();
  });

  it('accepts a typed hex colour with or without #, and ignores anything else', async () => {
    await build();
    component['onGeneHex']('A', ' 43BCE7 ');
    expect(fake.view$.value.transcriptGeneColors).toEqual({ A: '#43bce7' });
    component['onGeneHex']('A', '#zzzzzz');
    component['onGeneHex']('A', '#123');
    expect(fake.view$.value.transcriptGeneColors).toEqual({ A: '#43bce7' });
  });

  it("resets a gene's icon and colour to its defaults, leaving the others", async () => {
    await build();
    setView({
      transcriptGenes: ['A', 'B'],
      transcriptGlyphs: { A: 'x', B: 'hexagon' }, transcriptGeneColors: { A: '#111111', B: '#222222' },
    });
    component['resetGeneStyle']('A');
    expect(fake.view$.value.transcriptGlyphs).toEqual({ B: 'hexagon' });
    expect(fake.view$.value.transcriptGeneColors).toEqual({ B: '#222222' });
    expect(component['glyphOf']('A', 0)).toBe('circle');
  });

  it("in Cluster colouring, shows every gene of a cluster in the cluster's colour", async () => {
    await build();
    setView({
      transcriptColorBy: 'cluster', transcriptGenes: ['A', 'B', 'C'],
      transcriptGeneGroups: [{ name: 'K1', genes: ['A', 'B'] }],
    });
    expect(component['geneSwatchOf']('A')).toBe(component['geneSwatchOf']('B'));
    expect(component['geneSwatchOf']('C')).not.toBe(component['geneSwatchOf']('A'));
    setView({ transcriptColorBy: 'gene' });
    expect(component['geneSwatchOf']('A')).not.toBe(component['geneSwatchOf']('B')); // per gene again
  });

  it('draws each glyph for the picker and the gene rows', async () => {
    await build();
    expect(component['glyphOptions']).toHaveLength(10);
    for (const o of component['glyphOptions']) expect(component['glyphPoints'](o.value)).toBe(o.points);
  });

  it("shows the renderer's per-gene counts in view, 0 for a gene with none", async () => {
    const counts$ = new BehaviorSubject<Record<string, number> | null>(null);
    await build({ geneCounts: counts$ });
    expect(component['geneCountOf']('CD163')).toBeNull();
    counts$.next({ CD163: 17 });
    expect(component['geneCountOf']('CD163')).toBe(17);
    expect(component['geneCountOf']('CD163L1')).toBe(0);
  });

  it("reloads the group colours for a new dataset's same-named grouping", async () => {
    const groupColors = () => (component as unknown as { cellGroupColors: Map<string, string> }).cellGroupColors;
    fake.controls.categoryColors.mockResolvedValueOnce(['#f00', '#0f0']).mockResolvedValueOnce(['#00f', '#ff0']);
    await build();
    expect([...groupColors().values()]).toEqual(['#f00', '#0f0']);

    fake.dataset$.next({ ...TILED_DATASET, id: 'other' } as SpatialDataset);
    await flush();
    expect([...groupColors().values()]).toEqual(['#00f', '#ff0']);
  });
});
