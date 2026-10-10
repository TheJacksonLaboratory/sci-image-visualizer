import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnDestroy,
  Output,
  Renderer2,
  ViewChild,
  computed,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { hslToHex } from '../store/class-color.util';
import { hexToRgb, rgbToHex } from '../contracts/color';

/** The hue slider's track: the full hue wheel, the same for every picker. */
const HUE_GRADIENT = `linear-gradient(to right, ${Array.from(
  { length: 13 },
  (_, i) => `hsl(${i * 30}, 100%, 50%)`,
).join(', ')})`;

/**
 * A compact colour picker: a swatch button that opens a honeycomb palette with a
 * hex field, the system colour picker, HSL sliders and RGB fields. Bind `[color]`
 * and listen to `(colorChange)` (committed picks) and, for a live preview,
 * `(colorInput)` (every intermediate colour while dragging).
 */
@Component({
  selector: 'hex-color-picker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './hex-color-picker.component.html',
  styleUrls: ['./hex-color-picker.component.scss'],
  // OnPush so the always-in-DOM (but hidden) picker panel — a ~130-cell honeycomb
  // grid + sliders — isn't re-checked on every scroll-triggered change detection.
  // Inputs (`color`) and the picker's own events still mark it for check. (jit-ui#70)
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HexColorPickerComponent implements OnDestroy {
  private static readonly DROPDOWN_WIDTH = 280;

  /** The colour shown (the swatch, the hex field, the selected cell). */
  private readonly current = signal('#000000');

  /** The committed colour: a swatch/hex pick, or a slider/field/system-picker
   *  edit once it is released. Hosts commit their state on this. */
  @Output() colorChange = new EventEmitter<string>();
  /** Every intermediate colour while a slider, number field or the system picker
   *  is being dragged — for a live preview; {@link colorChange} follows on release. */
  @Output() colorInput = new EventEmitter<string>();

  /** The last colour emitted on (or received through) `color`, so a release
   *  without a change doesn't commit again. */
  private committed = '#000000';
  /** Removes the document click listener; set only while the dropdown is open. */
  private unlistenDocumentClick: (() => void) | null = null;

  /** The palette dropdown is open. */
  protected readonly open = signal(false);

  @ViewChild('swatchBtn') private swatchBtn!: ElementRef<HTMLButtonElement>;
  @ViewChild('dropdown') private dropdownRef!: ElementRef<HTMLDivElement>;

  // HSL values
  protected readonly hue = signal(0);
  protected readonly saturation = signal(100);
  protected readonly lightness = signal(50);

  // RGB values
  protected readonly red = signal(0);
  protected readonly green = signal(0);
  protected readonly blue = signal(0);

  /** Slider tracks: hue is fixed; saturation and lightness follow the other two. */
  protected readonly hueGradient = HUE_GRADIENT;
  protected readonly satGradient = computed(() => {
    const h = this.hue(),
      l = this.lightness();
    return `linear-gradient(to right, hsl(${h}, 0%, ${l}%), hsl(${h}, 100%, ${l}%))`;
  });
  protected readonly lightGradient = computed(() => {
    const h = this.hue(),
      s = this.saturation();
    return `linear-gradient(to right, hsl(${h}, ${s}%, 0%), hsl(${h}, ${s}%, 50%), hsl(${h}, ${s}%, 100%))`;
  });

  // Honeycomb color palette
  // Honeycomb color palette from w3schools — 7 per side, 13 rows (7→13→7)
  protected readonly colorRows: string[][] = [
    // Row 1: 7
    ['#003366', '#336699', '#3366CC', '#003399', '#000099', '#0000CC', '#000066'],
    // Row 2: 8
    ['#006666', '#006699', '#0099CC', '#0066CC', '#0033CC', '#0000FF', '#3333FF', '#333399'],
    // Row 3: 9
    ['#669999', '#009999', '#33CCCC', '#00CCFF', '#0099FF', '#0066FF', '#3366FF', '#3333CC', '#666699'],
    // Row 4: 10
    ['#339966', '#00CC99', '#00FFCC', '#00FFFF', '#33CCFF', '#3399FF', '#6699FF', '#6666FF', '#6600FF', '#6600CC'],
    // Row 5: 11
    [
      '#339933',
      '#00CC66',
      '#00FF99',
      '#66FFCC',
      '#66FFFF',
      '#66CCFF',
      '#99CCFF',
      '#9999FF',
      '#9966FF',
      '#9933FF',
      '#9900FF',
    ],
    // Row 6: 12
    [
      '#006600',
      '#00CC00',
      '#00FF00',
      '#66FF99',
      '#99FFCC',
      '#CCFFFF',
      '#CCCCFF',
      '#CC99FF',
      '#CC66FF',
      '#CC33FF',
      '#CC00FF',
      '#9900CC',
    ],
    // Row 7: 13 (center)
    [
      '#003300',
      '#009933',
      '#33CC33',
      '#66FF66',
      '#99FF99',
      '#CCFFCC',
      '#FFFFFF',
      '#FFCCFF',
      '#FF99FF',
      '#FF66FF',
      '#FF00FF',
      '#CC00CC',
      '#660066',
    ],
    // Row 8: 12
    [
      '#336600',
      '#009900',
      '#66FF33',
      '#99FF66',
      '#CCFF99',
      '#FFFFCC',
      '#FFCCCC',
      '#FF99CC',
      '#FF66CC',
      '#FF33CC',
      '#CC0099',
      '#993399',
    ],
    // Row 9: 11
    [
      '#333300',
      '#669900',
      '#99FF33',
      '#CCFF66',
      '#FFFF99',
      '#FFCC99',
      '#FF9999',
      '#FF6699',
      '#FF3399',
      '#CC3399',
      '#990099',
    ],
    // Row 10: 10
    ['#666633', '#99CC00', '#CCFF33', '#FFFF66', '#FFCC66', '#FF9966', '#FF6666', '#FF0066', '#CC6699', '#993366'],
    // Row 11: 9
    ['#999966', '#CCCC00', '#FFFF00', '#FFCC00', '#FF9933', '#FF6600', '#FF5050', '#CC0066', '#660033'],
    // Row 12: 8
    ['#996633', '#CC9900', '#FF9900', '#CC6600', '#FF3300', '#FF0000', '#CC0000', '#990033'],
    // Row 13: 7
    ['#663300', '#996600', '#CC3300', '#993300', '#990000', '#800000', '#993333'],
  ];

  private normalizeHexColor(val: string): string {
    return val ? val.toUpperCase() : val;
  }

  /** The colour (`#RRGGBB`) to show; upper-cased on the way in. */
  @Input()
  get color(): string {
    return this.current();
  }
  set color(val: string) {
    const normalizedColor = this.normalizeHexColor(val);
    this.current.set(normalizedColor);
    this.committed = normalizedColor;
    this.syncFromHex(normalizedColor);
  }

  constructor(
    private elRef: ElementRef,
    private renderer: Renderer2,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
  ) {}

  ngOnDestroy() {
    this.stopListeningForOutsideClicks();
    this.removeDropdownFromBody();
  }

  protected toggle() {
    this.open.update((o) => !o);
    if (this.open()) {
      // Let Angular render the dropdown, then move it to body
      this.cdr.detectChanges();
      this.appendDropdownToBody();
      this.listenForOutsideClicks();
    } else {
      this.close();
    }
  }

  /**
   * Close on a click outside the swatch and dropdown. Registered only while
   * open and outside the Angular zone, so the many pickers on a page (one per
   * class row and channel) don't each run app-wide change detection on every
   * click anywhere (RT-22).
   */
  private listenForOutsideClicks() {
    if (this.unlistenDocumentClick) return;
    this.ngZone.runOutsideAngular(() => {
      this.unlistenDocumentClick = this.renderer.listen('document', 'click', (event: Event) => {
        if (this.isOutside(event)) this.ngZone.run(() => this.onDocumentClick(event));
      });
    });
  }

  private stopListeningForOutsideClicks() {
    this.unlistenDocumentClick?.();
    this.unlistenDocumentClick = null;
  }

  private appendDropdownToBody() {
    const dropdown = this.dropdownRef?.nativeElement;
    if (!dropdown) return;
    const rect = this.swatchBtn.nativeElement.getBoundingClientRect();
    this.renderer.appendChild(document.body, dropdown);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = HexColorPickerComponent.DROPDOWN_WIDTH;
    // Horizontal: open toward the side with room. When the swatch is on the left
    // half of the viewport, anchor the panel's LEFT edge to it (extend right) so
    // it isn't truncated by the left edge; otherwise anchor its RIGHT edge
    // (extend left). Clamp within the viewport either way.
    let left = rect.left <= vw / 2 ? rect.left : rect.right - w;
    left = Math.max(4, Math.min(left, vw - w - 4));
    // Vertical: below the swatch, flipping above if it would overflow the bottom.
    const h = dropdown.offsetHeight || 0;
    let top = rect.bottom + 4;
    if (h && top + h > vh - 4) top = Math.max(4, rect.top - 4 - h);
    this.renderer.setStyle(dropdown, 'left', left + 'px');
    this.renderer.setStyle(dropdown, 'top', top + 'px');
  }

  private removeDropdownFromBody() {
    const dropdown = this.dropdownRef?.nativeElement;
    if (dropdown && dropdown.parentElement === document.body) {
      this.renderer.removeChild(document.body, dropdown);
    }
  }

  protected selectColor(hex: string) {
    this.current.set(hex);
    this.syncFromHex(hex);
    this.commitColor();
  }

  /** Live preview from the system colour picker while it is open. */
  protected previewColor(hex: string) {
    this.current.set(hex);
    this.syncFromHex(hex);
    this.colorInput.emit(hex);
  }

  /** Commit the current colour (`colorChange`) unless it was already committed. */
  protected commitColor() {
    const color = this.current();
    if (color === this.committed) return;
    this.committed = color;
    this.colorChange.emit(color);
  }

  protected selectAndClose(hex: string) {
    this.selectColor(hex);
    this.close();
  }

  /** Close the palette dropdown (no-op when closed). */
  close() {
    this.open.set(false);
    this.stopListeningForOutsideClicks();
    this.removeDropdownFromBody();
  }

  protected onHexInput(value: string) {
    if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
      this.selectColor(value);
    }
  }

  protected onHslChange() {
    const hex = hslToHex(this.hue(), this.saturation(), this.lightness());
    this.current.set(hex);
    this.syncRgbFromHex(hex);
    this.colorInput.emit(hex);
  }

  protected onRgbChange() {
    const red = Math.max(0, Math.min(255, this.red()));
    const green = Math.max(0, Math.min(255, this.green()));
    const blue = Math.max(0, Math.min(255, this.blue()));

    this.red.set(red);
    this.green.set(green);
    this.blue.set(blue);

    const hex = rgbToHex([red, green, blue]).toUpperCase();
    this.current.set(hex);
    this.syncHslFromRgb(red, green, blue);
    this.colorInput.emit(hex);
  }

  /** Close the dropdown when `event` is a click outside the picker. */
  protected onDocumentClick(event: Event) {
    if (!this.open()) return;
    if (this.isOutside(event)) this.close();
  }

  private isOutside(event: Event): boolean {
    const target = event.target as Node;
    return !this.elRef.nativeElement.contains(target) && !this.dropdownRef?.nativeElement.contains(target);
  }

  // --- Color conversion utilities ---

  private syncFromHex(hex: string) {
    const rgb = hexToRgb(hex);
    if (rgb) {
      this.setRgb(rgb);
      this.syncHslFromRgb(rgb[0], rgb[1], rgb[2]);
    }
  }

  private syncRgbFromHex(hex: string) {
    const rgb = hexToRgb(hex);
    if (rgb) this.setRgb(rgb);
  }

  private setRgb([r, g, b]: readonly number[]) {
    this.red.set(r);
    this.green.set(g);
    this.blue.set(b);
  }

  private syncHslFromRgb(r: number, g: number, b: number) {
    const hsl = this.rgbToHsl(r, g, b);
    this.hue.set(hsl.h);
    this.saturation.set(hsl.s);
    this.lightness.set(hsl.l);
  }

  private rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0,
      s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
          break;
        case g:
          h = ((b - r) / d + 2) / 6;
          break;
        case b:
          h = ((r - g) / d + 4) / 6;
          break;
      }
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }
}
