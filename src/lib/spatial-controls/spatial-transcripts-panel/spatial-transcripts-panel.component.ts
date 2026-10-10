import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnChanges,
  Output, SimpleChanges, ViewChild,
} from '@angular/core';

import type { ISpatialControls } from '../../contracts/visualizer.contract';
import type { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import {
  ColormapNode, DEFAULT_SPATIAL_VIEW, SpatialViewState, TranscriptGlyphName,
} from '../../contracts/display-types';
import { defaultGlyphFor } from '../../spatial/spatial-tiles';
import {
  GLYPH_OPTIONS, PanelOption, allGenesPreparingNote, densityColorBarCss, importGeneGroupsPatch,
  markerColumnOptions, parseGeneGroups, tileOptions,
} from '../../spatial/spatial-panel-model';
import type { GenePickerModel } from '../spatial-gene-picker';
import { colormapNodeFor } from '../spatial-key/spatial-key.component';

/** One item of the gene list's '⋮' menu. */
export interface GeneMenuItem {
  label: string;
  icon: string;
  command: () => void;
  disabled?: boolean;
}

/**
 * The Transcripts section, as Xenium Explorer's: the on/off switch, the transcript genes
 * (with "All genes", the '⋮' menu and gene-group import), the
 * {@link SpatialMarkerGenesFormComponent marker-genes form}, the
 * {@link SpatialGeneTreeComponent gene tree}, how transcripts are drawn — the points
 * estimate against its budget, colouring, icon, size, opacity and quality — and the
 * density map's opacity, bin size, threshold window and colormap.
 *
 * Writes only through `controls.setViewState`.
 */
@Component({
  selector: 'spatial-transcripts-panel',
  templateUrl: './spatial-transcripts-panel.component.html',
  styleUrls: ['./spatial-transcripts-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialTranscriptsPanelComponent implements OnChanges {
  @Input() controls: ISpatialControls | null = null;
  @Input() dataset: SpatialDataset | null = null;
  @Input() view: SpatialViewState = DEFAULT_SPATIAL_VIEW;
  /** The gene list the transcript genes are picked from, shared with the other gene dropdowns. */
  @Input() genes: GenePickerModel | null = null;
  /** Estimated transcripts in view, against the budget — Explorer's points bar. */
  @Input() estimate: { points: number; max: number } | null = null;
  /** The density window in use and its densest bin, for the threshold control. */
  @Input() densityStats: { lo: number; hi: number; max: number } | null = null;
  /** Transcripts of each selected gene in the current view, from the renderer. */
  @Input() geneCounts: Record<string, number> | null = null;
  /** Colormap tree for the density map's colouring. */
  @Input() colormapOptions: ColormapNode[] = [];
  /** Whether the section is expanded. */
  @Input() open = false;
  @Output() readonly openChange = new EventEmitter<boolean>();

  /** Virtual-scrolled only past this many options (see the cells panel's gene dropdown). */
  readonly geneVirtualScrollFrom = 200;
  readonly transcriptColorOptions: PanelOption<SpatialViewState['transcriptColorBy']>[] = [
    { label: 'Cluster', value: 'cluster' }, { label: 'Cell type', value: 'cellType' }, { label: 'Gene', value: 'gene' },
  ];
  readonly glyphOptions = GLYPH_OPTIONS;
  readonly budgetOptions = [25_000, 50_000, 100_000, 200_000, 400_000]
    .map((n) => ({ label: n.toLocaleString(), value: n }));
  readonly densityBins = [10, 20, 40, 80];

  /**
   * Transcript modes on offer. Built once per dataset rather than in a getter: a getter
   * returns a fresh array on every change-detection pass, and PrimeNG re-renders its
   * buttons whenever the array identity changes — which made them impossible to click.
   */
  transcriptModeOptions: PanelOption<SpatialViewState['transcriptMode']>[] = [];
  /** The '⋮' menu, rebuilt when what enables its items changes. */
  geneMenu: GeneMenuItem[] = [];
  editingMax = false;
  /** Whether the marker-genes form is shown. */
  markersOpen = false;
  geneGroupError: string | null = null;

  /**
   * The threshold window shown: the one set, else the one derived. A stored array, not a
   * getter: a range slider's `ngModel` given a fresh array every change-detection pass
   * schedules another pass, forever — which hung the page the moment the density
   * controls appeared.
   */
  densityWindow: [number, number] = [0, 1];
  densitySliderMax = 1;
  densityStep = 0.005;
  selectedDensityColormapNode: ColormapNode | null = null;
  /** Built once per density colormap: a 256-entry LUT per change-detection pass is waste. */
  densityColorBarCss = '';
  private densityBarFor: SpatialViewState['densityColormap'] | undefined = undefined;

  /** The mode the section header's switch turns back on. */
  private lastTranscriptMode: Exclude<SpatialViewState['transcriptMode'], 'off'> = 'circles';
  /** Whether any column can supply marker genes' clusters. */
  private hasMarkerColumns = false;

  /** The hidden file input the menu's import opens. */
  @ViewChild('geneGroupFile') private geneGroupFileRef?: ElementRef<HTMLInputElement>;

  constructor(
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['dataset']) {
      this.transcriptModeOptions = tileOptions(this.dataset).transcriptModeOptions;
      this.hasMarkerColumns = markerColumnOptions(this.dataset?.columns).length > 0;
    }
    if (changes['view'] || changes['dataset'] || changes['controls']) this.geneMenu = this.buildGeneMenu();
    if (changes['view'] || changes['colormapOptions']) {
      this.selectedDensityColormapNode = colormapNodeFor(this.colormapOptions, this.view.densityColormap);
    }
    if (this.densityBarFor !== this.view.densityColormap || !this.densityColorBarCss) {
      this.densityBarFor = this.view.densityColormap;
      this.densityColorBarCss = densityColorBarCss(this.view.densityColormap);
    }
    this.refreshDensityWindow();
  }

  // ── the section switch and the genes ────────────────────────────────────

  onTranscriptsOn(on: boolean): void {
    if (!on) {
      if (this.view.transcriptMode !== 'off') this.lastTranscriptMode = this.view.transcriptMode;
      this.controls?.setViewState({ transcriptMode: 'off' });
      return;
    }
    const mode = this.dataset?.transcriptTiles ? this.lastTranscriptMode : 'density';
    this.onTranscriptMode(mode);
    this.openChange.emit(true);
  }

  onTranscriptMode(mode: SpatialViewState['transcriptMode']): void {
    // Seed the gene list from the gene being coloured by, so switching transcripts on
    // shows something straight away.
    const seed = !this.view.transcriptGenes.length && this.view.colorBy?.kind === 'feature'
      ? [this.view.colorBy.name] : null;
    this.controls?.setViewState({ transcriptMode: mode, ...(seed ? { transcriptGenes: seed } : {}) });
  }

  onTranscriptGenes(genes: string[] | null): void {
    this.controls?.setViewState({ transcriptGenes: [...(genes ?? [])] });
  }

  /** Real genes in the panel — the tree's denominator. */
  get geneTotal(): number {
    return this.dataset?.transcriptTiles?.geneCount ?? this.dataset?.features?.count
      ?? this.genes?.residentCount ?? 0;
  }

  /** "All genes" needs the grouping pyramid, or at least tiles to draw individually. */
  get canShowAllGenes(): boolean {
    return !!this.dataset?.transcriptBins;
  }

  /** Why "All genes" is not offered yet, while the server builds its pyramid. */
  get allGenesPreparing(): string | null {
    return allGenesPreparingNote(this.dataset);
  }

  get showingAllGenes(): boolean {
    return this.canShowAllGenes && this.view.transcriptAllGenes && this.view.transcriptMode !== 'density';
  }

  onTranscriptAllGenes(on: boolean): void {
    this.controls?.setViewState({ transcriptAllGenes: on });
  }

  /** '±': every gene, or back to the chosen list. */
  onToggleAllGenes(): void {
    if (!this.canShowAllGenes) return;
    this.onTranscriptAllGenes(!this.view.transcriptAllGenes);
  }

  get canAddMarkers(): boolean {
    return !!this.controls?.markerGenes && this.hasMarkerColumns;
  }

  /** Open the marker-genes form (from the '⋮' menu). */
  openMarkers(): void {
    this.markersOpen = true;
    this.openChange.emit(true);
    this.cdr.markForCheck();
  }

  onNewGeneGroup(): void {
    const name = (globalThis.prompt?.('Name for this gene group', 'Gene group') ?? '').trim();
    if (!name) return;
    const groups = this.view.transcriptGeneGroups.filter((g) => g.name !== name);
    this.controls?.setViewState({
      transcriptGeneGroups: [...groups, { name, genes: [...this.view.transcriptGenes] }],
    });
  }

  /**
   * Import gene groups: CSV/TSV with a group and a gene column (header optional), e.g.
   * marker genes per cell type. The genes are added to the selection.
   */
  async onImportGeneGroups(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.geneGroupError = null;
    const groups = parseGeneGroups(await file.text());
    this.zone.run(() => {
      if (!groups.length) this.geneGroupError = 'No "group,gene" rows found in that file.';
      else this.controls?.setViewState(importGeneGroupsPatch(this.view, groups));
      this.cdr.markForCheck();
    });
  }

  // ── how transcripts are drawn ───────────────────────────────────────────

  get estimatePercent(): number {
    const e = this.estimate;
    return e && e.max > 0 ? Math.min(100, (100 * e.points) / e.max) : 0;
  }

  get estimateOverMax(): boolean {
    return !!this.estimate && this.estimate.points > this.estimate.max;
  }

  onTranscriptBudget(n: number): void {
    this.controls?.setViewState({ transcriptBudget: n });
  }

  onTranscriptColorBy(by: SpatialViewState['transcriptColorBy']): void {
    this.controls?.setViewState({ transcriptColorBy: by });
  }

  // PrimeNG's slider reports `number | undefined`; ignore the empty case rather than
  // writing `undefined` into the store.
  onTranscriptScale(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ transcriptScale: value });
  }

  onTranscriptOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ transcriptOpacity: value });
  }

  onTranscriptQuality(includeLow: boolean): void {
    this.controls?.setViewState({ transcriptQuality: includeLow ? 'all' : 'high' });
  }

  glyphOf(gene: string, slot: number): TranscriptGlyphName {
    return this.view.transcriptGlyphs[gene] ?? defaultGlyphFor(slot);
  }

  onGlyph(gene: string, glyph: TranscriptGlyphName): void {
    this.controls?.setViewState({ transcriptGlyphs: { ...this.view.transcriptGlyphs, [gene]: glyph } });
  }

  // ── density map ─────────────────────────────────────────────────────────

  get densityOpacityPercent(): number {
    return Math.round(this.view.densityOpacity * 100);
  }

  onDensityOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ densityOpacity: value });
  }

  onDensityOpacityPercent(v: number | null): void {
    if (v === null || !Number.isFinite(v)) return;
    this.controls?.setViewState({ densityOpacity: Math.min(1, Math.max(0.05, v / 100)) });
  }

  get densityBinIndex(): number {
    return Math.max(0, this.densityBins.indexOf(this.view.densityBin));
  }

  onDensityBinIndex(i: number | undefined): void {
    if (i === undefined) return;
    this.controls?.setViewState({ densityBin: this.densityBins[i] ?? 10 });
  }

  onDensityRange(range: [number, number] | number[] | undefined): void {
    if (!range || range.length !== 2) return;
    this.controls?.setViewState({ densityRange: [Math.min(range[0], range[1]), Math.max(range[0], range[1])] });
  }

  onDensityRangeEnd(which: 0 | 1, v: number | null): void {
    if (v === null || !Number.isFinite(v)) return;
    const next: [number, number] = [...this.densityWindow];
    next[which] = v;
    this.onDensityRange(next);
  }

  onDensityAuto(): void {
    this.controls?.setViewState({ densityRange: null });
  }

  onDensityColormap(node: ColormapNode | null): void {
    this.selectedDensityColormapNode = node;
    this.controls?.setViewState({ densityColormap: node?.data?.value ?? null });
  }

  private refreshDensityWindow(): void {
    const next: [number, number] = this.view.densityRange
      ?? (this.densityStats ? [this.densityStats.lo, this.densityStats.hi] : [0, 1]);
    if (next[0] !== this.densityWindow[0] || next[1] !== this.densityWindow[1]) this.densityWindow = next;
    this.densitySliderMax = Math.max(this.densityStats?.max ?? 1, this.densityWindow[1]);
    this.densityStep = this.densitySliderMax / 200;
  }

  /** '⋮' menu. */
  private buildGeneMenu(): GeneMenuItem[] {
    return [
      {
        label: 'Add marker genes of clusters…', icon: 'pi pi-sitemap',
        disabled: !this.canAddMarkers, command: () => this.openMarkers(),
      },
      {
        label: 'New group from selected genes', icon: 'pi pi-folder-plus',
        disabled: !this.view.transcriptGenes.length, command: () => this.onNewGeneGroup(),
      },
      {
        label: 'Import gene groups (CSV)…', icon: 'pi pi-upload',
        command: () => this.geneGroupFileRef?.nativeElement.click(),
      },
      {
        label: 'Remove gene groups', icon: 'pi pi-times',
        disabled: !this.view.transcriptGeneGroups.length,
        command: () => this.controls?.setViewState({ transcriptGeneGroups: [] }),
      },
      {
        label: 'Clear selection', icon: 'pi pi-ban', disabled: !this.view.transcriptGenes.length,
        command: () => this.controls?.setViewState({ transcriptGenes: [], transcriptHiddenGenes: [] }),
      },
    ];
  }
}
