import {
  ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SharedModule } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DropdownModule } from 'primeng/dropdown';
import { InputTextModule } from 'primeng/inputtext';
import { PaginatorModule } from 'primeng/paginator';
import { RippleModule } from 'primeng/ripple';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';

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
  standalone: true,
  imports: [
    CommonModule, FormsModule, SharedModule, ButtonModule, DropdownModule, InputTextModule, PaginatorModule,
    RippleModule, TableModule, TooltipModule,
  ],
  templateUrl: './region-table.component.html',
  styleUrls: ['./region-table.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegionTableComponent implements OnChanges {
  /** The rows on the current page. */
  @Input() page: Region[] = [];
  /** Total number of rows (all pages). */
  @Input() total = 0;
  /** Index of the page's first row across all pages. */
  @Input() first = 0;
  /** Rows per page. */
  @Input() rows = 10;
  /** The paginator's rows-per-page choices. */
  @Input() rowsPerPageOptions = [10, 25, 50];
  /** Ctrl/Cmd-click toggles a row (PrimeNG metaKeySelection). */
  @Input() metaKey = true;

  /** The selected rows. */
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
  /** A row's pencil: start editing its label. */
  @Output() labelEditStart = new EventEmitter<Region>();
  /** The inline label editor's text changed. */
  @Output() labelDraftChange = new EventEmitter<{ region: Region; value: string }>();
  /** The inline label editor closed: Enter commits, Escape / close cancels. */
  @Output() labelEditStop = new EventEmitter<{ region: Region; commit: boolean }>();

  /** A class was picked in a row's dropdown. */
  @Output() classPick = new EventEmitter<{ region: Region; name: string }>();
  /** A row's trash button: the row's index across all pages. */
  @Output() deleteRow = new EventEmitter<number>();
  /** The paginator moved or changed its page size. */
  @Output() pageChange = new EventEmitter<RegionPage>();

  /** Per row of {@link page}: its class swatch colour and formatted area, derived when
   *  an input changes instead of per check (the area walks the region's geometry). */
  protected rowView = new Map<Region, { color: string; area: string }>();

  ngOnChanges(): void {
    this.rowView = new Map(this.page.map((r) => [r, { color: this.classColor(r.label), area: this.area(r) }]));
  }

  private classColor(name?: string): string {
    return name ? colorForLabel(name, this.presetSet) : this.defaultColor;
  }

  private area(region: Region): string {
    return formatArea(regionAreaPx(region), this.mpp);
  }

  protected startEdit(region: Region, event: Event): void {
    event.stopPropagation(); // don't toggle row selection
    this.labelEditStart.emit(region);
  }

  protected stopEdit(region: Region, commit: boolean, event: Event): void {
    event.stopPropagation();
    this.labelEditStop.emit({ region, commit });
  }

  protected onPage(event: { first?: number; rows?: number }): void {
    this.pageChange.emit({ first: event.first ?? 0, rows: event.rows ?? this.rows });
  }
}
