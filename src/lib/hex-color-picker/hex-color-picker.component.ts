import {
  Component, EventEmitter, Input, Output, ElementRef,
  HostListener, ViewChild, OnDestroy, Renderer2,
  ChangeDetectorRef
} from '@angular/core';

@Component({
  // Canonical prefixed selector first; the unprefixed original is kept as an
  // alias for one release (pre-publication back-compat).
  selector: 'jaxviz-hex-color-picker, hex-color-picker',
  templateUrl: './hex-color-picker.component.html',
  styleUrls: ['./hex-color-picker.component.scss'],
})
export class HexColorPickerComponent implements OnDestroy {

  private static readonly DROPDOWN_WIDTH = 280;

  private _color = '#000000';

  @Output() colorChange = new EventEmitter<string>();

  open = false;

  @ViewChild('swatchBtn') swatchBtn!: ElementRef<HTMLButtonElement>;
  @ViewChild('dropdown') dropdownRef!: ElementRef<HTMLDivElement>;

  // HSL values
  hue = 0;
  saturation = 100;
  lightness = 50;

  // RGB values
  red = 0;
  green = 0;
  blue = 0;

  // Honeycomb color palette
  // Honeycomb color palette from w3schools — 7 per side, 13 rows (7→13→7)
  readonly colorRows: string[][] = [
    // Row 1: 7
    ['#003366', '#336699', '#3366CC', '#003399', '#000099', '#0000CC', '#000066'],
    // Row 2: 8
    ['#006666', '#006699', '#0099CC', '#0066CC', '#0033CC', '#0000FF', '#3333FF', '#333399'],
    // Row 3: 9
    ['#669999', '#009999', '#33CCCC', '#00CCFF', '#0099FF', '#0066FF', '#3366FF', '#3333CC', '#666699'],
    // Row 4: 10
    ['#339966', '#00CC99', '#00FFCC', '#00FFFF', '#33CCFF', '#3399FF', '#6699FF', '#6666FF', '#6600FF', '#6600CC'],
    // Row 5: 11
    ['#339933', '#00CC66', '#00FF99', '#66FFCC', '#66FFFF', '#66CCFF', '#99CCFF', '#9999FF', '#9966FF', '#9933FF', '#9900FF'],
    // Row 6: 12
    ['#006600', '#00CC00', '#00FF00', '#66FF99', '#99FFCC', '#CCFFFF', '#CCCCFF', '#CC99FF', '#CC66FF', '#CC33FF', '#CC00FF', '#9900CC'],
    // Row 7: 13 (center)
    ['#003300', '#009933', '#33CC33', '#66FF66', '#99FF99', '#CCFFCC', '#FFFFFF', '#FFCCFF', '#FF99FF', '#FF66FF', '#FF00FF', '#CC00CC', '#660066'],
    // Row 8: 12
    ['#336600', '#009900', '#66FF33', '#99FF66', '#CCFF99', '#FFFFCC', '#FFCCCC', '#FF99CC', '#FF66CC', '#FF33CC', '#CC0099', '#993399'],
    // Row 9: 11
    ['#333300', '#669900', '#99FF33', '#CCFF66', '#FFFF99', '#FFCC99', '#FF9999', '#FF6699', '#FF3399', '#CC3399', '#990099'],
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

  @Input()
  get color(): string {
    return this._color;
  }
  set color(val: string) {
    const normalizedColor = this.normalizeHexColor(val);
    this._color = normalizedColor;
    this.syncFromHex(normalizedColor);
  }

  constructor(private elRef: ElementRef, private renderer: Renderer2, private cdr: ChangeDetectorRef) {}

  ngOnDestroy() {
    this.removeDropdownFromBody();
  }

  toggle() {
    this.open = !this.open;
    if (this.open) {
      // Let Angular render the dropdown, then move it to body
      this.cdr.detectChanges();
      this.appendDropdownToBody();
    } else {
      this.removeDropdownFromBody();
    }
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

  selectColor(hex: string) {
    this._color = hex;
    this.syncFromHex(hex);
    this.colorChange.emit(hex);
  }

  selectAndClose(hex: string) {
    this.selectColor(hex);
    this.close();
  }

  close() {
    this.open = false;
    this.removeDropdownFromBody();
  }

  onHexInput(value: string) {
    if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
      this.selectColor(value);
    }
  }

  onHslChange() {
    const hex = this.hslToHex(this.hue, this.saturation, this.lightness);
    this._color = hex;
    this.syncRgbFromHex(hex);
    this.colorChange.emit(hex);
  }

  onRgbChange() {
    const red = Math.max(0, Math.min(255, this.red));
    const green = Math.max(0, Math.min(255, this.green));
    const blue = Math.max(0, Math.min(255, this.blue));

    this.red = red;
    this.green = green;
    this.blue = blue;

    const hex = this.rgbToHex(red, green, blue);
    this._color = hex;
    this.syncHslFromRgb(red, green, blue);
    this.colorChange.emit(hex);
  }

  get hueGradient(): string {
    const stops = [];
    for (let h = 0; h <= 360; h += 30) {
      stops.push(`hsl(${h}, 100%, 50%)`);
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }

  get satGradient(): string {
    return `linear-gradient(to right, hsl(${this.hue}, 0%, ${this.lightness}%), hsl(${this.hue}, 100%, ${this.lightness}%))`;
  }

  get lightGradient(): string {
    return `linear-gradient(to right, hsl(${this.hue}, ${this.saturation}%, 0%), hsl(${this.hue}, ${this.saturation}%, 50%), hsl(${this.hue}, ${this.saturation}%, 100%))`;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event) {
    if (!this.open) return;
    const target = event.target as Node;
    const clickedInside =
      this.elRef.nativeElement.contains(target) || this.dropdownRef?.nativeElement.contains(target);
    if (!clickedInside) {
      this.close();
    }
  }

  // --- Color conversion utilities ---

  private syncFromHex(hex: string) {
    const rgb = this.hexToRgb(hex);
    if (rgb) {
      this.red = rgb.r;
      this.green = rgb.g;
      this.blue = rgb.b;
      this.syncHslFromRgb(rgb.r, rgb.g, rgb.b);
    }
  }

  private syncRgbFromHex(hex: string) {
    const rgb = this.hexToRgb(hex);
    if (rgb) {
      this.red = rgb.r;
      this.green = rgb.g;
      this.blue = rgb.b;
    }
  }

  private syncHslFromRgb(r: number, g: number, b: number) {
    const hsl = this.rgbToHsl(r, g, b);
    this.hue = hsl.h;
    this.saturation = hsl.s;
    this.lightness = hsl.l;
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return match
      ? {
          r: parseInt(match[1], 16),
          g: parseInt(match[2], 16),
          b: parseInt(match[3], 16),
        }
      : null;
  }

  private rgbToHex(r: number, g: number, b: number): string {
    const toHex = (n: number) =>
      Math.max(0, Math.min(255, Math.round(n)))
        .toString(16)
        .padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
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

  private hslToHex(h: number, s: number, l: number): string {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * color);
    };
    return this.rgbToHex(f(0), f(8), f(4));
  }
}
