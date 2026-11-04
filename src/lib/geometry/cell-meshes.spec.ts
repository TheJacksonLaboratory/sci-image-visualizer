import { reconstructCells } from './cell-meshes';

const square = (x: number, s = 20) => [x, 0, x + s, 0, x + s, s, x, s];

describe('reconstructCells', () => {
  it('meshes each cell by itself, every vertex knowing its cell, two touching cells two surfaces', () => {
    // Two cells side by side, touching, on two planes: a union would make them one surface.
    const mesh = reconstructCells(
      [
        { cell: 7, slices: [0, 1].map((z) => ({ z, rings: [square(0)] })) },
        { cell: 9, slices: [0, 1].map((z) => ({ z, rings: [square(20)] })) },
        { cell: 4, slices: [] }, // nothing to mesh
      ],
      { pixelStep: 2 },
    );
    expect(Array.from(mesh.cells)).toEqual([7, 9]);
    expect(mesh.vertexCell.length).toBe(mesh.vertices.length / 3);
    expect(new Set(mesh.vertexCell)).toEqual(new Set([7, 9]));
    // Each face lies within one cell.
    for (let f = 0; f < mesh.faces.length; f += 3) {
      const c = mesh.vertexCell[mesh.faces[f]];
      expect(mesh.vertexCell[mesh.faces[f + 1]]).toBe(c);
      expect(mesh.vertexCell[mesh.faces[f + 2]]).toBe(c);
    }
    // Cell 9's vertices stay on its side (x >= ~20, give or take the smoothing).
    const xs9 = Array.from(mesh.vertexCell)
      .map((c, i) => (c === 9 ? mesh.vertices[i * 3] : NaN))
      .filter(Number.isFinite);
    expect(Math.min(...xs9)).toBeGreaterThan(15);
  });

  it('is empty for no cells', () => {
    const mesh = reconstructCells([]);
    expect(mesh.faces.length).toBe(0);
    expect(mesh.cells.length).toBe(0);
  });
});
