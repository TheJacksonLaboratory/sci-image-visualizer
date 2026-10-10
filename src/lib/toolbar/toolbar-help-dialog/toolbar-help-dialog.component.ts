import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import { ToolbarDialogToolContribution, ToolbarToolContribution } from '../../contracts/toolbar-tool.contract';

/**
 * The plotting toolbar's help dialog: static documentation of every tool, plus
 * the help each contributed tool brings.
 */
@Component({
  selector: 'toolbar-help-dialog',
  templateUrl: './toolbar-help-dialog.component.html',
  styleUrls: ['./toolbar-help-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolbarHelpDialogComponent {
  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();

  /** Contributed no-prompt tools (their help entries are listed). */
  @Input() contributedTools: ToolbarToolContribution[] = [];
  /** Contributed dialog tools (their help entries are listed). */
  @Input() dialogTools: ToolbarDialogToolContribution[] = [];

  /** Contributed tool names for the prompted/no-prompt contrast, e.g.
   *  "YOLO, Retinal layers". Empty when nothing is registered, which is why
   *  the sentence that uses it is itself conditional. */
  get contributedToolNames(): string {
    return this.contributedTools.map((t) => t.label).join(', ');
  }
}
