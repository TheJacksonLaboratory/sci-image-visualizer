import type { SurfaceLayer, Viewer } from 'napari-js';

/** A region's 3D reconstruction to show in the volume: a mesh in image px (x, y) and slices (z). */
export interface RegionMesh3D {
  /** Identity (a class name): a mesh with the same key and arrays is kept, not rebuilt. */
  key: string;
  /** `#rrggbb`. */
  color: string;
  /** What hovering it shows ("HPF · Hippocampal formation"); default: the key. */
  label?: string;
  vertices: Float32Array;
  faces: Uint32Array;
}

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

/** Opacity of a region's surface in the volume. */
export const REGION_MESH_OPACITY = 0.55;
/** While some surfaces are highlighted: theirs (near opaque, so their shape reads) … */
export const REGION_MESH_HIGHLIGHT_OPACITY = 0.9;
/** … and the others' (ghosted: still there for context, not in the way). */
export const REGION_MESH_DIMMED_OPACITY = 0.12;

/**
 * The region reconstructions shown in a volume view: one translucent surface per region, in its
 * colour, placed in the volume's world box (pixel x, y and slice z mapped onto it the way the
 * volume maps its voxels). The box's Z stretch is the surfaces' `scale3d` (a uniform), so a stretch
 * alone changes no geometry; a new box re-places them. A surface is updated in place (`setData`,
 * `color`, `scale3d`) rather than added again, and picked by napari-js (`pickSurface`), which
 * picks it where it is drawn.
 *
 * Highlighting is focus + context: the highlighted surfaces turn near opaque and the others fade
 * to a ghost, so the selection stands out while staying in place among its neighbours.
 */
export class VolumeRegionMeshes {
  private readonly layers = new Map<string, { mesh: RegionMesh3D; layer: SurfaceLayer }>();
  private highlighted: ReadonlySet<string> = new Set();
  private hidden: ReadonlySet<string> = new Set();
  /** The meshes to show (kept while the volume has no frame yet). */
  private wanted: readonly RegionMesh3D[] = [];
  private frame: VolumeFrame | null = null;

  constructor(private readonly viewer: Viewer) {}

  /** Show exactly `meshes` (adding, keeping or removing surfaces). */
  set(meshes: readonly RegionMesh3D[]): void {
    this.wanted = meshes;
    this.sync();
  }

  /**
   * Follow the volume's frame. A new box (it opened, another volume) re-places every surface; a Z
   * stretch of the same box only sets their `scale3d`, so nothing is re-uploaded while dragging.
   */
  setFrame(frame: VolumeFrame): void {
    const placed = this.frame ? baseFrame(this.frame) : null;
    const next = baseFrame(frame);
    const sameBox = !!placed && sameFrame(placed, next);
    this.frame = frame;
    const scale = this.scale3d();
    for (const e of this.layers.values()) {
      if (!sameBox) e.layer.setData(toWorld(e.mesh.vertices, next), e.mesh.faces);
      e.layer.scale3d = scale;
    }
    this.sync();
  }

  /** The surfaces' GPU scale: the frame's Z stretch. */
  private scale3d(): [number, number, number] {
    const s = this.frame?.zScale;
    return [1, 1, s && s > 0 ? s : 1];
  }

  /** Highlight the surfaces of these keys (none: every surface as usual). */
  setHighlight(keys: Iterable<string>): void {
    this.highlighted = new Set(keys);
    for (const [key, e] of this.layers) e.layer.opacity = this.opacityOf(key);
    this.viewer.requestRender();
  }

  /** Hide the surfaces of these keys (they are kept, so showing them again is instant). */
  setHidden(keys: Iterable<string>): void {
    this.hidden = new Set(keys);
    for (const [key, e] of this.layers) e.layer.visible = !this.hidden.has(key);
    this.viewer.requestRender();
  }

