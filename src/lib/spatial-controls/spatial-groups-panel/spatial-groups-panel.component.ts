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
import { FormsModule } from '@angular/forms';
import { SharedModule } from 'primeng/api';
import { CheckboxModule } from 'primeng/checkbox';
import { DropdownModule } from 'primeng/dropdown';

import type { ISpatialControls } from '../../contracts/visualizer.contract';
import type { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../../contracts/display-types';
import { cellTypeColumnFor } from '../../spatial/spatial-tiles';
import {
  FAMILY_PREFIX,
  GroupOptionSection,
  GroupRow,
  PanelOption,
  countGroupRows,
  familyMembers,
  groupEntryFor,
  groupOptions,
  groupVariantOptions,
  toggleHidden,
} from '../../spatial/spatial-panel-model';
import { Supersede } from '../../util/supersede';

/**
 * The cells' grouping, as Xenium Explorer's Groups section: the group picker (columns under
 * their section heading, a k-means family once, with its k beside it), CSV import of a new
 * grouping, and the grouping's categories with their colours, cell counts and show/hide
 * switches.
 *
 * Writes only through `controls.setViewState` (`cellTypeColumn`, `hiddenGroups`).
 */
@Component({
  selector: 'spatial-groups-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, SharedModule, CheckboxModule, DropdownModule],
  templateUrl: './spatial-groups-panel.component.html',
  styleUrls: ['./spatial-groups-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialGroupsPanelComponent implements OnChanges {
  /** The spatial controls this panel reads and writes through; null without a `SPATIAL_DATA_PORT`. */
  @Input() controls: ISpatialControls | null = null;
  /** The dataset on offer, or null. */
  @Input() dataset: SpatialDataset | null = null;
  /** The current spatial view state: what is drawn, and how. */
  @Input() view: SpatialViewState = DEFAULT_SPATIAL_VIEW;

  /**
   * The group picker: categorical columns under their section heading, a family of
   * variants (k-means at k = 2…10) listed once. Values are a column name, or
   * `family:<id>` for a family.
   */
  protected groupOptions: GroupOptionSection[] = [];
  /** Variants of the active family (k = 2…10), when a family is active. */
  protected groupVariantOptions: PanelOption<string>[] = [];
  /** The last variant chosen per family, so switching away and back keeps k. */
  private readonly familyChoice = new Map<string, string>();

  /** The active grouping's categories with colours and cell counts, largest first. */
  protected groupRows: GroupRow[] = [];
  protected groupTotal = 0;
  protected groupsExpanded = true;
  /** The grouping {@link groupRows} shows or is loading — a repeat request for it is a no-op. */
  private groupRowsFor: string | null = null;
  /** Latest wins among group-row loads, so a slow one for an earlier grouping (or the
   *  previous dataset's column of the same name) cannot land over the current one. */
  private readonly groupRowsLoad = new Supersede();
  protected groupImportError: string | null = null;
  protected groupImporting = false;

  constructor(
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['view']) this.hiddenGroups = new Set(this.view.hiddenGroups);
    if (changes['dataset']) {
      this.groupOptions = groupOptions(this.dataset);
      // A same-named grouping of a new dataset is not the old one.
      this.groupRowsFor = null;
    }
    void this.refreshGroups();
  }

  /** The categorical column the cells are grouped by. */
  protected get activeCellTypeColumn(): string | null {
    return this.dataset ? cellTypeColumnFor(this.dataset, this.view) : null;
  }

  /** The picker's value for the active group column. */
  protected get activeGroupEntry(): string | null {
    return groupEntryFor(this.dataset, this.activeCellTypeColumn);
  }

  protected onGroupEntry(value: string): void {
    if (value.startsWith(FAMILY_PREFIX)) {
      const id = value.slice(FAMILY_PREFIX.length);
      const name = this.familyChoice.get(id) ?? familyMembers(this.dataset, id)[0]?.name;
      if (name) this.onCellTypeColumn(name);
      return;
    }
    this.onCellTypeColumn(value);
  }

  protected onGroupVariant(name: string): void {
    const meta = this.dataset?.columns.find((c) => c.name === name);
    if (meta?.kind === 'categorical' && meta.family) this.familyChoice.set(meta.family.id, name);
    this.onCellTypeColumn(name);
  }

  onCellTypeColumn(name: string | null): void {
    // Switched-off groups belong to the grouping they were switched off in.
    this.controls?.setViewState({ cellTypeColumn: name, hiddenGroups: [] });
  }

  /** {@link SpatialViewState.hiddenGroups} as a set, for the per-row checks. */
  private hiddenGroups = new Set<string>();

  protected isGroupShown(label: string): boolean {
    return !this.hiddenGroups.has(label);
  }

  protected get allGroupsShown(): boolean {
    return this.view.hiddenGroups.length === 0;
  }

  protected onGroupShown(label: string, on: boolean): void {
    this.controls?.setViewState({ hiddenGroups: toggleHidden(this.view.hiddenGroups, [label], on) });
  }

  protected onAllGroupsShown(on: boolean): void {
    this.controls?.setViewState({ hiddenGroups: on ? [] : this.groupRows.map((r) => r.label) });
  }

  protected get canImportGroups(): boolean {
    return !!this.controls?.importGroups;
  }

  /** '+': a CSV/TSV of `cell_id` and group, named after the file. */
  protected async onImportGroupsFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.controls?.importGroups) return;
    this.groupImportError = null;
    this.groupImporting = true;
    try {
      const label = file.name.replace(/\.(csv|tsv|txt)$/i, '');
      const { column } = await this.controls.importGroups(label, await file.text());
      this.apply(() => this.onCellTypeColumn(column.name));
    } catch (err) {
      this.apply(() => {
        this.groupImportError = String((err as Error)?.message ?? err);
      });
    } finally {
      this.apply(() => {
        this.groupImporting = false;
      });
    }
  }

  protected trackByLabel = (_i: number, row: { label: string }) => row.label;

  private refreshVariants(): void {
    const next = groupVariantOptions(this.dataset, this.activeCellTypeColumn);
    if (JSON.stringify(next) !== JSON.stringify(this.groupVariantOptions)) this.groupVariantOptions = next;
  }

  private async refreshGroups(): Promise<void> {
    this.refreshVariants();
    const name = this.activeCellTypeColumn;
    if (!name || !this.controls) {
      this.groupRowsLoad.cancel();
      this.groupRows = [];
      this.groupTotal = 0;
      this.groupRowsFor = null;
      return;
    }
    if (name === this.groupRowsFor) return;
    this.groupRowsFor = name;
    const task = this.groupRowsLoad.next();
    try {
      const v = await this.controls.categoricalView(name);
      if (!task.isCurrent()) return;
      const { rows, total } = countGroupRows(v);
      this.apply(() => {
        this.groupRows = rows;
        this.groupTotal = total;
      });
    } catch {
      // Only the current load's failure re-opens the key: a superseded one clearing it
      // would make the newer load's result look stale and be dropped.
      if (task.isCurrent()) this.groupRowsFor = null;
    }
  }

  /** Apply an async result inside the zone and re-render this OnPush panel. */
  private apply(fn: () => void): void {
    this.zone.run(() => {
      fn();
      this.cdr.markForCheck();
    });
  }
}
