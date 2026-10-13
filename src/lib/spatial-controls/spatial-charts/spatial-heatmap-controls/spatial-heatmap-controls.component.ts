import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CheckboxModule } from 'primeng/checkbox';
import { MultiSelectModule } from 'primeng/multiselect';
import { TooltipModule } from 'primeng/tooltip';

/**
 * The heatmap's own controls: the genes its rows are (a filterable multi-select over the
 * dataset's names) and whether each gene is z-scored across the columns.
 *
 * Presentational: the charts panel owns the gene list and the vectors behind it.
 */
@Component({
  selector: 'spatial-heatmap-controls',
  standalone: true,
  imports: [CommonModule, FormsModule, CheckboxModule, MultiSelectModule, TooltipModule],
  templateUrl: './spatial-heatmap-controls.component.html',
  styleUrls: ['./spatial-heatmap-controls.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialHeatmapControlsComponent {
  /** The picker's options: the best matches for the filter, plus the genes chosen. */
  @Input() geneOptions: { label: string; value: string }[] = [];
  /** The genes the rows are. */
  @Input() genes: string[] = [];
  /** Each gene is z-scored across the groups. */
  @Input() zScore = true;
  /** The genes picked for the rows. */
  @Output() readonly genesChange = new EventEmitter<string[]>();
  /** What is typed in the picker's filter box. */
  @Output() readonly filterChange = new EventEmitter<string>();
  /** The z-score toggle changed. */
  @Output() readonly zScoreChange = new EventEmitter<boolean>();
}
