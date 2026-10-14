import { tintColormap } from 'napari-js';
import type { SurfaceLayer, Viewer } from 'napari-js';

/** A region's 3D reconstruction to show in the volume: a mesh in image px (x, y) and slices (z). */
export interface RegionMesh3D {
  /** Identity (a class name): a mesh with the same key and arrays is kept, not rebuilt. */
  key: string;
  /** `#rrggbb`. */
  color: string;
  vertices: Float32Array;
  faces: Uint32Array;
}

/** Where the stack sits in the volume's world: its full size, and the centred world box it fills. */
export interface VolumeFrame {
  /** Image width, height (px) and slice count. */
  size: [number, number, number];
  /** The world box (centred on the origin), Z as currently stretched. */
  world: [number, number, number];
}

/** Opacity of a region's surface in the volume. */
export const REGION_MESH_OPACITY = 0.55;

/**
 * The region reconstructions shown in a volume view: one translucent surface per region, in its
 * colour, placed in the volume's world box (pixel x, y and slice z mapped onto it the way the
 * volume maps its voxels) and re-placed when the volume's Z is stretched.
 */
export class VolumeRegionMeshes {
  private readonly layers = new Map<string, { mesh: RegionMesh3D; layer: SurfaceLayer }>();
  /** The meshes to show (kept while the volume has no frame yet). */
  private wanted: readonly RegionMesh3D[] = [];
  private frame: VolumeFrame | null = null;

  constructor(private readonly viewer: Viewer) {}

  /** Show exactly `meshes` (adding, keeping or removing surfaces). */
  set(meshes: readonly RegionMesh3D[]): void {
    this.wanted = meshes;
    this.sync();
  }

  /** Follow the volume's frame (it opened, or its Z was stretched): re-place every surface. */
  setFrame(frame: VolumeFrame): void {
    this.frame = frame;
    for (const [key, e] of [...this.layers]) this.remove(key, e.layer);
    this.sync();
  }

  /** The meshes shown. */
  get shown(): RegionMesh3D[] {
    return [...this.layers.values()].map((e) => e.mesh);
  }

  clear(): void {
    for (const [key, e] of [...this.layers]) this.remove(key, e.layer);
    this.wanted = [];
  }

  private sync(): void {
    const keep = new Map(this.wanted.map((m) => [m.key, m]));
    for (const [key, e] of [...this.layers]) {
      const want = keep.get(key);
      if (!want || want.vertices !== e.mesh.vertices || want.color !== e.mesh.color) this.remove(key, e.layer);
    }
    if (this.frame) {
      for (const mesh of this.wanted) if (!this.layers.has(mesh.key) && mesh.faces.length) this.add(mesh);
    }
    this.viewer.requestRender();
  }

  private add(mesh: RegionMesh3D): void {
    const frame = this.frame as VolumeFrame;
    const world = toWorld(mesh.vertices, frame);
    const values = new Float32Array(world.length / 3).fill(1);
    const layer = this.viewer.addSurface(world, mesh.faces, values, {
      name: `region ${mesh.key}`,
      colormap: tintColormap(mesh.color),
      contrastLimits: [0, 1],
      opacity: REGION_MESH_OPACITY,
      blending: 'translucent',
      fit: 'never',
    });
    this.layers.set(mesh.key, { mesh, layer });
  }

  private remove(key: string, layer: SurfaceLayer): void {
    this.viewer.layers.remove(layer);
    this.layers.delete(key);
  }
}

/**
 * Image px / slice coordinates → the volume's centred world box: pixel x of a `w`-wide image
 * spans the box's width, slice k sits at the middle of its share of the box's depth.
 */
export function toWorld(vertices: Float32Array, frame: VolumeFrame): Float32Array {
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
