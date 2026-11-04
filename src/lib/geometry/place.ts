/**
 * Where a stack's reconstructions sit in a 3D view's world (pure: the volume and spatial 3D views
 * place region surfaces with it, on the main thread or in a worker).
 */

/** Where the stack sits in the volume's world: its full size, and the centred world box it fills. */
export interface VolumeFrame {
  /** Image width, height (px) and slice count. */
  size: [number, number, number];
  /** The world box (centred on the origin), Z as currently stretched. */
  world: [number, number, number];
  /**
   * How much of {@link world}'s depth is the view's Z stretch (default 1). The region surfaces keep
   * their geometry in the unstretched box and take the stretch as a GPU scale (`scale3d`), so
   * dragging the Z handle re-uploads no mesh.
   */
  zScale?: number;
  /**
   * The slices at z of their own rather than spread over the box: a region set's planes (a 3D
   * segmentation's, outlined on an image of one plane) placed where the observations are. Given,
   * it places the surfaces and {@link size} and {@link world} do not.
   */
  planes?: PlanePlacement;
}

/**
 * Image px and slices → world, slice by slice: `x * scale[0] + offset[0]`, `y * scale[1] +
 * offset[1]`, and slice k at `z[k] + offset[2]` (unstretched): between two slices in proportion,
 * past the ends by the nearest spacing (a surface's caps, half a slice out).
 */
export interface PlanePlacement {
  /** Each slice's z, by slice index, ascending. */
  z: readonly number[];
  scale: [number, number];
  offset: [number, number, number];
}

/**
 * Image px / slice coordinates → the volume's centred world box: pixel x of a `w`-wide image
 * spans the box's width, slice k sits at the middle of its share of the box's depth. With
 * {@link VolumeFrame.planes}, as they place them instead.
 */
export function toWorld(vertices: Float32Array, frame: VolumeFrame): Float32Array {
  if (frame.planes) return planesToWorld(vertices, frame.planes);
  const [w, h, d] = frame.size;
  const [ww, wh, wd] = frame.world;
  const out = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    out[i] = (vertices[i] / w - 0.5) * ww;
    out[i + 1] = (vertices[i + 1] / h - 0.5) * wh;
    out[i + 2] = ((vertices[i + 2] + 0.5) / d - 0.5) * wd;
  }
  return out;
}

/** Image px / slice coordinates → world, as {@link PlanePlacement} places them. */
function planesToWorld(vertices: Float32Array, planes: PlanePlacement): Float32Array {
  const { z, scale, offset } = planes;
  const out = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    out[i] = vertices[i] * scale[0] + offset[0];
    out[i + 1] = vertices[i + 1] * scale[1] + offset[1];
    out[i + 2] = sliceZ(z, vertices[i + 2]) + offset[2];
  }
  return out;
}

/**
 * The z of slice `k` (fractional): between two slices in proportion, past the ends by the nearest
 * spacing (one slice alone: a unit apart).
 */
export function sliceZ(z: readonly number[], k: number): number {
  const n = z.length;
  if (!n) return k;
  if (n === 1) return z[0] + k;
  const i = Math.min(n - 2, Math.max(0, Math.floor(k)));
  return z[i] + (k - i) * (z[i + 1] - z[i]);
}
