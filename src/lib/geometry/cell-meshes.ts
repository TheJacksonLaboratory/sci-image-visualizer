import { ReconstructOptions, SliceOutlines, reconstruct } from './reconstruct';

/**
 * A 3D segmentation's cells reconstructed one by one: each cell's outlines on the planes it spans
 * (see `SliceOutlines`, slice k at z = k) meshed by themselves ({@link reconstruct}), so two cells
 * of one type that touch stay two surfaces, where a class's union merges them.
 *
 * The meshes are concatenated into one, which a single surface layer draws, with each vertex's
 * cell ({@link CellsMesh.vertexCell}): what colours a cell, hides it, or names it under the pointer.
 */

/** One cell's outlines: the cell (an observation index) and its rings on each plane it spans. */
export interface CellOutlines {
  cell: number;
  slices: SliceOutlines[];
}

/** Cells' surfaces in one mesh, in image px (x, y) and slice indices (z), each vertex's cell known. */
export interface CellsMesh {
  vertices: Float32Array;
  faces: Uint32Array;
  /** The cell (observation index) of each vertex. */
  vertexCell: Uint32Array;
  /** The cells meshed (those with an area on some plane), in order. */
  cells: Uint32Array;
}

/** Each cell's surface by itself (one smoothing pass: a cell is a few voxels across). */
export function reconstructCells(cells: readonly CellOutlines[], opts: ReconstructOptions = {}): CellsMesh {
  const parts: { cell: number; vertices: Float32Array; faces: Uint32Array }[] = [];
  let nv = 0;
  let nf = 0;
  for (const c of cells) {
    if (!c.slices.length) continue;
    const mesh = reconstruct(c.slices, { smooth: 1, ...opts });
    if (!mesh.faces.length) continue;
    parts.push({ cell: c.cell, vertices: mesh.vertices, faces: mesh.faces });
    nv += mesh.vertices.length / 3;
    nf += mesh.faces.length;
  }
  const vertices = new Float32Array(nv * 3);
  const faces = new Uint32Array(nf);
  const vertexCell = new Uint32Array(nv);
  let v = 0;
  let f = 0;
  for (const p of parts) {
    vertices.set(p.vertices, v * 3);
    for (let i = 0; i < p.faces.length; i++) faces[f + i] = p.faces[i] + v;
    const n = p.vertices.length / 3;
    vertexCell.fill(p.cell, v, v + n);
    v += n;
    f += p.faces.length;
  }
  return { vertices, faces, vertexCell, cells: Uint32Array.from(parts.map((p) => p.cell)) };
}

/** The buffers of a {@link CellsMesh}, to hand them across a worker boundary without a copy. */
export function cellsMeshBuffers(mesh: CellsMesh): ArrayBuffer[] {
  return [mesh.vertices.buffer, mesh.faces.buffer, mesh.vertexCell.buffer, mesh.cells.buffer] as ArrayBuffer[];
}
