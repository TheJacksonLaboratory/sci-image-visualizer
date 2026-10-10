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
import { SharedModule } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';

import { ToolbarDialogToolContribution, ToolbarToolContribution } from '../../contracts/toolbar-tool.contract';

/**
 * The plotting toolbar's help dialog: static documentation of every tool, plus
 * the help each contributed tool brings.
 */
@Component({
  selector: 'toolbar-help-dialog',
  standalone: true,
  imports: [CommonModule, SharedModule, ButtonModule, DialogModule],
  templateUrl: './toolbar-help-dialog.component.html',
  styleUrls: ['./toolbar-help-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolbarHelpDialogComponent implements OnChanges {
  /** The dialog is open. */
  @Input() visible = false;
  /** The dialog was closed (`false`); two-way with {@link visible}. */
  @Output() visibleChange = new EventEmitter<boolean>();

  /** Contributed no-prompt tools (their help entries are listed). */
  @Input() contributedTools: ToolbarToolContribution[] = [];
  /** Contributed dialog tools (their help entries are listed). */
  @Input() dialogTools: ToolbarDialogToolContribution[] = [];

  /** Contributed tool names for the prompted/no-prompt contrast, e.g.
   *  "YOLO, Retinal layers". Empty when nothing is registered, which is why
   *  the sentence that uses it is itself conditional. */
  protected contributedToolNames = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['contributedTools']) {
      this.contributedToolNames = this.contributedTools.map((t) => t.label).join(', ');
    }
  }
}
