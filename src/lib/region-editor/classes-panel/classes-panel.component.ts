import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import { ClassPreset, MatchMode } from '../../models/class-preset';
import { presetKey } from '../../store/class-color.util';

/**
 * The Region Editor's docked "Classes" panel (jit-ui#70): every annotation
 * class with its colour swatch and region count. A row click picks the active
 * class (and re-classifies a selection), the swatch recolours the class, the
 * trash removes it, Manage opens the full editor. Presentational: the editor
 * applies every action.
 */
@Component({
  selector: 'region-classes-panel',
  templateUrl: './classes-panel.component.html',
  styleUrls: ['./classes-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassesPanelComponent {
  /** The classes in display order. */
  @Input() classes: ClassPreset[] = [];
  /** Region count per class, keyed by {@link presetKey} under `matchMode`. */
  @Input() counts = new Map<string, number>();
  @Input() matchMode: MatchMode = 'exact';
  @Input() activeClass: string | null = null;
  /** Number of selected regions (changes what a row click does). */
  @Input() selectedCount = 0;
  /** The class regions revert to; it can't be removed while in use. */
  @Input() defaultClassName = 'Region';

  /** A row was clicked: make the class active / apply it to the selection. */
  @Output() pick = new EventEmitter<string>();
  @Output() recolor = new EventEmitter<{ name: string; color: string }>();
  @Output() remove = new EventEmitter<string>();
  /** Manage clicked. */
  @Output() manage = new EventEmitter<void>();

  /** trackBy for the class rows so re-sorting doesn't re-create the pickers. */
  readonly trackByName = (_: number, c: ClassPreset): string => c.name;

  count(name: string): number {
    return this.counts.get(presetKey({ matchMode: this.matchMode }, name)) ?? 0;
  }

  canRemove(name: string): boolean {
    return !(name === this.defaultClassName && this.count(name) > 0);
  }

  rowTooltip(name: string): string {
    return this.selectedCount
      ? `Apply “${name}” to the selected region(s)`
      : `Set “${name}” active — new regions use it`;
  }

  removeTooltip(name: string): string {
    const inUse = this.count(name) > 0;
    if (name === this.defaultClassName && inUse) return 'The default class cannot be removed while in use';
    return inUse ? `Remove class — its regions revert to ${this.defaultClassName}` : 'Remove class';
  }
}
