/**
 * The sections shown beside a split volume view: the planes x = const and y = const through the
 * stack, each as an image cut from the volume with the regions' outlines cut by the same plane.
 *
 * Section coordinates `(u, v)` (see `geometry/section`): through x, u is the slice (slice k spans
 * [k, k + 1)) and v the image y; through y, u is the image x and v the slice.
 */
export type SectionAxis = 'x' | 'y';

/** A class's outlines in a section, as interleaved `u, v`. */
export interface SectionRegions {
  label: string;
  /** `#rrggbb`. */
  color: string;
  /** Closed outlines, holes included (even-odd). */
  rings: Float64Array[];
  /** Open lines (a layer boundary across the slices); one point where it crosses one slice only. */
  lines: Float64Array[];
}

export interface SectionView {
  axis: SectionAxis;
  /** Where the plane is: image x (through x) or y (through y), px. */
  at: number;
  /** The section's image, RGBA row by row, spanning [0, size[0]] × [0, size[1]]. */
  image: { width: number; height: number; data: Uint8ClampedArray };
  /** Section units across (u) and down (v). */
  size: [number, number];
  /** The volume's world units per section unit across and down: draws it in its proportions. */
  scale: [number, number];
  regions: SectionRegions[];
  /** The other two planes, across (a u) and down (a v); null where there is none. */
  crosshair: { u: number | null; v: number | null };
}

/** Both sections; null until the split volume view has a volume to cut. */
export interface SectionViews {
  x: SectionView | null;
  y: SectionView | null;
}
