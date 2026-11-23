import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CheckboxModule } from 'primeng/checkbox';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';

import {
  DEFAULT_HEATMAP_ORDER,
  HeatmapGeneOrder,
  HeatmapGroupOrder,
  HeatmapOrder,
} from '../../../spatial/heatmap-order';

/**
 * The heatmap's own controls: the genes its rows are (a filterable multi-select over the
 * dataset's names), whether each gene is z-scored across the columns, and the order of the
 * rows and of the columns.
 *
 * Presentational: the charts panel owns the gene list and the vectors behind it.
 */
@Component({
  selector: 'spatial-heatmap-controls',
  imports: [FormsModule, CheckboxModule, MultiSelectModule, SelectModule, TooltipModule],
  templateUrl: './spatial-heatmap-controls.component.html',
  styleUrls: ['./spatial-heatmap-controls.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialHeatmapControlsComponent {
  /** Above this many options the list scrolls virtually, as the other gene pickers do. */
  protected readonly geneVirtualScrollFrom = 200;
  /** The picker's options: the best matches for the filter, plus the genes chosen. */
  @Input() geneOptions: { label: string; value: string }[] = [];
  /** The options come from the port per keystroke (a whole-transcriptome dataset whose
   *  list is not loaded yet), which changes what an empty list means. */
  @Input() genesAreRemote = false;
  /** The genes the rows are. */
  @Input() genes: string[] = [];
  /** Each gene is z-scored across the groups. */
  @Input() zScore = true;
  /** The order of the rows (genes) and of the columns (groups). */
  @Input() order: HeatmapOrder = DEFAULT_HEATMAP_ORDER;
  /** The genes picked for the rows (none once cleared). */
  @Output() readonly genesChange = new EventEmitter<string[]>();
  /** What is typed in the picker's filter box. */
  @Output() readonly filterChange = new EventEmitter<string>();
  /** The picker opened: its list starts over from the head of the genes. */
  @Output() readonly panelShow = new EventEmitter<void>();
  /** The z-score toggle changed. */
  @Output() readonly zScoreChange = new EventEmitter<boolean>();
  /** A sort order changed. */
  @Output() readonly orderChange = new EventEmitter<HeatmapOrder>();

  protected readonly geneOrderOptions: { label: string; value: HeatmapGeneOrder }[] = [
    { label: 'As picked', value: 'picked' },
    { label: 'By peak group', value: 'peak' },
    { label: 'Clustered', value: 'clustered' },
    { label: 'A–Z', value: 'name' },
  ];
  protected readonly groupOrderOptions: { label: string; value: HeatmapGroupOrder }[] = [
    { label: 'Dataset order', value: 'dataset' },
    { label: 'Clustered', value: 'clustered' },
    { label: 'Most cells first', value: 'cells' },
  ];
}
