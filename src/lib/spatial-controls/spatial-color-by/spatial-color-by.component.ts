import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DropdownModule } from 'primeng/dropdown';
import { SelectButtonModule } from 'primeng/selectbutton';

import type { ISpatialControls } from '../../contracts/visualizer.contract';
import type { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { ColormapNode, DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../../contracts/display-types';
import { cellTypeColumnFor } from '../../spatial/lod';
import type { PanelOption } from '../../spatial/spatial-panel-model';
import type { GenePickerModel } from '../spatial-gene-picker';
import { SpatialGroupsPanelComponent } from '../spatial-groups-panel/spatial-groups-panel.component';
import type { SpatialLegendEntry } from '../spatial-key/spatial-key.model';
import { SpatialKeyComponent } from '../spatial-key/spatial-key.component';

/** What colours the observations: a grouping, a gene, a measurement, or one colour. */
export type ColorByMode = 'group' | 'gene' | 'measure' | 'single';

/**
 * The Observations section's "Colour by": one colouring for the markers and the cells alike —
 * a grouping (the {@link SpatialGroupsPanelComponent groups} with their colours and switches),
 * one gene's expression, a measurement (a numeric column), or one colour. Each choice writes
 * the markers' colour source (`colorBy`) and the cells' (`cellColorMode` and its own fields)
 * together, so the two cannot disagree.
 *
 * Writes only through `controls.setViewState`.
 */
@Component({
  selector: 'spatial-color-by',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DropdownModule,
    SelectButtonModule,
    SpatialGroupsPanelComponent,
    SpatialKeyComponent,
  ],
  templateUrl: './spatial-color-by.component.html',
  styleUrls: ['./spatial-color-by.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialColorByComponent implements OnChanges {
  /** The spatial controls this panel reads and writes through; null without a `SPATIAL_DATA_PORT`. */
  @Input() controls: ISpatialControls | null = null;
  /** The dataset on offer, or null. */
  @Input() dataset: SpatialDataset | null = null;
  /** The current spatial view state. */
  @Input() view: SpatialViewState = DEFAULT_SPATIAL_VIEW;
  /** The gene list the gene colouring picks from, shared with the other gene dropdowns. */
  @Input() genes: GenePickerModel | null = null;
  /** The key's categorical legend, or null (continuous). */
  @Input() legend: SpatialLegendEntry[] | null = null;
  /** The key's continuous colour bar (a CSS gradient), or null. */
  @Input() colorBarCss: string | null = null;
  /** The selected category (its code), for highlighting its group. */
  @Input() selectedCategory: number | null = null;
  /** Colormap tree for the continuous colour scale. */
  @Input() colormapOptions: ColormapNode[] = [];
  /** A group was clicked: its category's code, to select its observations. */
  @Output() readonly categoryClicked = new EventEmitter<number>();

  /** Virtual-scrolled only past this many options (see the gene dropdowns elsewhere). */
  protected readonly geneVirtualScrollFrom = 200;
  /** The modes the dataset can be coloured in. */
  protected modeOptions: PanelOption<ColorByMode>[] = [];
  /** The dataset's numeric columns. */
  protected measureOptions: PanelOption<string>[] = [];
  /** A mode picked before its gene or measurement is: shown, nothing written yet. */
  private pending: ColorByMode | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['dataset']) {
      const columns = this.dataset?.columns ?? [];
      this.measureOptions = columns
        .filter((c) => c.kind === 'continuous')
        .map((c) => ({
          label: c.kind === 'continuous' && c.unit ? `${c.name} (${c.unit})` : c.name,
          value: c.name,
        }));
      this.modeOptions = [
        ...(columns.some((c) => c.kind === 'categorical') ? [{ label: 'Group', value: 'group' as const }] : []),
        ...(this.dataset?.features ? [{ label: 'Gene', value: 'gene' as const }] : []),
        ...(this.measureOptions.length ? [{ label: 'Measurement', value: 'measure' as const }] : []),
        { label: 'Single colour', value: 'single' as const },
      ];
      this.pending = null;
    }
    if (changes['view'] && this.pending && this.pending === this.viewMode) this.pending = null;
  }

  /** The mode on show: one picked and waiting for its value, else what the view is coloured by. */
  protected get mode(): ColorByMode | null {
    return this.pending ?? this.viewMode;
  }

  /** What the view is coloured by, as a mode; null for the flat default. */
  private get viewMode(): ColorByMode | null {
    const by = this.view.colorBy;
    if (!by) return this.view.cellColorMode === 'single' ? 'single' : null;
    if (by.kind === 'feature') return 'gene';
    const meta = this.dataset?.columns.find((c) => c.name === by.name);
    if (!meta) return null;
    return meta.kind === 'categorical' ? 'group' : 'measure';
  }

  /** The gene the observations are coloured by, or null. */
  protected get selectedGene(): string | null {
    return this.view.colorBy?.kind === 'feature' ? this.view.colorBy.name : null;
  }

  /** The measurement the observations are coloured by, or null. */
  protected get selectedMeasure(): string | null {
    const by = this.view.colorBy;
    return by?.kind === 'column' && this.measureOptions.some((o) => o.value === by.name) ? by.name : null;
  }

  protected onMode(mode: ColorByMode | null): void {
    if (!mode || mode === this.mode) return;
    this.pending = null;
    switch (mode) {
      case 'group': {
        const name = this.dataset ? cellTypeColumnFor(this.dataset, this.view) : null;
        if (name) {
          this.controls?.setViewState({
            cellTypeColumn: name,
            cellColorMode: 'group',
            colorBy: { kind: 'column', name },
          });
        }
        return;
      }
      case 'gene':
        if (this.view.cellColorGene) this.onGene(this.view.cellColorGene);
        else this.pending = 'gene';
        return;
      case 'measure':
        this.pending = 'measure';
        return;
      case 'single':
        this.controls?.setViewState({ colorBy: null, cellColorMode: 'single' });
        return;
    }
  }

  /** Colour the markers and the cells by gene `name`. */
  protected onGene(name: string | null): void {
    if (!name) return;
    this.pending = null;
    this.controls?.setViewState({
      colorBy: { kind: 'feature', name },
      logScale: !!this.dataset?.features?.logScaleHint,
      cellColorMode: 'gene',
      cellColorGene: name,
    });
  }

  /** Colour the markers and the cells by measurement `name`. */
  protected onMeasure(name: string | null): void {
    if (!name) return;
    this.pending = null;
    const meta = this.dataset?.columns.find((c) => c.name === name);
    this.controls?.setViewState({
      colorBy: { kind: 'column', name },
      logScale: meta?.kind === 'continuous' ? !!meta.logScaleHint : false,
      cellColorMode: 'column',
    });
  }

  protected onSingleColor(hex: string): void {
    this.controls?.setViewState({ cellSingleColor: hex, colorBy: null, cellColorMode: 'single' });
  }
}
