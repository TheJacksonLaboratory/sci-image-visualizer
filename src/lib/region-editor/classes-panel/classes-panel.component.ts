import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
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
 * trash removes it, Manage opens the full editor. Presentational: the editor
 * applies every action.
 */
@Component({
  selector: 'region-classes-panel',
  standalone: true,
  imports: [CommonModule, ButtonModule, TooltipModule, HexColorPickerComponent],
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

  /** The rows drawn, rebuilt when an input changes rather than per check. */
  protected rows: ClassRow[] = [];

  ngOnChanges(): void {
    this.rows = this.classes.map((c) => ({
      name: c.name,
      color: c.color,
      count: this.count(c.name),
      canRemove: this.canRemove(c.name),
      rowTooltip: this.rowTooltip(c.name),
      removeTooltip: this.removeTooltip(c.name),
    }));
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
