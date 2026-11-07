/**
 * A uniform-grid index over 2D marker centres, for picking the marker under the cursor on the CPU
 * (the WebGL fallback has no GPU pick). Built once per set of positions — a recolour, a selection
 * or a camera move leaves it alone — by a counting sort into cells, so it is two typed arrays
 * whatever the count: 3.7M markers cost ~30 MB of indices, never an object per marker.
 *
 * The pick mirrors napari-js's `PointsLayer.pick(…, { tieBreak: 'nearest' })`: a marker is hit
 * anywhere on its drawn disc, or within `slack` of its centre when it is smaller than that, and of
 * several hits the NEAREST centre wins (an exact tie goes to the one drawn later, i.e. on top).
 */
export class PointGrid {
  private readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly minX: number;
  private readonly minY: number;
  /** cellStart[c]..cellStart[c + 1] is cell c's slice of {@link order}. */
  private readonly cellStart: Uint32Array;
  /** Marker indices, grouped by cell. */
  private readonly order: Uint32Array;

  /**
   * @param positions interleaved x,y of every marker (NaN for one that is not placed)
   * @param count     how many markers `positions` holds
   */
  constructor(
    private readonly positions: Float32Array,
    readonly count: number,
  ) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const x = positions[2 * i];
      const y = positions[2 * i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      placed++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!placed) {
      minX = minY = 0;
      maxX = maxY = 1;
    }
    const w = Math.max(maxX - minX, 1e-6);
    const h = Math.max(maxY - minY, 1e-6);
    // About two markers per cell on average: few enough to scan, few enough cells to allocate.
    const cells = Math.max(1, Math.min(placed / 2, 4_000_000));
    this.cellSize = Math.max(Math.sqrt((w * h) / cells), Math.max(w, h) / 4096);
    this.cols = Math.max(1, Math.ceil(w / this.cellSize) + 1);
    this.rows = Math.max(1, Math.ceil(h / this.cellSize) + 1);
    this.minX = minX;
    this.minY = minY;

    const ncell = this.cols * this.rows;
    const cellOf = new Int32Array(count).fill(-1);
    const counts = new Uint32Array(ncell + 1);
    for (let i = 0; i < count; i++) {
      const c = this.cellAt(positions[2 * i], positions[2 * i + 1]);
      if (c < 0) continue;
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < ncell; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.order = new Uint32Array(counts[ncell]);
    const fill = counts.slice(0, ncell);
    for (let i = 0; i < count; i++) {
      const c = cellOf[i];
      if (c >= 0) this.order[fill[c]++] = i;
    }
  }

  private cellAt(x: number, y: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    const cx = Math.floor((x - this.minX) / this.cellSize);
    const cy = Math.floor((y - this.minY) / this.cellSize);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return -1;
    return cy * this.cols + cx;
  }

  /**
   * The marker under (x, y), or -1.
   *
   * @param radiusOf  the drawn radius of marker i, in the same units as the positions
   * @param maxRadius an upper bound on every `radiusOf(i)`, so the search knows how far to look
   * @param slack     hit distance for markers drawn smaller than it
   * @param shown     whether marker i is drawn at all (a hidden one is never picked)
   */
  pick(
    x: number,
    y: number,
    radiusOf: (i: number) => number,
    maxRadius: number,
    slack: number,
    shown: (i: number) => boolean = () => true,
  ): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    const reach = Math.max(maxRadius, slack);
    const x0 = Math.max(0, Math.floor((x - reach - this.minX) / this.cellSize));
    const x1 = Math.min(this.cols - 1, Math.floor((x + reach - this.minX) / this.cellSize));
    const y0 = Math.max(0, Math.floor((y - reach - this.minY) / this.cellSize));
    const y1 = Math.min(this.rows - 1, Math.floor((y + reach - this.minY) / this.cellSize));
    let best = -1;
    let bestD = Infinity;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * this.cols + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const i = this.order[k];
          const dx = this.positions[2 * i] - x;
          const dy = this.positions[2 * i + 1] - y;
          const d = Math.hypot(dx, dy);
          if (d > Math.max(radiusOf(i), slack)) continue;
          // Nearest wins; a tie goes to the later marker, which is drawn on top.
          if (d < bestD || (d === bestD && i > best)) {
            if (!shown(i)) continue;
            best = i;
            bestD = d;
          }
        }
      }
    }
    return best;
  }
}
