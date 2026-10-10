import { bt601Luminance, histogram256 } from '../../contracts/intensity';
import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { PixelData } from '../../contracts/visualizer.contract';
import { PlotType } from '../../contracts/plot-type';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';

/**
 * Pure reads of what the Plotly backend has on screen or in memory: a trace's
 * pixels, a frame's histogram, the image rect the axes show, and the restyle
 * that applies the channel display state.
 */

/** A plotted trace's `z` grid as flat pixels: an RGB `image` trace keeps its
 *  channels (3 or 4), a heatmap is one rounded channel. Null when empty. */
export function tracePixels(trace: { type?: string; z?: any[][] } | undefined): PixelData | null {
  const zData = trace?.z;
  if (!zData) return null;
  const height = zData.length;
  if (height === 0) return null;
  const width = zData[0].length;
  if (trace!.type === 'image') {
    // RGB image: z[row][col] = [r, g, b] or [r, g, b, a]
    const sample = zData[0][0];
    const channels = Array.isArray(sample) ? sample.length : 3;
    const data = new Uint8ClampedArray(width * height * channels);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixel = zData[y][x];
        const offset = (y * width + x) * channels;
        for (let c = 0; c < channels; c++) data[offset + c] = pixel[c];
      }
    }
    return { width, height, channels, data };
  }
  // Heatmap (grayscale): z[row][col] = scalar value
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = Math.round(zData[y][x]);
  }
  return { width, height, channels: 1, data };
}

/** 256-bin histogram of one channel of a frame (raw, pre-LUT). Grayscale cells
 *  are numbers; RGB cells `[r,g,b]` give channel `channelIndex`, or the BT.601
 *  luminance for an index past their channels. */
export function frameHistogram(frame: any[], channelIndex: number): IHistogram {
  const counts = new Array(256).fill(0);
  for (const row of frame) {
    if (!row) continue;
    for (const cell of row) {
      let v: number;
      if (Array.isArray(cell)) {
        v =
          channelIndex >= 0 && channelIndex < cell.length
            ? cell[channelIndex]
            : Math.round(bt601Luminance(cell[0], cell[1], cell[2]));
      } else {
        v = cell;
      }
      v = v | 0;
      if (v < 0) v = 0;
      else if (v > 255) v = 255;
      counts[v]++;
    }
  }
  return histogram256(counts);
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * The image rect the plot shows, from the live axis ranges — after a high-def
 * zoom the axes are relaid out to the crop's bounds, so the ranges ARE the
 * crop — else the whole image `[x0, x1, y0, y1]`, else null.
 */
export function axesSourceRect(
  xr: number[] | undefined,
  yr: number[] | undefined,
  trueImgSize: number[] | undefined,
): Rect | null {
  if (xr && yr) {
    const x0 = Math.min(xr[0], xr[1]);
    const y0 = Math.min(yr[0], yr[1]); // y axis is reversed for image layouts
    return { x: x0, y: y0, width: Math.abs(xr[1] - xr[0]), height: Math.abs(yr[1] - yr[0]) };
  }
  if (!trueImgSize) return null;
  return {
    x: trueImgSize[0],
    y: trueImgSize[2],
    width: trueImgSize[1] - trueImgSize[0],
    height: trueImgSize[3] - trueImgSize[2],
  };
}

/**
 * The restyle that live-applies the channel display: the colour scale, reverse
 * (reverse-scale and invert each flip the ramp; both together cancel) and the
 * Intensity channel's window — cmin/cmax for the 3D plot types, zmin/zmax for
 * heatmap/contour. A trace without a colour scale ignores these attributes.
 */
export function channelDisplayRestyle(
  channels: IChannelState[],
  reverse: boolean,
  invert: boolean,
  colorscale: unknown,
  plotType: PlotType,
): Record<string, unknown> {
  const update: Record<string, unknown> = { reversescale: reverse !== invert };
  if (colorscale != null) update['colorscale'] = colorscale;
  const ch = channels?.[0];
  if (ch) {
    const threeD =
      plotType === PlotType.ISOSURFACE || plotType === PlotType.SURFACE || plotType === PlotType.SCATTER3D;
    if (threeD) Object.assign(update, { cmin: ch.min, cmax: ch.max, cauto: false });
    else Object.assign(update, { zmin: ch.min, zmax: ch.max, zauto: false });
  }
  return update;
}
