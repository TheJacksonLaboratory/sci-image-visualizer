import {
  ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SharedModule } from 'primeng/api';
import { TooltipModule } from 'primeng/tooltip';
import { TreeSelectModule } from 'primeng/treeselect';

import type { ISpatialControls } from '../../contracts/visualizer.contract';
import type { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import {
  ColormapNode, ColormapValue, DEFAULT_SPATIAL_VIEW, SpatialViewState,
} from '../../contracts/display-types';
import type { SpatialLegendEntry } from './spatial-key.model';

/**
 * The key for the active colouring: its name, a description when the column is derived,
 * and either a categorical legend whose rows select their category or a continuous colour
 * bar with the colormap picker that drives it.
 *
 * Presentational over {@link SpatialKeyModel}, which the dialog keeps (the rest of the
 * panel needs to know whether the colouring is categorical even while the key is not on
 * screen). Writes only the continuous colormap, through `controls.setViewState`; a legend
 * click goes up as {@link categoryClicked}, because the selection is the dialog's.
 */
@Component({
  selector: 'spatial-key',
  standalone: true,
  imports: [CommonModule, FormsModule, SharedModule, TooltipModule, TreeSelectModule],
  templateUrl: './spatial-key.component.html',
  styleUrls: ['./spatial-key.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialKeyComponent implements OnChanges {
  /** The spatial controls this panel reads and writes through; null without a `SPATIAL_DATA_PORT`. */
  @Input() controls: ISpatialControls | null = null;
  /** The dataset on offer, or null. */
  @Input() dataset: SpatialDataset | null = null;
  /** The current spatial view state: what is drawn, and how. */
  @Input() view: SpatialViewState = DEFAULT_SPATIAL_VIEW;
  /** The categorical legend, or null for a continuous (or no) colouring. */
  @Input() legend: SpatialLegendEntry[] | null = null;
  /** The continuous colour bar's CSS gradient, or null. */
  @Input() colorBarCss: string | null = null;
  /** The legend row whose category is selected, for highlighting. */
  @Input() selectedCategory: number | null = null;
  /**
   * Colormap tree for the continuous colour scale: the library's own `COLORMAP_OPTIONS`,
   * shown with the same swatches the image's colormap picker uses — choosing a gradient
   * is a visual decision, so a list of names would be the wrong control.
   */
  @Input() colormapOptions: ColormapNode[] = [];
  /** A legend row was clicked: select that category (or clear it, when it is selected). */
  @Output() readonly categoryClicked = new EventEmitter<number>();

  /** The node currently picked from {@link colormapOptions}. */
  protected selectedColormapNode: ColormapNode | null = null;
  /** Label for the current colouring, for the key's heading. */
  protected colorByLabel = 'Flat colour';
  /**
   * Description of the active column, when it has one. Surfaced because a DERIVED column
   * (k-means clusters, QC totals computed at conversion) must not read as though it came
   * with the data.
   */
  protected activeDescription: string | null = null;

  ngOnChanges(): void {
    const by = this.view.colorBy;
    this.colorByLabel = colorByLabel(this.view);
    this.activeDescription = by?.kind === 'column'
      ? this.dataset?.columns.find((c) => c.name === by.name)?.description ?? null
      : null;
    this.selectedColormapNode = colormapNodeFor(this.colormapOptions, this.view.continuousColormap);
  }

  /** True when the active colouring is a categorical column. */
  protected get isCategorical(): boolean {
    return this.legend !== null;
  }

  /** Whether the colour bar applies: there is a colouring, and it is not categorical. */
  protected get isContinuous(): boolean {
    return !!this.view.colorBy && this.legend === null;
  }

  /**
   * The continuous colour scale's colormap. Clearing it goes back to following the
   * image's, which is the default.
   */
  /** Keeps the legend rows across a refresh of the same categories (one per category). */
  protected readonly trackByLabel = (_: number, entry: SpatialLegendEntry): string => entry.label;

  protected onContinuousColormap(node: ColormapNode | null): void {
    this.selectedColormapNode = node;
    // The value is a ColormapValue, which is a NAME for the built-in scales and an
    // inline `[stop, colour]` array for the rest — half the library's colormaps
    // are the array kind, so anything that only accepts a string silently drops
    // them. A group row carries no value and clears the setting.
    this.controls?.setViewState({ continuousColormap: node?.data?.value ?? null });
  }
}

/** Label for `view`'s colouring, for the key's heading. */
export function colorByLabel(view: Pick<SpatialViewState, 'colorBy'>): string {
  const by = view.colorBy;
  if (!by) return 'Flat colour';
  return by.kind === 'feature' ? `Gene · ${by.name}` : by.name;
}

/** The tree node holding a colormap value, so the picker shows what is in use. */
export function colormapNodeFor(
  options: readonly ColormapNode[], value: ColormapValue | null,
): ColormapNode | null {
  if (!value) return null;
  for (const group of options) {
    for (const node of group.children ?? []) {
      // Reference equality: the value came out of this same tree, and an inline
      // scale is a 256-entry array not worth comparing element by element.
      if (node.data?.value === value) return node;
    }
    if (group.data?.value === value) return group;
  }
  return null;
}
