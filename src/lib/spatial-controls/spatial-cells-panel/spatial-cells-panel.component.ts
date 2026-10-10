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
import { CheckboxModule } from 'primeng/checkbox';
import { DropdownModule } from 'primeng/dropdown';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectButtonModule } from 'primeng/selectbutton';
import { SliderModule } from 'primeng/slider';

import type { ISpatialControls } from '../../contracts/visualizer.contract';
import type { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../../contracts/display-types';
import { cellsShown } from '../../spatial/spatial-tiles';
import { PanelOption, densityColorBarCss, tileOptions } from '../../spatial/spatial-panel-model';
import type { GenePickerModel } from '../spatial-gene-picker';
import { SpatialGroupsPanelComponent } from '../spatial-groups-panel/spatial-groups-panel.component';

/**
 * The Cells section, as Xenium Explorer's: the outlines' on/off switch, which boundary set
 * is drawn, how cells are coloured (with the gene, the colour, or the colour bar that
 * goes with it), the {@link SpatialGroupsPanelComponent groups}, and how cells are drawn.
 *
 * Writes only through `controls.setViewState`.
 */
@Component({
  selector: 'spatial-cells-panel',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CheckboxModule,
    DropdownModule,
    InputNumberModule,
    SelectButtonModule,
    SliderModule,
    SpatialGroupsPanelComponent,
  ],
  templateUrl: './spatial-cells-panel.component.html',
  styleUrls: ['./spatial-cells-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialCellsPanelComponent implements OnChanges {
  /** The spatial controls this panel reads and writes through; null without a `SPATIAL_DATA_PORT`. */
  @Input() controls: ISpatialControls | null = null;
  /** The dataset on offer, or null. */
  @Input() dataset: SpatialDataset | null = null;
  /** The current spatial view state: what is drawn, and how. */
  @Input() view: SpatialViewState = DEFAULT_SPATIAL_VIEW;
  /** The gene list the "Gene Expression" colouring picks from, shared with the other
   *  gene dropdowns. */
  @Input() genes: GenePickerModel | null = null;
  /** The observations' continuous colour bar, shown for the gene colouring while it has one. */
  @Input() colorBarCss: string | null = null;
  /** Whether the section is expanded. */
  @Input() open = true;
  /** Asks to open or close it; two-way with `open`. */
  @Output() readonly openChange = new EventEmitter<boolean>();

  /** Virtual-scrolled only past this many options: the scroller earns its complexity for
   *  a few thousand names, and for eight it adds only overhead — a virtual viewport that
   *  short swallows the clicks it is meant to forward. */
  protected readonly geneVirtualScrollFrom = 200;

  protected readonly cellDrawOptions: PanelOption<SpatialViewState['cellDraw']>[] = [
    { label: 'Fill', value: 'fill' },
    { label: 'Outline', value: 'outline' },
    { label: 'Both', value: 'both' },
  ];

  /**
   * Option lists for the cell controls. Built once per dataset rather than in getters: a
   * getter returns a fresh array on every change-detection pass, and PrimeNG re-renders
   * its buttons whenever the array identity changes — which made them impossible to click.
   */
  protected cellSetOptions: PanelOption<string>[] = [];
  /** Cell colour modes on offer (Xenium Explorer's "Cell Color"). */
  protected cellColorOptions: PanelOption<SpatialViewState['cellColorMode']>[] = [];
  /** The density colour bar, rebuilt only when its colormap changes (a 256-entry LUT). */
  protected densityColorBarCss = '';
  private densityBarFor: SpatialViewState['densityColormap'] | undefined = undefined;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['dataset']) {
      const options = tileOptions(this.dataset);
      this.cellSetOptions = options.cellSetOptions;
      this.cellColorOptions = options.cellColorOptions;
    }
    if (this.densityBarFor !== this.view.densityColormap || !this.densityColorBarCss) {
      this.densityBarFor = this.view.densityColormap;
      this.densityColorBarCss = densityColorBarCss(this.view.densityColormap);
    }
  }

  /** Whether outlines are on — the explicit choice, or automatically for data that has them. */
  protected get cellsOn(): boolean {
    return cellsShown(this.dataset, this.view);
  }

  /** The boundary set drawn: the view's choice, else the dataset's default, else its first. */
  protected get activeCellSet(): string | null {
    const tiles = this.dataset?.polygonTiles;
    return this.view.cellSet ?? tiles?.defaultSet ?? tiles?.sets[0]?.name ?? null;
  }

  /** Fill opacity as a 0–100 number, for the box beside the slider. */
  protected get cellOpacityPercent(): number {
    return Math.round(this.view.cellOpacity * 100);
  }

  protected onShowCells(on: boolean): void {
    this.controls?.setViewState({ showCells: on });
  }

  protected onCellSet(set: string): void {
    this.controls?.setViewState({ cellSet: set });
  }

  protected onCellDraw(draw: SpatialViewState['cellDraw']): void {
    this.controls?.setViewState({ cellDraw: draw });
  }

  // PrimeNG's slider reports `number | undefined`; ignore the empty case rather than
  // writing `undefined` into the store.
  protected onCellOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ cellOpacity: value });
  }

  protected onCellOpacityPercent(v: number | null): void {
    if (v === null || !Number.isFinite(v)) return;
    this.controls?.setViewState({ cellOpacity: Math.min(1, Math.max(0.05, v / 100)) });
  }

  protected onCellColorMode(mode: SpatialViewState['cellColorMode']): void {
    this.controls?.setViewState({ cellColorMode: mode });
  }

  protected onCellColorGene(gene: string | null): void {
    this.controls?.setViewState({ cellColorGene: gene });
  }

  protected onCellSingleColor(hex: string): void {
    this.controls?.setViewState({ cellSingleColor: hex });
  }
}
