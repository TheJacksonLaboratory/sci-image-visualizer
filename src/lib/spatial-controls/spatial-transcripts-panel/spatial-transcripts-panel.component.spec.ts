import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { SpatialTranscriptsPanelComponent } from './spatial-transcripts-panel.component';
import { SpatialGeneTreeComponent } from '../spatial-gene-tree/spatial-gene-tree.component';
import { SpatialMarkerGenesFormComponent } from '../spatial-marker-genes-form/spatial-marker-genes-form.component';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { COLORMAP_OPTIONS } from '../../plot.utilities';
import {
  SpatialControlsFake, TILED_DATASET, bindInputs, fakeSpatialControls, shallowPanel,
} from '../../testing/spatial-panel-testing';

describe('SpatialTranscriptsPanelComponent', () => {
  let fake: SpatialControlsFake;
  let fixture: ComponentFixture<SpatialTranscriptsPanelComponent>;
  let component: SpatialTranscriptsPanelComponent;
  let root: HTMLElement;
  let densityStats$: BehaviorSubject<{ lo: number; hi: number; max: number } | null>;

  const setView = (partial: object) => fake.view$.next({ ...fake.view$.value, ...partial });

  async function build(dataset: SpatialDataset = TILED_DATASET, inputs: Record<string, unknown> = {}) {
    fake.dataset$.next(dataset);
    shallowPanel(SpatialGeneTreeComponent);
    shallowPanel(SpatialMarkerGenesFormComponent);
    shallowPanel(SpatialTranscriptsPanelComponent, [SpatialGeneTreeComponent, SpatialMarkerGenesFormComponent]);
    await TestBed.configureTestingModule({
      imports: [SpatialTranscriptsPanelComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(SpatialTranscriptsPanelComponent);
    component = fixture.componentInstance;
    root = fixture.nativeElement as HTMLElement;
    bindInputs(fixture, {
      controls: fake.controls, dataset: fake.dataset$, view: fake.view$, densityStats: densityStats$,
      colormapOptions: COLORMAP_OPTIONS, open: true, ...inputs,
    });
  }

  beforeEach(() => {
    fake = fakeSpatialControls(TILED_DATASET);
    densityStats$ = new BehaviorSubject<{ lo: number; hi: number; max: number } | null>(null);
  });

  it('offers the modes the dataset can draw, stable between passes', async () => {
    await build();
    expect(component['transcriptModeOptions'].map((o) => o.label)).toEqual(['Points', 'Icons', 'Density Map']);
    // A fresh array per read made PrimeNG re-render the buttons until they were unclickable.
    expect(component['transcriptModeOptions']).toBe(component['transcriptModeOptions']);
    expect(component['geneMenu']).toBe(component['geneMenu']);
  });

  it('the header switch turns transcripts off and back on in the last mode', async () => {
    await build();
    const asked: boolean[] = [];
    component.openChange.subscribe((on) => asked.push(on));
    component['onTranscriptMode']('glyphs');
    component['onTranscriptsOn'](false);
    expect(fake.view$.value.transcriptMode).toBe('off');
    component['onTranscriptsOn'](true);
    expect(fake.view$.value.transcriptMode).toBe('glyphs');
    expect(asked).toEqual([true]); // and the section opens
  });

  it('turns on as a density map for a dataset without tiles', async () => {
    const { transcriptTiles: _tiles, ...densityOnly } = TILED_DATASET;
    void _tiles;
    await build(densityOnly as SpatialDataset);
    component['onTranscriptsOn'](true);
    expect(fake.view$.value.transcriptMode).toBe('density');
  });

  it('seeds the transcript genes from the gene being coloured by', async () => {
    await build();
    setView({ colorBy: { kind: 'feature', name: 'EPCAM' } });
    component['onTranscriptMode']('circles');
    expect(fake.view$.value.transcriptMode).toBe('circles');
    expect(fake.view$.value.transcriptGenes).toEqual(['EPCAM']);
  });

  it('patches the transcript settings', async () => {
    await build();
    component['onTranscriptGenes'](['A']);
    component['onTranscriptQuality'](true);
    component['onTranscriptColorBy']('gene');
    component['onTranscriptScale'](2);
    component['onTranscriptOpacity'](0.5);
    component['onGlyph']('*', 'square');
    expect(fake.view$.value).toEqual(expect.objectContaining({
      transcriptGenes: ['A'], transcriptQuality: 'all', transcriptColorBy: 'gene',
      transcriptScale: 2, transcriptOpacity: 0.5, transcriptGlyphs: { '*': 'square' },
    }));
    expect(component['glyphOf']('*', 0)).toBe('square');
  });

  it('offers every gene, grouped, for a dataset with the pyramid', async () => {
    await build();
    expect(component['canShowAllGenes']).toBe(true);
    expect(component['showingAllGenes']).toBe(false);
    component['onTranscriptMode']('circles');
    component.onTranscriptAllGenes(true);
    expect(component['showingAllGenes']).toBe(true);
    // Density is per gene: the switch does not apply there.
    component['onTranscriptMode']('density');
    expect(component['showingAllGenes']).toBe(false);
    component['onTranscriptBudget'](50_000);
    expect(fake.view$.value.transcriptBudget).toBe(50_000);
    component['onToggleAllGenes']();
    expect(fake.view$.value.transcriptAllGenes).toBe(false);
    fake.dataset$.next({ ...TILED_DATASET, transcriptBins: undefined });
    expect(component['canShowAllGenes']).toBe(false);
  });

  it('says when "All genes" is still being prepared on the server', async () => {
    const { transcriptBins: _bins, ...rest } = TILED_DATASET;
    void _bins;
    await build({ ...rest, transcriptBinsStatus: { state: 'building', done: 25, total: 100 } });
    expect(component['canShowAllGenes']).toBe(false);
    expect(component['allGenesPreparing']).toContain('25%');
    fake.dataset$.next({ ...rest, transcriptBinsStatus: { state: 'failed', message: 'disk full' } });
    expect(component['allGenesPreparing']).toContain('disk full');
    fake.dataset$.next(TILED_DATASET);
    expect(component['allGenesPreparing']).toBeNull();
  });

  it('meters the estimate against the budget', async () => {
    await build(TILED_DATASET, { estimate: { points: 150, max: 100 } });
    expect(component['estimatePercent']).toBe(100);
    expect(component['estimateOverMax']).toBe(true);
    fixture.componentRef.setInput('estimate', { points: 25, max: 100 });
    expect(component['estimatePercent']).toBe(25);
    expect(component['estimateOverMax']).toBe(false);
  });

  describe('the menu', () => {
    const item = (label: string) => component['geneMenu'].find((m) => m.label.startsWith(label))!;

    it('offers marker genes only when the port can find them', async () => {
      await build();
      expect(item('Add marker genes').disabled).toBe(true);
      (fake.controls as unknown as { markerGenes: unknown }).markerGenes = jest.fn();
      fixture.componentRef.setInput('controls', { ...fake.controls });
      fixture.detectChanges();
      expect(item('Add marker genes').disabled).toBe(false);
      item('Add marker genes').command();
      expect(component['markersOpen']).toBe(true);
    });

    it('groups, ungroups and clears the selected genes', async () => {
      await build();
      setView({ transcriptGenes: ['A', 'B'], transcriptGeneGroups: [{ name: 'old', genes: ['A'] }] });
      const prompt = jest.spyOn(globalThis, 'prompt').mockReturnValue(' Mine ');
      item('New group from selected genes').command();
      expect(fake.view$.value.transcriptGeneGroups).toEqual([
        { name: 'old', genes: ['A'] }, { name: 'Mine', genes: ['A', 'B'] },
      ]);
      prompt.mockRestore();
      item('Remove gene groups').command();
      expect(fake.view$.value.transcriptGeneGroups).toEqual([]);
      item('Clear selection').command();
      expect(fake.view$.value.transcriptGenes).toEqual([]);
    });

    it('imports gene groups from a CSV, and says so when it has none', async () => {
      await build();
      const file = (text: string) => ({ files: [{ text: async () => text }], value: 'x' }) as unknown as HTMLInputElement;
      await component['onImportGeneGroups'](file('group,gene\nPlasma,IGHG3\nPlasma,IGKC'));
      expect(fake.view$.value.transcriptGeneGroups).toEqual([{ name: 'Plasma', genes: ['IGHG3', 'IGKC'] }]);
      expect(fake.view$.value.transcriptGenes).toEqual(['IGHG3', 'IGKC']);
      await component['onImportGeneGroups'](file('nothing here'));
      expect(component['geneGroupError']).toMatch(/No "group,gene" rows/);
    });
  });

  describe('the density map', () => {
    beforeEach(async () => {
      await build();
      setView({ transcriptMode: 'density' });
    });

    it('derives its window from the renderer until one is set', () => {
      expect(component['densityWindow']).toEqual([0, 1]);
      densityStats$.next({ lo: 0.1, hi: 0.5, max: 2 });
      expect(component['densityWindow']).toEqual([0.1, 0.5]);
      expect(component['densitySliderMax']).toBe(2);
      // A stored array: the range slider's ngModel must not see a fresh one per pass.
      expect(component['densityWindow']).toBe(component['densityWindow']);
      component['onDensityRange']([0.4, 0.2]);
      expect(fake.view$.value.densityRange).toEqual([0.2, 0.4]);
      expect(component['densityWindow']).toEqual([0.2, 0.4]);
      component['onDensityRangeEnd'](1, 3);
      expect(fake.view$.value.densityRange).toEqual([0.2, 3]);
      expect(component['densitySliderMax']).toBe(3);
      component['onDensityAuto']();
      expect(component['densityWindow']).toEqual([0.1, 0.5]);
    });

    it('writes opacity, bin size and colormap, ignoring empty values', () => {
      component['onDensityOpacity'](0.6);
      component['onDensityOpacityPercent'](1);
      component['onDensityBinIndex'](2);
      expect(fake.view$.value).toEqual(expect.objectContaining({ densityOpacity: 0.05, densityBin: 40 }));
      expect(component['densityBinIndex']).toBe(2);
      (fake.controls.setViewState as jest.Mock).mockClear();
      component['onDensityOpacity'](undefined);
      component['onDensityBinIndex'](undefined);
      component['onDensityRange'](undefined);
      component['onDensityRangeEnd'](0, null);
      expect(fake.controls.setViewState).not.toHaveBeenCalled();

      const bar = component['densityColorBarCss'];
      const magma = COLORMAP_OPTIONS.flatMap((g) => g.children ?? []).find((n) => n.label === 'Magma')!;
      component['onDensityColormap'](magma);
      expect(fake.view$.value.densityColormap).toBe(magma.data!.value);
      expect(component['selectedDensityColormapNode']).toBe(magma);
      expect(component['densityColorBarCss']).not.toBe(bar);
      component['onDensityColormap'](null);
      expect(fake.view$.value.densityColormap).toBeNull();
    });

    it('renders the bin ticks and the threshold row', () => {
      expect(root.querySelectorAll('.sc-ticks span').length).toBe(4);
      expect(root.querySelector('.sc-row-range')).toBeTruthy();
    });
  });
});
