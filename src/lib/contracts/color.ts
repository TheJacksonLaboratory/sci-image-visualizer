/**
 * The one CSS colour parser (review NAPARI-BOUNDARY-29, CORE-25, RT-28).
 *
 * Seven call sites used to parse colours by hand, each accepting a different
 * subset (`#rgb` here, `#rrggbb` only there, `rgb()` in one place) and each
 * falling back to a different colour on bad input. They now all call
 * {@link parseCssColor}, which returns null for anything it does not
 * understand, and keep their own fallback at the call site
 * (`parseCssColor(s) ?? MISSING_COLOR`).
 *
 * Pure: no DOM, no Angular. Channels are 0–255 integers.
 */

/** An RGB colour, each channel 0–255. */
export type Rgb = [number, number, number];

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^rgba?\(\s*([^)]*)\)$/i;

/**
 * Parse a CSS colour to RGB, or null when it is not one this parser accepts.
 *
 * Accepts `#rgb`, `#rrggbb` and `#rrggbbaa` (the `#` may be omitted, and the
 * alpha is ignored), and `rgb(r, g, b)` / `rgba(r, g, b, a)` with comma- or
 * space-separated channels (rounded and clamped to 0–255). Named colours
 * (`red`) are not accepted.
 */
export function parseCssColor(s: string | null | undefined): Rgb | null {
  const text = (s ?? '').trim();
  if (!text) return null;
  const hex = HEX.exec(text);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const fn = FUNC.exec(text);
  if (fn) {
    const parts = fn[1]
      .split(/[\s,/]+/)
      .filter((p) => p.length > 0)
      .slice(0, 3)
      .map(Number);
    if (parts.length < 3 || parts.some((v) => !Number.isFinite(v))) return null;
    return [clampByte(parts[0]), clampByte(parts[1]), clampByte(parts[2])];
  }
  return null;
}

/** `#rrggbb` (lower-case) for an RGB colour; channels are rounded and clamped to 0–255. */
export function rgbToHex(rgb: Readonly<Rgb>): string {
  const h = (n: number) => clampByte(n).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

/** {@link parseCssColor} for hex input: `#rgb` / `#rrggbb` / `#rrggbbaa` (with or without `#`), or null. */
export function hexToRgb(hex: string | null | undefined): Rgb | null {
  const text = (hex ?? '').trim();
  return HEX.test(text) ? parseCssColor(text) : null;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}
