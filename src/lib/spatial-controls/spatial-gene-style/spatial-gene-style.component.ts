import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';

import { TranscriptGlyphName } from '../../contracts/display-types';
import { parseCssColor, rgbToHex } from '../../contracts/color';
import { DEFAULT_CATEGORICAL_PALETTE } from '../../spatial/spatial-encoding';
import { GLYPH_OPTIONS } from '../../spatial/spatial-panel-model';

/**
 * One gene's icon and colour: the icon grid, a colour picker with its hex value, presets, and
 * a reset — the content of a popover its host opens on the gene's swatch. Writes nothing itself:
 * it reports the choice, and the host stores it where it belongs.
 */
@Component({
  selector: 'spatial-gene-style',
  standalone: true,
  imports: [CommonModule, ButtonModule, InputTextModule],
  templateUrl: './spatial-gene-style.component.html',
  styleUrls: ['./spatial-gene-style.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialGeneStyleComponent {
  /** The gene, for the controls' labels. */
  @Input() gene = '';
  /** What the icons and colour are of ("Observation", "Transcript"), for the titles. */
  @Input() what = '';
  /** The gene's colour, `#rrggbb`. */
  @Input() color = '#ffffff';
  /** The gene's icon. */
  @Input() glyph: TranscriptGlyphName = 'circle';
  /** A note under the icons, e.g. where they show; none when null. */
  @Input() iconHint: string | null = null;
  @Output() readonly colorChange = new EventEmitter<string>();
  @Output() readonly glyphChange = new EventEmitter<TranscriptGlyphName>();
  /** Back to the gene's default icon and colour. */
  @Output() readonly resetStyle = new EventEmitter<void>();

  protected readonly glyphOptions = GLYPH_OPTIONS;
  protected readonly colorPresets = DEFAULT_CATEGORICAL_PALETTE.slice(0, 10).map((c) => c.toLowerCase());

  /** A typed hex colour, accepted as `#rrggbb` or `rrggbb`; anything else is ignored. */
  protected onHex(text: string): void {
    const t = text.trim();
    const rgb = /^#?[0-9a-f]{6}$/i.test(t) ? parseCssColor(t) : null;
    if (rgb) this.colorChange.emit(rgbToHex(rgb));
  }
}
