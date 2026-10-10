import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import { Region } from '../../models/region';
import { PresetSet, defaultPresetSet } from '../../models/class-preset';
import { colorForLabel } from '../../store/class-color.util';
import { PixelSize, formatArea, regionAreaPx } from '../region-metrics';

/** A page change from the paginator. */
export interface RegionPage {
  first: number;
  rows: number;
}

/**
 * The Region Editor's regions table and paginator: one page of rows with a
 * class dropdown (or an inline label editor), the area, and a delete button.
 * Presentational and OnPush: the editor owns the rows, the selection, the
 * paging and the label drafts, and applies every edit through its one
 * copy-on-write commit path — the table never changes a {@link Region}.
 */
@Component({
  selector: 'region-table',
  templateUrl: './region-table.component.html',
  styleUrls: ['./region-table.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegionTableComponent {
  /** The rows on the current page. */
  @Input() page: Region[] = [];
  /** Total number of rows (all pages). */
  @Input() total = 0;
  @Input() first = 0;
  @Input() rows = 10;
  @Input() rowsPerPageOptions = [10, 25, 50];
  /** Ctrl/Cmd-click toggles a row (PrimeNG metaKeySelection). */
  @Input() metaKey = true;

  @Input() selection: Region[] = [];
  /** The table's selection changed (any row click). */
  @Output() selectionChange = new EventEmitter<Region[]>();
  /** A row was selected or unselected (after {@link selectionChange}). */
  @Output() rowSelect = new EventEmitter<void>();

  /** Classes for the per-row dropdown, and their colours. */
  @Input() presetSet: PresetSet = defaultPresetSet();
  /** Swatch colour of an unlabelled row. */
  @Input() defaultColor = '#00FFFF';
  /** Pixel size for the area column. */
  @Input() mpp: PixelSize = {};

  /** Rows whose label is being edited → the typed draft. A new map per start/stop. */
  @Input() labelDrafts = new Map<Region, string>();
  @Output() labelEditStart = new EventEmitter<Region>();
  @Output() labelDraftChange = new EventEmitter<{ region: Region; value: string }>();
  @Output() labelEditStop = new EventEmitter<{ region: Region; commit: boolean }>();

  /** A class was picked in a row's dropdown. */
  @Output() classPick = new EventEmitter<{ region: Region; name: string }>();
  /** A row's trash button: the row's index across all pages. */
  @Output() deleteRow = new EventEmitter<number>();
  @Output() pageChange = new EventEmitter<RegionPage>();

  classColor(name?: string): string {
    return name ? colorForLabel(name, this.presetSet) : this.defaultColor;
  }

  area(region: Region): string {
    return formatArea(regionAreaPx(region), this.mpp);
  }

  startEdit(region: Region, event: Event): void {
    event.stopPropagation(); // don't toggle row selection
    this.labelEditStart.emit(region);
  }

  stopEdit(region: Region, commit: boolean, event: Event): void {
    event.stopPropagation();
    this.labelEditStop.emit({ region, commit });
  }

  onPage(event: { first?: number; rows?: number }): void {
    this.pageChange.emit({ first: event.first ?? 0, rows: event.rows ?? this.rows });
  }
}
