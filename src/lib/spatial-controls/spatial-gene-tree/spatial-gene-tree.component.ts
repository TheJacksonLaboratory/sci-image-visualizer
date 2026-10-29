import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  NgZone,
  OnChanges,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SharedModule } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { OverlayPanelModule } from 'primeng/overlaypanel';
import { TooltipModule } from 'primeng/tooltip';

import type { ISpatialControls } from '../../contracts/visualizer.contract';
import type { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { ALL_GENES } from '../../contracts/ports/spatial-data.port';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState, TranscriptGlyphName } from '../../contracts/display-types';
import { parseCssColor, rgbToHex } from '../../contracts/color';
import { DEFAULT_CATEGORICAL_PALETTE } from '../../spatial/spatial-encoding';
import { cellTypeColumnFor, clusterColorMap, clusterOfGene, defaultGlyphFor } from '../../spatial/spatial-tiles';
import {
  GLYPH_OPTIONS,
  GeneTreeNode,
  buildGeneTree,
  glyphPoints,
  toggleHidden,
} from '../../spatial/spatial-panel-model';
import { allGeneShownBy, allGenesHidden, toggleAllGeneHidden } from '../../spatial/spatial-tile-merge';
import { Supersede } from '../../util/supersede';

/** Rows of the all-genes list drawn at once; the filter narrows the rest. */
const ALL_GENES_ROWS = 200;

/** One gene row as the template draws it, derived once per input change. */
interface GeneRowView {
  shown: boolean;
  swatch: string;
  /** The row's glyph outline (drawn in Icons mode). */
  points: string;
  /** Transcripts in view, or null before the renderer reports any. */
  count: number | null;
}

/** One row of the all-genes list. */
interface AllGeneRowView {
  gene: string;
  shown: boolean;
  /** Its colour when coloured by gene, or null when the dataset's code order is unknown. */
  swatch: string | null;
  count: number | null;
}

/**
 * The selected transcript genes as Xenium Explorer's tree: the gene groups, then the
 * ungrouped genes, each row with an eye that hides it without deselecting it, its marker
 * in its colour (opening one icon-and-colour picker per gene), and its transcript count in
 * view. With "All genes" on, the root eye hides or shows every transcript and the root
 * expands to every gene of the dataset, each with its eye when the dataset lists its genes
 * in code order (`transcriptTiles.genes`), filtered by name past a few hundred.
 *
 * Writes only through `controls.setViewState`.
 */