  /** The front-most surface under screen point (`x`, `y`) (canvas CSS px), or null. */
  pickAt(x: number, y: number): RegionMesh3D | null {
    if (!this.layers.size) return null;
    const ours = new Map([...this.layers.values()].map((e) => [e.layer, e.mesh]));
    const hit = this.viewer.pickSurface(x, y, { pickable: (layer) => ours.has(layer) });
    return hit ? (ours.get(hit.layer) ?? null) : null;
  }

  /** The meshes shown. */
  get shown(): RegionMesh3D[] {
    return [...this.layers.values()].map((e) => e.mesh);
  }

  clear(): void {
    for (const [key, e] of [...this.layers]) this.remove(key, e.layer);
    this.wanted = [];
  }

  /**
   * The volume the surfaces sat in is gone (or no longer theirs): take every surface down, keeping
   * the meshes wanted, so they come back when a frame is set again.
   */
  clearFrame(): void {
    this.frame = null;
    for (const [key, e] of [...this.layers]) this.remove(key, e.layer);
    this.viewer.requestRender();
  }

  private sync(): void {
    const keep = new Map(this.wanted.map((m) => [m.key, m]));
    for (const [key, e] of [...this.layers]) {
      const want = keep.get(key);
      if (!want || !want.faces.length) {
        this.remove(key, e.layer);
        continue;
      }
      // Rebuilt or recoloured: the same surface, updated in place.
      if (want.vertices !== e.mesh.vertices && this.frame) {
        e.layer.setData(toWorld(want.vertices, baseFrame(this.frame)), want.faces);
      }
      if (want.color !== e.mesh.color) e.layer.color = want.color;
      e.mesh = want;
    }
    if (this.frame) {
      for (const mesh of this.wanted) if (!this.layers.has(mesh.key) && mesh.faces.length) this.add(mesh);
    }
    this.viewer.requestRender();
  }

  private add(mesh: RegionMesh3D): void {
    const frame = this.frame as VolumeFrame;
    const layer = this.viewer.addSurface(toWorld(mesh.vertices, baseFrame(frame)), mesh.faces, undefined, {
      name: `region ${mesh.key}`,
      scale3d: this.scale3d(),
      color: mesh.color,
      opacity: this.opacityOf(mesh.key),
      blending: 'translucent',
      fit: 'never',
    });
    layer.visible = !this.hidden.has(mesh.key);
    this.layers.set(mesh.key, { mesh, layer });
  }

  private opacityOf(key: string): number {
    if (!this.highlighted.size) return REGION_MESH_OPACITY;
    return this.highlighted.has(key) ? REGION_MESH_HIGHLIGHT_OPACITY : REGION_MESH_DIMMED_OPACITY;
  }

  private remove(key: string, layer: SurfaceLayer): void {
    this.viewer.layers.remove(layer);
    this.layers.delete(key);
  }
}

/** `frame` without its Z stretch: the box the surfaces' geometry is placed in. */
function baseFrame(frame: VolumeFrame): VolumeFrame {
  const s = frame.zScale && frame.zScale > 0 ? frame.zScale : 1;
  if (s === 1) return frame;
  return {
    size: frame.size,
    world: [frame.world[0], frame.world[1], frame.world[2] / s],
    ...(frame.planes ? { planes: frame.planes } : {}),
  };
}

/** Whether two unstretched frames place a surface alike. */
function sameFrame(a: VolumeFrame, b: VolumeFrame): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x));
  if (a.planes || b.planes) {
    const p = a.planes;
    const q = b.planes;
    return (
      !!p &&
      !!q &&
      p.z.length === q.z.length &&
      p.z.every((v, i) => near(v, q.z[i])) &&
      p.scale.every((v, i) => near(v, q.scale[i])) &&
      p.offset.every((v, i) => near(v, q.offset[i]))
    );
  }
  return a.size.every((v, i) => v === b.size[i]) && a.world.every((v, i) => near(v, b.world[i]));
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
