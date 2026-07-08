/**
 * Preset annotation classes (jit-ui#70).
 *
 * A class is a flat `{ name, color }` pair (v1: no hierarchy, no special-class semantics).
 * The `PresetSet` is the per-user, server-persisted source of truth for region colours;
 * see `class-color.util.ts` for the deterministic colour-resolution engine.
 */

export type PresetSource = 'user' | 'default' | 'auto';

export interface ClassPreset {
  /** The class name — matched against `Region.label`. */
  name: string;
  /** Hex colour, `#RRGGBB`. */
  color: string;
  /** Reserved for a future per-class overlay-visibility toggle. */
  visible?: boolean;
  /** Provenance; `'auto'` = added by opt-in fallback promotion. */
  source?: PresetSource;
}

export type MatchMode = 'exact' | 'normalized';

export interface PresetSet {
  /** Ordered list of preset classes. */
  classes: ClassPreset[];
  /** Colours used for classes not in `classes` (assigned deterministically). */
  fallbackPalette: string[];
  /** Opt-in (default false): add an unknown class to `classes` the first time it is seen. */
  autoPromote: boolean;
  /** Label matching against `Region.label` (default `'exact'`). */
  matchMode: MatchMode;
}

/**
 * Fallback palette for classes not present in the preset set — reasonably distinct hues.
 * Colours are assigned by a stable hash of the class name, so the same unknown class always
 * gets the same colour with no stored state.
 */
export const DEFAULT_FALLBACK_PALETTE: string[] = [
  '#6C8EBF', '#82B366', '#B85450', '#9673A6', '#D79B00',
  '#3C948B', '#A64CA6', '#CC6677', '#4477AA', '#228833',
];

/** Seed classes — mirrors the historical hard-coded `classificationColors` map. */
const DEFAULT_CLASSES: ClassPreset[] = [
  { name: 'Fragmented-embryo', color: '#FF8C00', source: 'default' },
  { name: 'Dying-embryo', color: '#FF3333', source: 'default' },
  { name: 'Two-cell-embryo', color: '#33CC66', source: 'default' },
  { name: 'One-cell-embryo', color: '#3399FF', source: 'default' },
  { name: 'Unknown', color: '#888888', source: 'default' },
  { name: 'Tumor', color: '#FF4444', source: 'default' },
  { name: 'Stroma', color: '#44AAFF', source: 'default' },
  { name: 'Immune cells', color: '#FFDD00', source: 'default' },
  { name: 'Necrosis', color: '#AA6633', source: 'default' },
  { name: 'Region', color: '#00FFFF', source: 'default' },
  { name: 'Ignore', color: '#AAAAAA', source: 'default' },
  { name: 'Positive', color: '#00CC44', source: 'default' },
  { name: 'Negative', color: '#CC0000', source: 'default' },
];

/** A fresh default preset set (deep-copied so callers can mutate safely). */
export function defaultPresetSet(): PresetSet {
  return {
    classes: DEFAULT_CLASSES.map((c) => ({ ...c })),
    fallbackPalette: [...DEFAULT_FALLBACK_PALETTE],
    autoPromote: false,
    matchMode: 'exact',
  };
}

/** True when the set has no usable classes (e.g. the server returned an empty/blank record). */
export function isEmptyPresetSet(set: PresetSet | null | undefined): boolean {
  return !set || !Array.isArray(set.classes) || set.classes.length === 0;
}
