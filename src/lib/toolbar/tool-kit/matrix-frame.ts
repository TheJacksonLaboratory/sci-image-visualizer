import type { CachedImageData } from './canvas-tool';

/**
 * The mapping between a backend's data coordinates and the pixel matrix of a
 * cached readback (`CachedImageData`): `matrix = (data - origin) / ratio` per
 * axis. OSD and napari publish distinct `[ratioX, ratioY]`, so rows must use
 * the Y ratio; a single ratio is used for both axes when only one is supplied.
 */
export class MatrixFrame {
  private constructor(
    /** Data units per matrix column. */
    readonly rx: number,
    /** Data units per matrix row. */
    readonly ry: number,
    /** Data X of matrix column 0. */
    readonly ox: number,
    /** Data Y of matrix row 0. */
    readonly oy: number,
  ) {}

  /** The frame of a readback. Missing/zero ratios fall back to 1, missing origins to 0. */
  static from(cached: Pick<CachedImageData, 'ratios' | 'originX' | 'originY'>): MatrixFrame {
    const rx = cached.ratios[0] || 1;
    const ry = cached.ratios[1] || cached.ratios[0] || 1;
    return new MatrixFrame(rx, ry, cached.originX ?? 0, cached.originY ?? 0);
  }

  /** Identity of the frame: a stroke built in matrix coords is only valid while this is unchanged. */
  get sig(): string {
    return `${this.rx},${this.ry},${this.ox},${this.oy}`;
  }

  toMatrixX(x: number): number { return (x - this.ox) / this.rx; }
  toMatrixY(y: number): number { return (y - this.oy) / this.ry; }
  toDataX(mx: number): number { return this.ox + mx * this.rx; }
  toDataY(my: number): number { return this.oy + my * this.ry; }

  /** A ring (parallel arrays) from data to matrix coords. */
  ringToMatrix(xs: number[], ys: number[]): { xs: number[]; ys: number[] } {
    return { xs: xs.map((x) => this.toMatrixX(x)), ys: ys.map((y) => this.toMatrixY(y)) };
  }

  /** A ring (parallel arrays) from matrix to data coords. */
  ringToData(xs: number[], ys: number[]): { xs: number[]; ys: number[] } {
    return { xs: xs.map((x) => this.toDataX(x)), ys: ys.map((y) => this.toDataY(y)) };
  }

  /** Hole rings (`[[x, y], …]`) from data to matrix coords. */
  holesToMatrix(holes: number[][][] | undefined): number[][][] | undefined {
    return holes?.map((ring) => ring.map(([x, y]) => [this.toMatrixX(x), this.toMatrixY(y)]));
  }

  /** Hole rings (`[[x, y], …]`) from matrix to data coords. */
  holesToData(holes: number[][][] | undefined): number[][][] | undefined {
    return holes?.map((ring) => ring.map(([x, y]) => [this.toDataX(x), this.toDataY(y)]));
  }
}
