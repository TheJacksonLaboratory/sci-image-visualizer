import { IIsosurfaceControls } from '../../contracts/visualizer.contract';
import { bt601Luminance } from '../../contracts/intensity';

/** The toolbar iso slider's domain (isoValueMax). */
const SLIDER_MAX = 255;

/** Min/max intensity over every voxel of the frames (RGB → luminance), or null
 *  for empty or flat input. */
export function measureIntensityRange(frames: any[], isGrayscale: boolean): [number, number] | null {
  let min = Infinity,
    max = -Infinity;
  for (const frame of frames || []) {
    for (const row of frame || []) {
      for (const cell of row || []) {
        const v = isGrayscale ? cell : bt601Luminance(cell[0], cell[1], cell[2]);
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? [min, max] : null;
}

/**
 * The ISOSURFACE intensity band. The slider is a fixed 0–255, but a stack often
 * occupies only a narrow sub-range (e.g. an EDOF volume at ~2–50 with structure
 * near 6–10), so the band is mapped onto the volume's measured range: every
 * intensity is easy to reach and the band always lands inside the data — a
 * small inset keeps the extreme surfaces off the exact data edges, which are
 * degenerate and draw nothing.
 */
export class PlotlyIsosurfaceControls implements IIsosurfaceControls {
  /** The band as 0–255 slider positions. Defaults to the full range so the
   *  first render shows the whole structure. */
  private isoMin = 0;
  private isoMax = SLIDER_MAX;
  /** The measured [min, max] of the volume on screen; null until measured. */
  private dataRange: [number, number] | null = null;

  /**
   * @param isLive whether an isosurface is on screen now
   * @param restyle restyles the live isosurface's `isomin`/`isomax`
   */
  constructor(
    private readonly isLive: () => boolean,
    private readonly restyle: (update: { isomin: number[]; isomax: number[] }) => void,
  ) {}

  /** Measure the volume about to be rendered, so the band maps onto its range. */
  measure(frames: any[], isGrayscale: boolean): void {
    this.dataRange = measureIntensityRange(frames, isGrayscale);
  }

  /** The current band in data units, for the next render. */
  band(): [number, number] {
    return this.mapBand(this.isoMin, this.isoMax);
  }

  /** Update the band; a live isosurface is restyled in place (no volume rebuild). */
  setIsoRange(isoMin: number, isoMax: number): void {
    this.isoMin = isoMin;
    this.isoMax = isoMax;
    if (this.isLive()) {
      const [lo, hi] = this.mapBand(isoMin, isoMax);
      this.restyle({ isomin: [lo], isomax: [hi] });
    }
  }

  /** Slider band → data units, through the measured range (as-is before one). */
  private mapBand(isoMin: number, isoMax: number): [number, number] {
    let lo = Math.min(isoMin, isoMax);
    let hi = Math.max(isoMin, isoMax);
    if (this.dataRange) {
      const [vMin, vMax] = this.dataRange;
      const span = vMax - vMin;
      const pad = 0.03 * span;
      const usable = span - 2 * pad;
      lo = vMin + pad + (lo / SLIDER_MAX) * usable;
      hi = vMin + pad + (hi / SLIDER_MAX) * usable;
      if (lo > hi) {
        const t = lo;
        lo = hi;
        hi = t;
      }
    }
    return [lo, hi];
  }
}
