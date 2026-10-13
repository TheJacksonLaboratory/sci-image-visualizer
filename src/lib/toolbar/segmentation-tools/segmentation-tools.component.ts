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
import { MenuItem, SharedModule } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { MenuModule } from 'primeng/menu';
import { TooltipModule } from 'primeng/tooltip';

import { ToolbarToolContribution } from '../../contracts/toolbar-tool.contract';
import { MODEL_INFO } from '../model-info';

/**
 * The toolbar's segmentation group: SAM box prompt, SAM point prompts and the
 * shared SAM model picker, cellpose, and the contributed no-prompt tools (run,
 * pick checkpoint, parameters). Presentational: the host runs every action.
 */
@Component({
  selector: 'toolbar-segmentation-tools',
  standalone: true,
  imports: [CommonModule, SharedModule, ButtonModule, MenuModule, TooltipModule],
  templateUrl: './segmentation-tools.component.html',
  styleUrls: ['./segmentation-tools.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SegmentationToolsComponent implements OnChanges {
  /** The armed tool's mode (`samPoint` highlights the point-prompt button), or null. */
  @Input() activeDragMode: string | null = null;
  /** SAM model picker options + current selection (jit-ui#90 P1). */
  @Input() samModels: { id: string; label: string }[] = [];
  /** The selected SAM model id. */
  @Input() samModelId = '';
  /** Contributed no-prompt tools, already filtered and sorted by the host. */
  @Input() contributedTools: ToolbarToolContribution[] = [];
  /** Active checkpoint per contributed tool, keyed by tool id. */
  @Input() toolModelIds: Record<string, string> = {};

  /** Run box-prompted SAM segmentation on the drawn rectangles (jit-ui#90). */
  @Output() segmentRegions = new EventEmitter<void>();
  /** Run cellpose-SAM (auto) inside each drawn rectangle's crop (jit-ui#90). */
  @Output() segmentCellpose = new EventEmitter<void>();
  /** The SAM point tool's toggle ('samPoint'). */
  @Output() toggleDragMode = new EventEmitter<string>();
  /** A SAM model was picked from the model menu (its id). */
  @Output() samModelChange = new EventEmitter<string>();
  /** Run a contributed tool over the current view (its id). */
  @Output() runTool = new EventEmitter<string>();
  /** A contributed tool's checkpoint was picked. */
  @Output() toolModelChange = new EventEmitter<{ toolId: string; modelId: string }>();
  /** Open a contributed tool's parameter dialog (its id). */
  @Output() openToolParams = new EventEmitter<string>();

  /** Model picker for the Segment button's dropdown menu. The active model
   *  (`samModelId`) is marked with a check; selecting an item emits
   *  `samModelChange` (jit-ui#90 P1).
   *
   *  Held as a stable array (rebuilt only when `samModels`/`samModelId` change),
   *  NOT a getter: a getter returns a fresh array with new `command` closures on
   *  every change-detection tick, which makes the bound `p-menu` overlay rebuild
   *  its DOM mid-interaction and swallow the click on a menu item.
   *
   *  `tooltip` carries the model's description from {@link MODEL_INFO}; the
   *  menus' shared item template turns it into the hover info icon. p-menu's own
   *  rendering ignores the field (it reads `item.title`), so it is free to use. */
  protected samMenuItems: MenuItem[] = [];
  /**
   * Model menus for the contributed tools, keyed by tool id. Same stable-array
   * reasoning as {@link samMenuItems} — and it is why this is a map rebuilt in
   * `ngOnChanges` rather than a method called from the template, which would
   * hand `p-menu` a new array every tick.
   *
   * A contributed tool supplies its own per-model description, so unlike the
   * SAM menu these do not consult {@link MODEL_INFO}: this library has no
   * copy for checkpoints it does not know about.
   */
  protected toolMenuItems: Record<string, MenuItem[]> = {};

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['samModels'] || changes['samModelId']) {
      this.samMenuItems = this.samModels.map((m) => ({
        label: m.label,
        icon: m.id === this.samModelId ? 'pi pi-check' : 'pi pi-fw',
        tooltip: MODEL_INFO[m.id],
        infoLabel: this.infoLabel(m.label, MODEL_INFO[m.id]),
        command: () => this.samModelChange.emit(m.id),
      }));
    }
    if (changes['contributedTools'] || changes['toolModelIds']) {
      this.toolMenuItems = {};
      for (const tool of this.contributedTools) {
        const active = this.toolModelIds[tool.id] ?? tool.defaultModelId();
        this.toolMenuItems[tool.id] = tool.models().map((m) => ({
          label: m.label,
          icon: m.id === active ? 'pi pi-check' : 'pi pi-fw',
          tooltip: m.info,
          infoLabel: this.infoLabel(m.label, m.info),
          command: () => this.toolModelChange.emit({ toolId: tool.id, modelId: m.id }),
        }));
      }
    }
  }

  /**
   * Strip markup from a model description so it can be read aloud.
   *
   * The copy in MODEL_INFO and in a contribution's `ToolModelOption.info` is
   * written for a visual tooltip rendered with `[escape]="false"`, so it carries
   * `<b>` and `<br>`. Passed to `aria-label` verbatim a screen reader announces
   * the tags, so they are removed and `<br>` becomes a sentence break. Entities
   * used in that copy (`&nbsp;`, `&times;`, `&amp;`) are decoded for the same
   * reason.
   */
  protected plainText(html: string): string {
    return (html ?? '')
      .replace(/<br\s*\/?>/gi, '. ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&times;/g, 'x')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** The info button's `aria-label` (`infoLabel` on a menu item), built once with the
   *  menu rather than by a template call on every check; none without a description. */
  private infoLabel(label: string, info: string | undefined): string | undefined {
    return info ? `About ${label}: ${this.plainText(info)}` : undefined;
  }

  /** Keeps each contributed tool's `p-menu` overlay alive across CD ticks —
   *  re-creating it mid-interaction swallows the click on a menu item. */
  protected trackToolById(_index: number, tool: { id: string }): string {
    return tool.id;
  }
}
