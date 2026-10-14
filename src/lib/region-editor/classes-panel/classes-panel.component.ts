import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';

import { ClassPreset, MatchMode } from '../../models/class-preset';
import { presetKey } from '../../store/class-color.util';
import { HexColorPickerComponent } from '../../hex-color-picker/hex-color-picker.component';

/** One class row as the template draws it, derived once per input change. */
interface ClassRow {
  name: string;
  color: string;
  count: number;
  canRemove: boolean;
  rowTooltip: string;
  removeTooltip: string;
}

/**
 * The Region Editor's docked "Classes" panel (jit-ui#70): every annotation
 * class with its colour swatch and region count. A row click picks the active
 * class (and re-classifies a selection), the swatch recolours the class, the
 * trash removes it, Manage opens the full editor; the search box filters the
 * rows by name. For a class hierarchy the editor projects a class tree in,
 * shown in place of the list while {@link treeView} is on. Presentational: the
 * editor applies every action.
 */
@Component({
  selector: 'region-classes-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TooltipModule, HexColorPickerComponent],
  templateUrl: './classes-panel.component.html',
  styleUrls: ['./classes-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassesPanelComponent implements OnChanges {
  /** The classes in display order. */
  @Input() classes: ClassPreset[] = [];
  /** Region count per class, keyed by {@link presetKey} under `matchMode`. */
  @Input() counts = new Map<string, number>();
  /** How labels are matched to classes (keys {@link counts}). */
  @Input() matchMode: MatchMode = 'exact';
  /** The active class (highlighted), or null. */
  @Input() activeClass: string | null = null;
  /** Number of selected regions (changes what a row click does). */
  @Input() selectedCount = 0;
  /** The class regions revert to; it can't be removed while in use. */
  @Input() defaultClassName = 'Region';
  /** Whether a volume view is on screen: each class can then be shown in 3D. */
  @Input() volume = false;
  /** The classes shown in 3D. */
  @Input() shown3d: ReadonlySet<string> = new Set();
  /** A class's 3D toggle (its name). */
  @Output() toggle3d = new EventEmitter<string>();
  /** Whether the projected class tree is shown instead of the list; null: there is no tree. */
  @Input() treeView: boolean | null = null;
  /** The list / tree switch. */
  @Output() treeViewChange = new EventEmitter<boolean>();

  /** A row was clicked: make the class active / apply it to the selection. */
  @Output() pick = new EventEmitter<string>();
  /** A class's swatch picked a new colour. */
  @Output() recolor = new EventEmitter<{ name: string; color: string }>();
  /** A class's trash button (its name). */
  @Output() remove = new EventEmitter<string>();
  /** Manage clicked. */
  @Output() manage = new EventEmitter<void>();

  /** trackBy for the class rows so re-sorting doesn't re-create the pickers. */
  protected readonly trackByName = (_: number, c: ClassRow): string => c.name;

  /** Every class's row, rebuilt when an input changes rather than per check. */
  protected rows: ClassRow[] = [];
  /** The rows matching {@link query}. */
  protected shownRows: ClassRow[] = [];
  /** The search box's text. */
  protected query = '';

  ngOnChanges(): void {
    this.rows = this.classes.map((c) => ({
      name: c.name,
      color: c.color,
      count: this.count(c.name),
      canRemove: this.canRemove(c.name),
      rowTooltip: this.rowTooltip(c.name),
      removeTooltip: this.removeTooltip(c.name),
    }));
    this.filter();
  }

  protected onQuery(value: string): void {
    this.query = value;
    this.filter();
  }

  /** Enter in the search box picks the first match. */
  protected pickFirstMatch(): void {
    if (this.query.trim() && this.shownRows.length) this.pick.emit(this.shownRows[0].name);
  }

  private filter(): void {
    const q = this.query.trim().toLowerCase();
    this.shownRows = q ? this.rows.filter((r) => r.name.toLowerCase().includes(q)) : this.rows;
  }

  private count(name: string): number {
    return this.counts.get(presetKey({ matchMode: this.matchMode }, name)) ?? 0;
  }

  private canRemove(name: string): boolean {
    return !(name === this.defaultClassName && this.count(name) > 0);
  }

  protected rowTooltip(name: string): string {
    return this.selectedCount
      ? `Apply “${name}” to the selected region(s)`
      : `Set “${name}” active — new regions use it`;
  }

  protected removeTooltip(name: string): string {
    const inUse = this.count(name) > 0;
    if (name === this.defaultClassName && inUse) return 'The default class cannot be removed while in use';
    return inUse ? `Remove class — its regions revert to ${this.defaultClassName}` : 'Remove class';
  }
}
