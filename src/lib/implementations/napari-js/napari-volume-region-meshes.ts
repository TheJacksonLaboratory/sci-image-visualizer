import type { SurfaceLayer, Viewer } from 'napari-js';

import { PlanePlacement, VolumeFrame, sliceZ, toWorld } from '../../geometry/place';

export type { PlanePlacement, VolumeFrame };
export { sliceZ, toWorld };

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

/** Places a mesh's vertices (image px, slices) in a 3D view's world, off the main thread. */
export type RegionPlacer = (vertices: Float32Array, frame: VolumeFrame) => Promise<Float32Array>;

/** Opacity of a region's surface in the volume. */
export const REGION_MESH_OPACITY = 0.55;
/** While some surfaces are highlighted: theirs (near opaque, so their shape reads) … */
export const REGION_MESH_HIGHLIGHT_OPACITY = 0.9;
/** … and the others' (ghosted: still there for context, not in the way). */
export const REGION_MESH_DIMMED_OPACITY = 0.12;
/**
 * A selection's surfaces while the others are ghosted: opaque, so they are drawn first and write
 * depth, and the ghosted surfaces in front of them are blended over them rather than hiding them
 * (a translucent surface draws only its own nearest faces, and is drawn after the opaque ones).
 */
export const REGION_MESH_SELECTED_OPACITY = 1;

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
  /** Surfaces faded: none of what is selected is in them. */
  private muted: ReadonlySet<string> = new Set();
  /** The meshes to show (kept while the volume has no frame yet). */
  private wanted: readonly RegionMesh3D[] = [];
  private frame: VolumeFrame | null = null;

  /** The placements in flight, by key: the mesh and box each is for. */
  private readonly placing = new Map<string, { mesh: RegionMesh3D; frame: VolumeFrame; token: number }>();
  private token = 0;

  /**
   * `placer`, when given, places a mesh's vertices in the world off the main thread (a worker, see
   * `placeInWorker`): a class's surface has hundreds of thousands of vertices, and placing every
   * one in a loop here held the UI for seconds. Each surface then comes up as its placement lands,
   * the one it replaces kept until then. Without one, they are placed at once (the tests).
   */
  constructor(
    private readonly viewer: Viewer,
    private readonly placer?: RegionPlacer,
    /** Whether a surface added is drawn as a wireframe (the toggle's state then). */
    private readonly wireframe: () => boolean = () => false,
  ) {}

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
      if (!sameBox) this.place(e.mesh);
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

  /**
   * Fade the surfaces of these keys, as a picked region fades the others (none: each as usual):
   * with a selection, the regions none of it is in fade and those it is in come forward, each
   * keeping its colour.
   */
  setMuted(keys: Iterable<string>): void {
    const next = new Set(keys);
    if (next.size === this.muted.size && [...next].every((k) => this.muted.has(k))) return;
    this.muted = next;
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
      const rebuilt = want.vertices !== e.mesh.vertices;
      if (want.color !== e.mesh.color) e.layer.color = want.color;
      e.mesh = want;
      if (rebuilt && this.frame) this.place(want);
    }
    if (this.frame) {
      for (const mesh of this.wanted) if (!this.layers.has(mesh.key) && mesh.faces.length) this.place(mesh);
    }
    this.viewer.requestRender();
  }

  /**
   * Place `mesh` in the current box, adding its surface or updating it: at once, or through the
   * placer, its result kept only if the mesh and the box are still the ones wanted. A placement
   * already in flight for the same mesh and box is not asked again.
   */
  private place(mesh: RegionMesh3D): void {
    const frame = this.frame;
    if (!frame) return;
    const base = baseFrame(frame);
    if (!this.placer) {
      this.apply(mesh, toWorld(mesh.vertices, base));
      return;
    }
    const pending = this.placing.get(mesh.key);
    if (pending && pending.mesh === mesh && sameFrame(pending.frame, base)) return;
    const token = ++this.token;
    this.placing.set(mesh.key, { mesh, frame: base, token });
    this.placer(mesh.vertices, base).then(
      (world) => {
        if (this.placing.get(mesh.key)?.token !== token) return;
        this.placing.delete(mesh.key);
        const wanted = this.wanted.find((m) => m.key === mesh.key);
        if (wanted !== mesh || !this.frame || !sameFrame(baseFrame(this.frame), base)) return;
        this.apply(mesh, world);
        this.viewer.requestRender();
      },
      (err) => {
        if (this.placing.get(mesh.key)?.token === token) this.placing.delete(mesh.key);
        console.warn(`[napari-js] region ${mesh.key} could not be placed in 3D`, err);
      },
    );
  }

  /** `mesh`'s surface with its vertices placed at `world`: updated in place, or added. */
  private apply(mesh: RegionMesh3D, world: Float32Array): void {
    const e = this.layers.get(mesh.key);
    if (e) {
      e.layer.setData(world, mesh.faces);
      return;
    }
    this.add(mesh, world);
  }

  private add(mesh: RegionMesh3D, world: Float32Array): void {
    const layer = this.viewer.addSurface(world, mesh.faces, undefined, {
      name: `region ${mesh.key}`,
      scale3d: this.scale3d(),
      color: mesh.color,
      opacity: this.opacityOf(mesh.key),
      blending: 'translucent',
      fit: 'never',
      wireframe: this.wireframe(),
    });
    layer.visible = !this.hidden.has(mesh.key);
    this.layers.set(mesh.key, { mesh, layer });
  }

  private opacityOf(key: string): number {
    if (this.muted.size) return this.muted.has(key) ? REGION_MESH_DIMMED_OPACITY : REGION_MESH_SELECTED_OPACITY;
    if (!this.highlighted.size) return REGION_MESH_OPACITY;
    return this.highlighted.has(key) ? REGION_MESH_SELECTED_OPACITY : REGION_MESH_DIMMED_OPACITY;
  }

  private remove(key: string, layer: SurfaceLayer): void {
    this.viewer.layers.remove(layer);
    this.layers.delete(key);
    this.placing.delete(key);
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
