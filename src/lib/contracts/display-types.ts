/**
 * Publication-critical types that were `any` on the public contracts
 * (refactoring plan, Step 6). Deliberately permissive — every field optional —
 * so existing hosts (which pass PrimeNG `TreeNode`s and plain option objects)
 * keep compiling unchanged while consumers finally get named shapes.
 */

/** A colormap value as Plotly understands it: a built-in scale name (e.g.
 *  'Viridis') or an inline array of `[stop, color]` pairs. */
export type ColormapValue = string | Array<[number, string]>;

/** One node of the colormap selector tree (structurally compatible with the
 *  PrimeNG `TreeNode`s the host passes): group nodes carry `children`, leaf
 *  nodes carry the scale in `data.value` (+ a preview image in `data.src`). */
export interface ColormapNode {
  label?: string;
  data?: { value?: ColormapValue; src?: string };
  children?: ColormapNode[];
}

/** Magic-wand pixel-comparison space. */
export type WandType = 'GRAY' | 'RGB' | 'LAB_DISTANCE';

/** Options for the magic-wand tool (QuPath-style). */
export interface IWandOptions {
  type?: WandType;
  /** Gaussian sigma applied to the patch before thresholding. */
  sigma?: number;
  /** Higher = stricter (smaller selection) for GRAY/RGB; higher = looser for
   *  LAB_DISTANCE — matches QuPath. */
  sensitivity?: number;
  /** Square patch size in pixels (must be odd). */
  patchSize?: number;
  /** When true, skip blur/threshold and flood-fill at exact-match
   *  (Cmd/Ctrl-click in QuPath). */
  simpleMode?: boolean;
}
