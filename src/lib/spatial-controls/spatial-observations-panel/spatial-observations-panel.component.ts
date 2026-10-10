import {
  ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CheckboxModule } from 'primeng/checkbox';
import { DropdownModule } from 'primeng/dropdown';
import { SliderModule } from 'primeng/slider';
import { TooltipModule } from 'primeng/tooltip';

import type { ISpatialControls } from '../../contracts/visualizer.contract';
import type { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { ColormapNode, DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../../contracts/display-types';
import { SPATIAL_3D_MAX_CATEGORIES } from '../../spatial/spatial-encoding';
import { SpatialSelectionMask, emptySelection } from '../../spatial/spatial-selection';
import {
  CLIP_OPTIONS, PanelOption, columnOptions, middleSection, sectionLabel,
} from '../../spatial/spatial-panel-model';
import type { GenePickerModel } from '../spatial-gene-picker';
import type { SpatialLegendEntry } from '../spatial-key/spatial-key.model';
import { SpatialKeyComponent } from '../spatial-key/spatial-key.component';

/**
 * The Observations section — one marker per observation (cell centroid, Visium spot) — and
 * what else draws them: what colours them (a column or a gene, mutually exclusive, with
 * the {@link SpatialKeyComponent key}), point size and opacity, the gene map, the 3D scene
 * (volume, cloud, sections, density volumes) and the continuous-only knobs.
 *
 * Renders the section and the sections after it as siblings in the dialog body
 * (`display: contents`). Writes only through the port: `setViewState`, and the colour
 * source's own `colorByColumn` / `colorByFeature` / `clearColorBy`.
 */
@Component({
  selector: 'spatial-observations-panel',
  standalone: true,
  imports: [
    CommonModule, FormsModule, CheckboxModule, DropdownModule, SliderModule, TooltipModule,
    SpatialKeyComponent,
  ],
  templateUrl: './spatial-observations-panel.component.html',
  styleUrls: ['./spatial-observations-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialObservationsPanelComponent implements OnChanges {
  /** The spatial controls this panel reads and writes through; null without a `SPATIAL_DATA_PORT`. */
  @Input() controls: ISpatialControls | null = null;
  /** The dataset on offer, or null. */
  @Input() dataset: SpatialDataset | null = null;
  /** The current spatial view state: what is drawn, and how. */
  @Input() view: SpatialViewState = DEFAULT_SPATIAL_VIEW;
  /** The gene list "Colour by gene" picks from, shared with the other gene dropdowns. */
  @Input() genes: GenePickerModel | null = null;
  /** The key's categorical legend, or null — which also decides the continuous knobs. */
  @Input() legend: SpatialLegendEntry[] | null = null;
  /** The key's continuous colour bar (a CSS gradient), or null when categorical. */
  @Input() colorBarCss: string | null = null;
  /** The current selection (its count, and what is muted). */
  @Input() selection: SpatialSelectionMask = emptySelection();
  /** The legend row whose category is selected, for highlighting. */
  @Input() selectedCategory: number | null = null;
  /** Colormap tree for the continuous colour scale. */
  @Input() colormapOptions: ColormapNode[] = [];
  /** Set while the 3D cloud is the active mode. */
  @Input() is3d = false;
  /** Whether the Observations section is expanded. */
  @Input() open = false;
  /** Asks to open or close it; two-way with `open`. */
  @Output() readonly openChange = new EventEmitter<boolean>();
  /** A legend row was clicked (see the key). */
  @Output() readonly categoryClicked = new EventEmitter<number>();

  protected readonly clipOptions = CLIP_OPTIONS;
  /** Virtual-scrolled only past this many options (see the cells panel's gene dropdown). */
  protected readonly geneVirtualScrollFrom = 200;

  /** Colour-by column choices — "None" plus every column the dataset declares. */
  protected columnOptions: PanelOption<string | null>[] = [];
  protected selectedColumn: string | null = null;
  protected selectedGene: string | null = null;
  /**
   * The dataset's imaged section positions, or null when its z is continuous rather than
   * sectioned. Read once per dataset — the scan walks the z of every observation, so it
   * must not sit in a template getter.
   */
  protected sections: Float32Array | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['dataset'] || changes['controls']) {
      this.columnOptions = columnOptions(this.dataset);
      // A new dataset almost certainly has different columns; drop stale UI state.
      this.selectedGene = null;
      this.sections = this.controls?.sampledSections() ?? null;
    }
    if (changes['view']) {
      this.selectedColumn = this.view.colorBy?.kind === 'column' ? this.view.colorBy.name : null;
      this.selectedGene = this.view.colorBy?.kind === 'feature' ? this.view.colorBy.name : null;
    }
  }

  // ── colour source ───────────────────────────────────────────────────────

  /** Column dropdown. Choosing a column supersedes any gene selection. */
  protected onColumn(name: string | null): void {
    this.selectedColumn = name;
    this.selectedGene = null;
    if (!name) {
      this.controls?.clearColorBy();
      return;
    }
    this.controls?.colorByColumn(name);
  }

  /** A gene was picked; it supersedes any column selection. */
  protected onGene(name: string | null): void {
    this.selectedGene = name;
    if (!name) {
      this.controls?.clearColorBy();
      return;
    }
    this.selectedColumn = null;
    this.controls?.colorByFeature(name);
  }

  /** Cell outlines on offer, which changes what the circles mean. */
  protected get hasCells(): boolean {
    return !!(this.dataset?.polygonTiles || this.dataset?.polygons);
  }

  /** True while a selection is active — everything else renders muted. */
  get hasSelection(): boolean {
    return this.selection.count > 0;
  }

  /** Whether log/clip apply — they are continuous-only knobs. */
  protected get isContinuous(): boolean {
    return !!this.view.colorBy && this.legend === null;
  }

  // ── display ─────────────────────────────────────────────────────────────

  // PrimeNG's slider reports `number | undefined`; ignore the empty case rather
  // than writing `undefined` into the store and rendering NaN-sized markers.
  protected onPointScale(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ pointScale: value });
  }
  protected onOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ opacity: value });
  }
  protected onLogScale(on: boolean): void {
    this.controls?.setViewState({ logScale: on });
  }
  /**
   * Set when the active categorical colouring has more categories than the 3D
   * cloud can keep apart, so the points are drawing FLAT.
   *
   * Said in the panel rather than left to a console warning: `subclass` (338) is
   * served precisely because the density volumes and the 2D view can render it, and
   * a user who picks it in the cloud and sees one colour deserves to know both why
   * and what to do instead.
   */
  protected get exceedsCloudPalette(): boolean {
    return this.is3d && (this.legend?.length ?? 0) > SPATIAL_3D_MAX_CATEGORIES;
  }
  /** The ceiling itself, for the message. */
  protected readonly cloudPaletteLimit = SPATIAL_3D_MAX_CATEGORIES;

  protected onGeneMap(on: boolean): void {
    this.controls?.setViewState({ geneMap: on });
  }
  /** 3D: smooth the per-section sheets along z into a continuous volume. */
  protected onGeneMapVolume(on: boolean): void {
    this.controls?.setViewState({ geneMapVolume: on });
  }
  /** 3D: restrict the sheets to one imaged section. */
  protected onGeneMapOneSection(on: boolean): void {
    if (!on) {
      this.controls?.setViewState({ geneMapSection: null });
      return;
    }
    this.controls?.setViewState({ geneMapSection: middleSection(this.sections) });
  }
  protected onGeneMapSection(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ geneMapSection: value });
  }
  protected get geneMapOneSection(): boolean {
    return this.view.geneMapSection != null;
  }
  /** "12 of 53" for the gene map's own section, 1-based like the cloud's. */
  protected get geneMapSectionLabel(): string {
    return sectionLabel(this.sections, this.view.geneMapSection);
  }
  protected onGeneMapSmoothing(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ geneMapSmoothing: value });
  }
  protected onGeneMapOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ geneMapOpacity: value });
  }
  /**
   * What the 3D gene map is currently showing, said plainly — the sheets are a
   * measurement and the volume is an estimate, and the panel has to be the place
   * that says which one is on screen.
   */
  protected get geneMapVolumeNote(): string {
    const total = this.sections?.length ?? 0;
    if (this.view.geneMapVolume) {
      return 'Interpolated along z: the planes between the imaged sections carry an '
        + 'ESTIMATE, smoothed from their neighbours\' mean. Nothing is drawn beyond the '
        + 'outermost section.';
    }
    if (this.geneMapOneSection) {
      return 'One imaged section\'s field — measured, not interpolated. Hide the '
        + 'observations to read it, or leave them on to check the field against them.';
    }
    return `One field per imaged section${total ? ` (${total})` : ''}, at its own depth, `
      + 'with the gaps between sections empty. Kernel-weighted mean per cell, not a sum.';
  }

  /** True while a gene is the colour source — the only thing a gene map can map. */
  protected get canMapGene(): boolean {
    return this.view.colorBy?.kind === 'feature';
  }

  // ── what the 3D scene draws ─────────────────────────────────────────────
  // The volume, the cloud and the density volumes share one space, so each one
  // hides the others to some degree. Independent toggles because the useful views
  // are the combinations, not a single "3D mode".

  protected onShowVolume(on: boolean): void {
    this.controls?.setViewState({ showVolume: on });
  }
  protected onVolumeOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ volumeOpacity: value });
  }
  protected onShowPoints(on: boolean): void {
    this.controls?.setViewState({ showPoints: on });
  }
  /** The "one section at a time" switch: null restores the whole stack. */
  protected onOneSection(on: boolean): void {
    if (!on) {
      this.controls?.setViewState({ pointSection: null });
      return;
    }
    // Open in the middle of the stack rather than on the first section, which for
    // a brain is a nearly empty olfactory-bulb slide.
    this.controls?.setViewState({ pointSection: middleSection(this.sections) });
  }
  protected onPointSection(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ pointSection: value });
  }
  /** True while the cloud is restricted to a single section. */
  protected get oneSection(): boolean {
    return this.view.pointSection != null;
  }
  /** Highest section index the slider can reach. */
  protected get lastSection(): number {
    return Math.max(0, (this.sections?.length ?? 1) - 1);
  }
  /** "12 of 53" — 1-based, because the sections are slides, not array slots. */
  protected get sectionLabel(): string {
    return sectionLabel(this.sections, this.view.pointSection);
  }
  /** Whether this dataset has sections to pick from at all. */
  protected get isSectioned(): boolean {
    return (this.sections?.length ?? 0) > 1;
  }

  protected onDensityVolume(on: boolean): void {
    this.controls?.setViewState({ densityVolume: on });
  }
  protected onDensitySmoothing(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ densitySmoothing: value });
  }

  /** What the density volumes are actually showing, said plainly — an estimate is
   *  only honest if the reader knows it is one, and which clusters are in view. */
  protected get densityNote(): string {
    const capped = `the ${SpatialObservationsPanelComponent.DENSITY_MAX_CLUSTERS} largest clusters`;
    const what = this.legend ? capped : this.hasSelection ? 'the selected cells' : 'all cells';
    return `Density estimate over ${what} — smoothed between the imaged sections, `
      + 'not measured cells. Lower Opacity to read the fields under the cloud.';
  }

  /** Mirrors the renderer's cap, for the note only. */
  private static readonly DENSITY_MAX_CLUSTERS = 6;
  protected onClip(value: [number, number]): void {
    this.controls?.setViewState({ percentileClip: value });
  }
}
