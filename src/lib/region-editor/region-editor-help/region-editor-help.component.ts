import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { SharedModule } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';

/** The Region Editor's help dialog (static content). */
@Component({
  selector: 'region-editor-help',
  standalone: true,
  imports: [SharedModule, ButtonModule, DialogModule],
  templateUrl: './region-editor-help.component.html',
  styleUrls: ['./region-editor-help.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegionEditorHelpComponent {
  /** The dialog is open. */
  @Input() visible = false;
  /** The dialog was closed (`false`); two-way with {@link visible}. */
  @Output() visibleChange = new EventEmitter<boolean>();
}
