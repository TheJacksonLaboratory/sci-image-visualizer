import type * as OpenSeadragon from 'openseadragon';

import { elementToImage } from './osd-coords';
import { CachedImageData } from '../../toolbar/tool-kit/canvas-tool';
import { packedFrame } from '../../toolbar/tool-kit/frame-pixels';
import { PixelData } from '../../contracts/visualizer.contract';

/** The 2D drawer's canvas (OSD is created with `drawer: 'canvas'`), if it has a size. */
function drawerCanvas(viewer: OpenSeadragon.Viewer | null): HTMLCanvasElement | null {
  const canvas: HTMLCanvasElement | undefined = viewer?.drawer?.canvas;
  return canvas && canvas.width && canvas.height ? canvas : null;
}

/**
 * The currently displayed pixels — the rendered viewport (what the user sees,
 * including the current zoom and any colormap recolor), as RGBA. Null until
 * tiles are drawn.
 */
export function readDrawerPixels(viewer: OpenSeadragon.Viewer | null): PixelData | null {
  const canvas = drawerCanvas(viewer);
  const ctx = canvas?.getContext('2d', { willReadFrequently: true });
  if (!canvas || !ctx) return null;
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height);
  return { width, height, channels: 4, data: img.data };
}

/**
 * Read back the *currently rendered* OSD canvas as the pixel tools' frame.
 * The frame covers only the visible viewport at screen resolution, so when
 * the user is zoomed into a sub-region the wand samples that region's detail
 * (rather than the whole image at preview resolution). `originX/originY` and
 * `ratios` map image coords <-> readback-pixel coords for the wand's
 * data/ratio/origin model. The RGBA readback is the frame as-is (packed,
 * RT-17 / OSD-PLOTLY-12): no per-pixel arrays.
 */
export function readbackViewportFrame(viewer: OpenSeadragon.Viewer | null): CachedImageData | null {
  const canvas = drawerCanvas(viewer);
  if (!canvas || !viewer?.viewport) return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const w = canvas.width; // device pixels
  const h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;

  // Image-coord span the readback covers (CSS px in, image coords out). Route
  // through world item 0 (osd-coords) so it stays accurate — and quiet — when
  // the world holds multiple images (per-channel multichannel layers).
  const elW = canvas.clientWidth || w;
  const elH = canvas.clientHeight || h;
  const tl = elementToImage(viewer, 0, 0);
  const br = elementToImage(viewer, elW, elH);
  const ratioX = (br.x - tl.x) / w; // image px per readback px
  const ratioY = (br.y - tl.y) / h;

  return {
    frames: [packedFrame(data, w, h)],
    width: w,
    height: h,
    ratios: [ratioX, ratioY],
    isGrayscale: false, // canvas readback is always RGBA
    originX: tl.x,
    originY: tl.y,
  };
}

/** Save the rendered view (the drawer canvas) as `<stem>.png`; a no-op before
 *  anything is drawn. */
export function saveDrawerSnapshot(viewer: OpenSeadragon.Viewer | null, save: (blob: Blob) => void): void {
  drawerCanvas(viewer)?.toBlob((blob) => {
    if (blob) save(blob);
  }, 'image/png');
}
