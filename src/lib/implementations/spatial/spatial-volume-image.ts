import { IImageInfo } from '../../contracts/image.contract';
import {
  SpatialDataset, SpatialImageRef, SpatialObservations, SpatialVolumeMeta,
} from '../../contracts/spatial-dataset.contract';

/**
 * A dataset's reference volume, encoded as the z-stack image the 2D path renders,
 * plus the blob URLs backing it.
 *
 * The URLs belong to the CALLER: nothing else can know when the image stops being
 * displayed, and a dataset switch that forgets to revoke them leaks a volume's
 * worth of PNGs per switch.
 */
export interface VolumeStackImage {
  info: IImageInfo;
  urls: string[];
}

/** Encode one canvas as a PNG blob, over whichever canvas flavour this runtime has. */
async function toPngBlob(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob produced nothing'))), 'image/png');
  });
}

/**
 * Turn a spatial dataset's registered volume into a scrubbable z-stack image.
 *
 * A 3D omics dataset arrives as one volume and NO `imageRef`, so there is no image
 * behind it — which left every image-shaped surface (the Image view, the slice
 * bar, the contrast window, regions) with nothing to work on, and the Image view
 * showing whatever slide happened to be loaded before. Encoding each z plane as a
 * blob PNG makes the volume itself the image, so the existing stack machinery
 * drives it unchanged: the same `urls[z]` + `isStack` shape a host emits for a
 * multi-page TIFF, which is exactly what this volume is.
 *
 * Every plane is encoded up front rather than on demand, because the slice count
 * comes from `urls.length` — the component has to know the depth before the user
 * scrubs. The voxels are already resident (megabytes, fetched in one call), and a
 * plane is a few KB of PNG, so the cost is bounded by the volume the host already
 * chose to fetch.
 *
 * Returns null when the dataset declares no volume, or the byte count contradicts
 * the declared geometry — a short buffer would silently produce slices of shifted
 * anatomy, which is worse than no image at all.
 */
export async function buildVolumeStackImage(
  dataset: SpatialDataset,
  voxels: Uint8Array,
): Promise<VolumeStackImage | null> {
  const meta = dataset.volume;
  if (!meta) return null;
  const { width, height, depth } = meta;
  const plane = width * height;
  if (voxels.length !== plane * depth) {
    console.warn(
      `[spatial] volume is ${voxels.length} bytes but its geometry declares ` +
        `${plane * depth} (${width}x${height}x${depth}) — not rendering it as an image`,
    );
    return null;
  }

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('[spatial] volume slice encode: 2D context unavailable');

  // One canvas and one RGBA buffer for the whole stack — a canvas per plane would
  // be `depth` GPU-backed surfaces alive at once for no gain.
  const rgba = new Uint8ClampedArray(plane * 4);
  const urls: string[] = [];
  for (let z = 0; z < depth; z++) {
    const base = z * plane;
    for (let i = 0; i < plane; i++) {
      const v = voxels[base + i];
      const o = i * 4;
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    urls.push(URL.createObjectURL(await toPngBlob(canvas)));
  }

  // voxelSize is in the OBSERVATIONS' units, so it only means microns once
  // `micronsPerUnit` says so. Absent, the unit is unknown and mpp stays null —
  // the contract's rule for the scale bar: no bar beats a bar that looks like a
  // measurement and is not one.
  const perUnit = dataset.micronsPerUnit;
  const mppX = perUnit != null ? meta.voxelSize[0] * perUnit : null;
  const mppY = perUnit != null ? meta.voxelSize[1] * perUnit : null;

  return {
    urls,
    info: {
      // A scalar field: one band, no colour of its own — which is also what puts
      // the scalar modes (Heatmap / Contour / Surface / Volume) legitimately on
      // offer for a dataset that has no camera image anywhere in it.
      isGrayscale: true,
      trueImageSize: [width, height],
      urls,
      isStack: depth > 1,
      showStack: false,
      scaleRatio: true,
      // Stable per dataset: the slice-blob cache keys off the file name, so a name
      // that changed per load would re-fetch a volume that never moved.
      fileName: `${dataset.name} · reference volume`,
      imageMeta: [
        { channelCount: 1, rgbChannels: 1, x: width, y: height, z: depth, mppX, mppY },
      ],
      // Blob URLs are complete images: OSD must open them directly, not ask a tile
      // server for a pyramid that does not exist.
      tiled: false,
      // Open mid-volume. The first and last planes of an anatomical volume are
      // outside the specimen — opening on slice 0 shows an empty frame and reads
      // as a failed load.
      initialZIndex: depth > 1 ? depth >> 1 : undefined,
    },
  };
}

/**
 * The data→image affine a registered volume implies.
 *
 * Once the volume IS the image ({@link buildVolumeStackImage}), one slice is a
 * `width x height` pixel grid whose voxel `(i, j)` covers
 * `[i * voxelSize[0], (i + 1) * voxelSize[0])` of the observations' coordinate
 * space — the contract's rule that the volume's near corner sits at the
 * coordinate origin. So observations reach pixel space by dividing out the voxel
 * size, and nothing has to move.
 *
 * Shaped as a `SpatialImageRef` on purpose: the marker layer and the ROI
 * selection then take the SAME transform they take for a dataset that ships a
 * real `imageRef`, instead of each growing a volume special case.
 */
export function volumeImageRef(
  volume: SpatialVolumeMeta, micronsPerUnit?: number,
): SpatialImageRef {
  const [vx, vy] = volume.voxelSize;
  return {
    scale: [1 / vx, 1 / vy],
    translate: [0, 0],
    ...(micronsPerUnit != null ? { mppX: vx * micronsPerUnit, mppY: vy * micronsPerUnit } : {}),
  };
}

/** The voxel plane a coordinate falls in, clamped into the volume. */
export function sliceIndexOf(z: number, volume: SpatialVolumeMeta): number {
  const k = Math.floor(z / volume.voxelSize[2]);
  return Math.max(0, Math.min(volume.depth - 1, k));
}

/**
 * Indices of the observations that fall in one voxel plane of the volume.
 *
 * A 2D view of a 3D dataset shows ONE plane, so it must draw one plane's
 * observations: without this the whole depth of the specimen piles onto a single
 * section and reads as a solid smear rather than a section's cells. The plane is
 * a slab `voxelSize[2]` thick, which is exactly the sampling the volume itself
 * has — for serial sections registered into a common frame, one slab is one
 * section.
 *
 * Every observation is in the plane when the dataset carries no z: a genuinely
 * flat dataset over a volume has nothing to filter on.
 */
export function observationsInSlice(
  obs: SpatialObservations, volume: SpatialVolumeMeta, slice: number,
): Uint32Array {
  const z = obs.z;
  if (!z) return Uint32Array.from({ length: obs.count }, (_, i) => i);
  const out = new Uint32Array(obs.count);
  let n = 0;
  for (let i = 0; i < obs.count; i++) {
    if (sliceIndexOf(z[i], volume) === slice) out[n++] = i;
  }
  return out.subarray(0, n);
}
