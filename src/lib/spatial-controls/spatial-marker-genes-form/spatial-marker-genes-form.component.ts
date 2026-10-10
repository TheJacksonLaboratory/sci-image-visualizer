import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, NgZone, OnChanges, Output,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DropdownModule } from 'primeng/dropdown';
import { MultiSelectModule } from 'primeng/multiselect';

import type { ISpatialControls } from '../../contracts/visualizer.contract';
import type { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../../contracts/display-types';
import { cellTypeColumnFor } from '../../spatial/spatial-tiles';
import {
  PanelOption, markerColumnOptions, markerGeneGroups, markerGenesPatch,
} from '../../spatial/spatial-panel-model';

/**
 * "Add marker genes of clusters": pick a grouping, how many genes per cluster and which
 * clusters, and each picked cluster's top marker genes are added as a gene group named
 * after it — and selected, coloured by cluster.
 *
 * Shown while {@link open}; it closes itself (through {@link openChange}) once the genes
 * are added. Writes only through `controls.setViewState`.
 */
@Component({
  selector: 'spatial-marker-genes-form',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, DropdownModule, MultiSelectModule],
  templateUrl: './spatial-marker-genes-form.component.html',
  styleUrls: ['./spatial-marker-genes-form.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialMarkerGenesFormComponent implements OnChanges {
  /** The spatial controls this panel reads and writes through; null without a `SPATIAL_DATA_PORT`. */
  @Input() controls: ISpatialControls | null = null;
  /** The dataset on offer, or null. */
  @Input() dataset: SpatialDataset | null = null;
  /** The current spatial view state: what is drawn, and how. */
  @Input() view: SpatialViewState = DEFAULT_SPATIAL_VIEW;
  /** Whether the form is shown. Opening it picks the cells' grouping and every cluster. */
  @Input() open = false;
  /** Asks to open or close it; two-way with `open`. */
  @Output() readonly openChange = new EventEmitter<boolean>();

  protected markerColumn: string | null = null;
  protected markerPerGroup = 5;
  protected readonly markerPerGroupOptions = [3, 5, 10, 20].map((n) => ({ label: `${n} genes`, value: n }));
  protected markerClusters: string[] = [];
  protected markerClusterOptions: PanelOption<string>[] = [];
  protected markerLoading = false;
  protected markerError: string | null = null;
  /**
   * Every categorical column but the segmentation method, which says nothing about genes.
   * Rebuilt with the dataset, never per change-detection pass: a fresh array per pass makes
   * PrimeNG re-render the options, and an option re-rendered under the pointer swallows
   * the click.
   */
  protected markerColumnOptions: PanelOption<string>[] = [];

  constructor(
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['dataset']) this.markerColumnOptions = markerColumnOptions(this.dataset?.columns);
    if (changes['open'] && this.open) this.prepare();
  }

  protected onMarkerColumn(column: string): void {
    this.markerColumn = column;
    this.refreshMarkerClusters();
  }

  protected close(): void {
    this.open = false;
    this.openChange.emit(false);
  }

  /**
   * Add each picked cluster's top marker genes as a gene group named after it, and select
   * them. A gene that marks several clusters goes to the one it is most specific to, so the
   * tree lists it once.
   */
  protected async addMarkerGenes(): Promise<void> {
    const column = this.markerColumn;
    const markerGenes = this.controls?.markerGenes;
    if (!column || !markerGenes || !this.markerClusters.length) return;
    // The form stays editable while the scan runs: apply what was picked when it was asked.
    const picked = new Set(this.markerClusters);
    this.markerLoading = true;
    this.markerError = null;
    try {
      const result = await markerGenes(column, this.markerPerGroup);
      this.apply(() => {
        const groups = markerGeneGroups(result, picked);
        if (!groups.length) {
          this.markerError = 'No marker genes passed the filter for the chosen clusters.';
          return;
        }
        this.controls?.setViewState(markerGenesPatch(this.view, groups));
        this.close();
      });
    } catch (err) {
      this.apply(() => {
        const e = err as { error?: { error?: string }; message?: string };
        this.markerError = e?.error?.error ?? e?.message ?? 'Could not compute marker genes.';
      });
    } finally {
      this.apply(() => { this.markerLoading = false; });
    }
  }

  /** On opening: the cells' grouping (or the last column picked, while it still exists),
   *  every one of its clusters, and no stale error. */
  private prepare(): void {
    const options = this.markerColumnOptions;
    const active = this.dataset ? cellTypeColumnFor(this.dataset, this.view) : null;
    if (!this.markerColumn || !options.some((o) => o.value === this.markerColumn)) {
      this.markerColumn = active && options.some((o) => o.value === active) ? active : options[0]?.value ?? null;
    }
    this.markerError = null;
    this.refreshMarkerClusters();
  }

  /** The clusters of the chosen column, all picked to start with. */
  private refreshMarkerClusters(): void {
    const col = this.dataset?.columns.find((c) => c.name === this.markerColumn);
    const categories = col && col.kind === 'categorical' ? col.categories : [];
    this.markerClusterOptions = categories.map((c) => ({ label: c, value: c }));
    this.markerClusters = [...categories];
  }

  /** Apply an async result inside the zone and re-render this OnPush form. */
  private apply(fn: () => void): void {
    this.zone.run(() => {
      fn();
      this.cdr.markForCheck();
    });
  }
}
