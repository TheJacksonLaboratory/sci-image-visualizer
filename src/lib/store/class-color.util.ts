/**
 * Deterministic colour engine for preset annotation classes (jit-ui#70).
 *
 * Resolution order for a region `label`:
 *   1. a matching preset (exact by default, or normalized if the set's matchMode says so)
 *      -> the preset's colour;
 *   2. otherwise a deterministic fallback colour derived from a stable hash of the name,
 *      so the same unknown class always gets the same colour with no stored state.
 *
 * These functions are pure (no mutation); opt-in promotion of unknown classes into the
 * set is reported to the caller (see {@link applyPresetColors}), which owns persistence.
 */
import { ClassPreset, PresetSet } from '../models/class-preset';
import { Region } from '../models/region';
import { withRegionPatch } from '../models/region-clone';

export function normalizeLabel(s: string): string {
  return (s ?? '').trim().toLowerCase();
}

/** Stable, non-negative 32-bit string hash (identical across runs and machines). */
export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  // Fold to non-negative without the Math.abs(INT_MIN) overflow pitfall.
  return h < 0 ? ~h : h;
}

/**
 * The key two class names are compared by under the set's match mode: the name
 * itself for `exact`, trimmed and lower-cased for `normalized`.
 */
export function presetKey(set: Pick<PresetSet, 'matchMode'>, label: string): string {
  return set?.matchMode === 'normalized' ? normalizeLabel(label) : label;
}

/** `#RRGGBB` (upper-case) for an HSL colour: hue in degrees, saturation and lightness in %. */
export function hslToHex(hDeg: number, sPct: number, lPct: number): string {
  const s = sPct / 100;
  const l = lPct / 100;
  const k = (n: number) => (n + hDeg / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const v = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
}

/** Find the preset matching `label` under the set's match mode. */
export function findPreset(label: string, set: PresetSet): ClassPreset | undefined {
  if (!label || !set?.classes) return undefined;
  if (set.matchMode === 'normalized') {
    const n = normalizeLabel(label);
    return set.classes.find((c) => normalizeLabel(c.name) === n);
  }
  return set.classes.find((c) => c.name === label);
}

/**
 * Deterministic fallback colour for an unknown class name: index into the palette by a
 * stable hash of the (normalized) name; if the palette is empty, generate a golden-angle
 * HSL hue. Same name -> same colour, every run.
 */
export function fallbackColorFor(label: string, palette: string[]): string {
  const key = normalizeLabel(label);
  if (palette && palette.length > 0) {
    return palette[hashString(key) % palette.length];
  }
  const hue = (hashString(key) * 137.508) % 360;
  return hslToHex(hue, 65, 50);
}

/** Resolve a colour for `label`: a matching preset's colour, else the deterministic fallback. */
export function colorForLabel(label: string, set: PresetSet): string {
  const preset = findPreset(label, set);
  return preset ? preset.color : fallbackColorFor(label, set.fallbackPalette);
}

/** Options for {@link applyPresetColors}. */
export interface ApplyPresetColorsOptions {
  /**
   * True for a region the caller owns outright (fresh, not yet stored, so in no
   * undo snapshot): its colour is set in place. Every other region whose
   * colour changes is copied. Default: never in place.
   */
  inPlace?: (r: Region) => boolean;
  /**
   * Called once per unknown class when `set.autoPromote` is on, with the
   * preset to add (name trimmed in `normalized` match mode, `source: 'auto'`).
   */
  onPromote?: (preset: ClassPreset) => void;
}

/**
 * Resolve each labelled region's colour from the preset set (jit-ui#70). The
 * presets are the source of truth: a matching preset gives the class colour,
 * an unknown class its deterministic fallback, **overriding any colour already
 * on the region** (e.g. embedded in imported GeoJSON). Unlabelled regions and
 * ones the user recoloured (`colorOverridden`) are left untouched. Unknown
 * classes are reported through `onPromote` when `autoPromote` is on.
 *
 * Returns a new array; regions whose colour is already right are the same
 * instances.
 */
export function applyPresetColors(regions: Region[], set: PresetSet,
                                  opts: ApplyPresetColorsOptions = {}): Region[] {
  const known = new Set(set.classes.map((c) => presetKey(set, c.name)));
  return regions.map((region) => {
    if (!region.label || region.colorOverridden) return region;
    const color = colorForLabel(region.label, set);
    if (set.autoPromote && !known.has(presetKey(set, region.label))) {
      known.add(presetKey(set, region.label));
      // In normalized mode, trim the promoted name so leading/trailing
      // whitespace doesn't create invisible duplicates or odd display names.
      const name = set.matchMode === 'normalized' ? region.label.trim() : region.label;
      opts.onPromote?.({ name, color, source: 'auto' });
    }
    if (region.color === color) return region;
    if (!opts.inPlace?.(region)) return withRegionPatch(region, { color });
    region.color = color;
    return region;
  });
}
