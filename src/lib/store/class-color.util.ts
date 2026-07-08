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
 * set is handled by the store, which owns persistence.
 */
import { ClassPreset, PresetSet } from '../models/class-preset';

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

function hslToHex(hDeg: number, sPct: number, lPct: number): string {
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