@Component({
  selector: 'spatial-gene-tree',
  standalone: true,
  imports: [CommonModule, SharedModule, ButtonModule, InputTextModule, OverlayPanelModule, TooltipModule],
  templateUrl: './spatial-gene-tree.component.html',
  styleUrls: ['./spatial-gene-tree.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialGeneTreeComponent implements OnChanges {
  /** The spatial controls this panel reads and writes through; null without a `SPATIAL_DATA_PORT`. */
  @Input() controls: ISpatialControls | null = null;
  /** The dataset on offer, or null. */
  @Input() dataset: SpatialDataset | null = null;
  /** The current spatial view state: what is drawn, and how. */
  @Input() view: SpatialViewState = DEFAULT_SPATIAL_VIEW;
  /** Transcripts of each selected gene in the current view, from the renderer. */
  @Input() geneCounts: Record<string, number> | null = null;
  /** Real genes in the panel — the tree's denominator. */
  @Input() geneTotal = 0;

  protected readonly glyphOptions = GLYPH_OPTIONS;
  /** Swatches in the picker: the categorical palette genes are coloured from by default. */
  protected readonly colorPresets = DEFAULT_CATEGORICAL_PALETTE.slice(0, 10).map((c) => c.toLowerCase());

  /** The tree, rebuilt when the view changes — never per change-detection pass. */
  protected geneTree: GeneTreeNode[] = [];
  /** Per gene: its eye, swatch, glyph and count — rebuilt with the inputs (and when the
   *  cells' group colours arrive), so the template does no per-row lookups per check. */
  protected rows = new Map<string, GeneRowView>();
  /** Per named group, and for the root: whether any of its genes is shown. */
  protected groupShown = new Map<string, boolean>();
  protected rootShown = false;
  protected collapsedGeneGroups = new Set<string>();
  protected geneTreeOpen = true;
  /** The all-genes list starts closed: it can run to thousands of genes. */
  protected allGenesOpen = false;
  /** The genes "All genes" lists, or null when the dataset names none. */
  protected allGeneList: readonly string[] | null = null;
  /** Whether a gene of "All genes" can be hidden: the dataset lists its genes in code order. */
  protected canHideAllGenes = false;
  protected allGenesFilter = '';
  /** The list's rows matching the filter, at most {@link ALL_GENES_ROWS}. */
  protected allRows: AllGeneRowView[] = [];
  /** How many genes match the filter, for the "showing n of m" line. */
  protected allGenesMatched = 0;
  protected readonly allGenesRowCap = ALL_GENES_ROWS;
  /** The gene the open picker edits. */
  protected styleGene: string | null = null;

  /** Colours of the cells' groups, by name — what a cluster of the same name is drawn in. */
  private cellGroupColors = new Map<string, string>();
  /** The grouping {@link cellGroupColors} belongs to — a repeat request for it is a no-op. */
  private cellGroupColorsFor: string | null | undefined = undefined;
  /** Latest wins among colour loads for {@link cellGroupColors}. */
  private readonly cellGroupColorsLoad = new Supersede();

  constructor(
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['view']) this.geneTree = buildGeneTree(this.view.transcriptGenes, this.view.transcriptGeneGroups);
    // A same-named grouping of a new dataset is not the old one.
    if (changes['dataset']) {
      this.cellGroupColorsFor = undefined;
      const coded = this.dataset?.transcriptTiles?.genes;
      this.canHideAllGenes = !!coded?.length;
      this.allGeneList = coded?.length ? coded : (this.dataset?.features?.names ?? null);
    }
    this.rebuildRows();
    void this.refreshCellGroupColors();
  }

  private rebuildRows(): void {
    const genes = this.view.transcriptGenes;
    this.rows = new Map(
      genes.map((gene, slot) => [
        gene,
        {
          shown: this.isGeneShown(gene),
          swatch: this.geneSwatchOf(gene),
          points: glyphPoints(this.glyphOf(gene, slot)),
          count: this.geneCountOf(gene),
        },
      ]),
    );
    this.groupShown = new Map(
      this.geneTree
        .filter((node) => node.name)
        .map((node) => [node.name as string, this.areGenesShown(node.genes)]),
    );
    this.rootShown = this.view.transcriptAllGenes ? this.anyOfAllGenesShown() : this.areGenesShown(genes);
    this.rebuildAllRows();
  }

  /**
   * The all-genes list's rows: the genes matching the filter, up to the cap. Built only while
   * the list is open: the counts in view change with every pan, and the list can be thousands.
   */
  private rebuildAllRows(): void {
    const list = this.view.transcriptAllGenes && this.allGenesOpen ? this.allGeneList : null;
    if (!list) {
      this.allRows = [];
      this.allGenesMatched = 0;
      return;
    }
    const needle = this.allGenesFilter.trim().toLowerCase();
    const shown = allGeneShownBy(this.view.transcriptAllGenesHidden);
    const rows: AllGeneRowView[] = [];
    let matched = 0;
    list.forEach((gene, code) => {
      // An empty name is a code no transcript carries (a control probe).
      if (!gene || (needle && !gene.toLowerCase().includes(needle))) return;
      matched++;
      if (rows.length >= ALL_GENES_ROWS) return;
      rows.push({
        gene,
        shown: shown(gene),
        swatch: this.canHideAllGenes ? this.allGeneColorOf(gene, code) : null,
        count: this.geneCountOf(gene),
      });
    });
    this.allRows = rows;
    this.allGenesMatched = matched;
  }

  /** Whether "All genes" draws anything: not switched off whole, nor every listed gene hidden. */
  private anyOfAllGenesShown(): boolean {
    if (allGenesHidden(this.view)) return false;
    if (!this.canHideAllGenes || !this.allGeneList) return true;
    const shown = allGeneShownBy(this.view.transcriptAllGenesHidden);
    return this.allGeneList.some((g) => g && shown(g));
  }

  /** A gene of "All genes" in its colour by gene: its chosen one, else the palette's by code. */
  private allGeneColorOf(gene: string, code: number): string {
    return (
      this.view.transcriptGeneColors[gene] ||
      DEFAULT_CATEGORICAL_PALETTE[code % DEFAULT_CATEGORICAL_PALETTE.length]
    );
  }

  protected toggleAllGenesOpen(): void {
    this.allGenesOpen = !this.allGenesOpen;
    this.rebuildAllRows();
  }

  protected onAllGenesFilter(text: string): void {
    this.allGenesFilter = text;
    this.rebuildAllRows();
  }

  protected toggleGeneGroup(name: string): void {
    const next = new Set(this.collapsedGeneGroups);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this.collapsedGeneGroups = next;
  }

  protected isGeneShown(gene: string): boolean {
    return !this.view.transcriptHiddenGenes.includes(gene);
  }

  protected areGenesShown(genes: string[]): boolean {
    return genes.some((g) => this.isGeneShown(g));
  }

  /** The eye toggle: hide or show genes without removing them from the selection. */
  protected onGenesShown(genes: string[], on: boolean): void {
    this.controls?.setViewState({
      transcriptHiddenGenes: toggleHidden(this.view.transcriptHiddenGenes, genes, on),
    });
  }

  /** The root eye while every gene is drawn: hide or show them all (the '±' leaves "All genes"). */
  protected onAllGenesShown(on: boolean): void {
    this.controls?.setViewState({ transcriptAllGenesHidden: on ? [] : [ALL_GENES] });
  }

  /** One gene's eye in the all-genes list. Showing one while all are off shows it alone. */
  protected onAllGeneShown(gene: string, on: boolean): void {
    if (!this.canHideAllGenes) return;
    this.controls?.setViewState({
      transcriptAllGenesHidden: toggleAllGeneHidden(this.view.transcriptAllGenesHidden, gene, on),
    });
  }

  protected onGeneColor(gene: string, hex: string): void {
    this.controls?.setViewState({ transcriptGeneColors: { ...this.view.transcriptGeneColors, [gene]: hex } });
  }

  // ── per-gene icon and colour picker ──────────────────────────────────────

  protected openGeneStyle(event: Event, gene: string, panel: { toggle(e: Event): void; hide(): void }): void {
    if (this.styleGene === gene) {
      panel.toggle(event);
      return;
    }
    this.styleGene = gene;
    panel.hide();
    // Re-open anchored on the row that was clicked, once the panel has closed.
    setTimeout(() => panel.toggle(event));
  }

  /** The icon the open picker shows as chosen. */
  protected get styleGlyph(): TranscriptGlyphName | null {
    const gene = this.styleGene;
    return gene ? this.glyphOf(gene, Math.max(0, this.view.transcriptGenes.indexOf(gene))) : null;
  }

  protected glyphPoints(glyph: TranscriptGlyphName): string {
    return glyphPoints(glyph);
  }

  protected glyphOf(gene: string, slot: number): TranscriptGlyphName {
    return this.view.transcriptGlyphs[gene] ?? defaultGlyphFor(slot);
  }

  protected onGlyph(gene: string, glyph: TranscriptGlyphName): void {
    this.controls?.setViewState({ transcriptGlyphs: { ...this.view.transcriptGlyphs, [gene]: glyph } });
  }

  /** A typed hex colour, accepted as `#rrggbb` or `rrggbb`; anything else is ignored. */
  protected onGeneHex(gene: string, text: string): void {
    const t = text.trim();
    const rgb = /^#?[0-9a-f]{6}$/i.test(t) ? parseCssColor(t) : null;
    if (rgb) this.onGeneColor(gene, rgbToHex(rgb));
  }

  /** Back to the gene's default icon and colour (by its position in the list). */
  protected resetGeneStyle(gene: string): void {
    const colors = { ...this.view.transcriptGeneColors };
    const glyphs = { ...this.view.transcriptGlyphs };
    delete colors[gene];
    delete glyphs[gene];
    this.controls?.setViewState({ transcriptGeneColors: colors, transcriptGlyphs: glyphs });
  }

  // ── colours and counts ──────────────────────────────────────────────────

  /** The colour gene `slot` is drawn in when transcripts are coloured by gene. */
  geneColor(slot: number): string {
    const gene = this.view?.transcriptGenes[slot];
    return (
      (gene && this.view.transcriptGeneColors[gene]) ||
      DEFAULT_CATEGORICAL_PALETTE[slot % DEFAULT_CATEGORICAL_PALETTE.length]
    );
  }

  protected geneColorOf(gene: string): string {
    return this.geneColor(Math.max(0, this.view.transcriptGenes.indexOf(gene)));
  }

  /** In Cluster colouring, a gene's swatch is its cluster's colour, as its markers are. */
  protected geneSwatchOf(gene: string): string {
    if (this.view.transcriptColorBy !== 'cluster') return this.geneColorOf(gene);
    return this.clusterColors().get(clusterOfGene(gene, this.view.transcriptGeneGroups)) ?? this.geneColorOf(gene);
  }

  protected geneCountOf(gene: string): number | null {
    return this.geneCounts ? (this.geneCounts[gene] ?? 0) : null;
  }

  protected trackByNode = (_i: number, node: { name: string | null }) => node.name ?? '';
  protected trackByLabelString = (_i: number, s: string) => s;
  protected trackByAllRow = (_i: number, row: AllGeneRowView) => row.gene;

  /**
   * The cluster colours, rebuilt only when what they come from changes. The template asks
   * once per gene row per change-detection pass, and rebuilding per call made that O(G²).
   */
  private clusterColors(): Map<string, string> {
    const { transcriptGenes: genes, transcriptGeneGroups: groups } = this.view;
    const hit = this.clusterColorMemo;
    if (hit && hit.genes === genes && hit.groups === groups && hit.cellColors === this.cellGroupColors) {
      return hit.colors;
    }
    const colors = clusterColorMap(genes, groups, this.cellGroupColors, DEFAULT_CATEGORICAL_PALETTE);
    this.clusterColorMemo = { genes, groups, cellColors: this.cellGroupColors, colors };
    return colors;
  }
  private clusterColorMemo: {
    genes: SpatialViewState['transcriptGenes'];
    groups: SpatialViewState['transcriptGeneGroups'];
    cellColors: Map<string, string>;
    colors: Map<string, string>;
  } | null = null;

  private async refreshCellGroupColors(): Promise<void> {
    const column = this.dataset ? cellTypeColumnFor(this.dataset, this.view) : null;
    if (column === this.cellGroupColorsFor) return;
    this.cellGroupColorsFor = column;
    const task = this.cellGroupColorsLoad.next();
    const map = new Map<string, string>();
    const meta = column ? this.dataset?.columns.find((c) => c.name === column) : null;
    if (meta && meta.kind === 'categorical' && this.controls) {
      try {
        const colors = await this.controls.categoryColors(column!);
        meta.categories.forEach((c, k) => {
          if (colors[k]) map.set(c, colors[k]);
        });
      } catch {
        // No colours: palette colours, as the markers fall back to.
      }
    }
    // The cells' grouping changed while the colours loaded: the newer request applies its own.
    if (!task.isCurrent()) return;
    this.zone.run(() => {
      this.cellGroupColors = map;
      this.rebuildRows();
      this.cdr.markForCheck();
    });
  }
}
