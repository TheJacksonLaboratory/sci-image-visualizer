import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

/** The Region Editor's help dialog (static content). */
@Component({
  selector: 'region-editor-help',
  templateUrl: './region-editor-help.component.html',
  styleUrls: ['./region-editor-help.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegionEditorHelpComponent {
  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();
}
