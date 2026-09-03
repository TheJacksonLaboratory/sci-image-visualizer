import { SpatialDataset, SpatialObservations } from '../../contracts/spatial-dataset.contract';

/**
 * Turning a cell cloud into a density field — the honest way to render a cluster
 * in 3D when the sections it was measured on are hundreds of microns apart.
 *
 * Individual cells CANNOT be interpolated between sections: consecutive sections
 * sample entirely different cells, so there is no correspondence to interpolate
 * along, and inventing positions would fabricate observations indistinguishable
 * from measured ones. A density field is a different object: a continuous
 * estimate, legitimately defined between the planes that were imaged, and it
 * renders as a translucent cloud rather than as dots, so it reads as an estimate.
 *
 * Two things make the estimate honest rather than decorative, and both are
 * implemented here:
 *  - the kernel is **anisotropic**, with a z bandwidth at least the section
 *    spacing. An isotropic kernel leaves one disc per section — a sampling
 *    artefact that looks like biology;
 *  - the field is **coverage-normalised** along z (Nadaraya–Watson): unsampled
 *    planes would otherwise read as genuinely empty tissue rather than as tissue
 *    nobody imaged.
 */

/** The voxel lattice a density field is estimated on. */
export interface DensityGrid {
  width: number;
  height: number;
  depth: number;
  /** World size of one voxel per axis, in the observations' units. */
  voxelSize: [number, number, number];
}

export interface DensityOptions {
  /** Kernel σ per axis, in the observations' units. */
  sigma: [number, number, number];
  /** Observations to include. Every observation when absent. */
  indices?: Uint32Array;
}

/**
 * The lattice to estimate on.
 *
 * A dataset with a registered volume estimates on that volume's own box, so the
 * field lands exactly on the anatomy it will be drawn inside — `stride` coarsens
 * it (density is smooth by construction, and an eighth of the voxels is an eighth
 * of the work) while keeping the physical extent identical, so the two still
 * align. Without a volume the box comes from the observations' own bounds.
 */
export function densityGrid(
  dataset: SpatialDataset, stride = 2, targetLongAxis = 128, zStride = stride,
): DensityGrid | null {
  const volume = dataset.volume;
  if (volume) {
    const cells = (n: number, by: number) => Math.max(1, Math.ceil(n / by));
    // z can be coarsened less than x/y — a gene map's sheets need one plane per
    // imaged section, while its in-plane detail is smooth by construction. The
    // physical extent is unchanged either way, so the box still aligns.
    const [w, h, d] = [
      cells(volume.width, stride), cells(volume.height, stride), cells(volume.depth, zStride),
    ];
    // Voxel size from the SPAN, not stride x original: `ceil` can add a fraction
    // of a voxel, and scaling the original size would push the far edge past the
    // reference volume's.
    return {
      width: w,
      height: h,
      depth: d,
      voxelSize: [
        (volume.width * volume.voxelSize[0]) / w,
        (volume.height * volume.voxelSize[1]) / h,
        (volume.depth * volume.voxelSize[2]) / d,
      ],
    };
  }

  const obs = dataset.observations;
  if (!obs.z || obs.count === 0) return null;
  // Measured from the coordinate ORIGIN, not from the cloud's own minimum: the box
  // then has its near corner at the origin exactly as a volume's does, which is
  // what lets a renderer centre either one with the same half-box offset. A cloud
  // sitting far from the origin just gets a coarser grid, not a wrong one.
  const extent = (v: Float32Array) => {
    let hi = 0;
    for (let i = 0; i < obs.count; i++) if (v[i] > hi) hi = v[i];
    return Math.max(hi, 1);
  };
  const [sx, sy, sz] = [extent(obs.x), extent(obs.y), extent(obs.z)];
  const voxel = Math.max(sx, sy, sz) / targetLongAxis;
  return {
    width: Math.max(1, Math.ceil(sx / voxel)),
    height: Math.max(1, Math.ceil(sy / voxel)),
    depth: Math.max(1, Math.ceil(sz / voxel)),
    voxelSize: [voxel, voxel, voxel],
  };
}

/**
 * In-place separable Gaussian along one axis of a w x h x d field.
 *
 * Exported because the gene-map volume estimates a different quantity on the same
 * lattice with the same kernel (see `spatial-expression.ts`): two copies of a
 * separable blur would be two chances to smooth the estimate and its normaliser
 * differently, which is the one thing a Nadaraya-Watson field cannot survive.
 */
export function blurVolumeAxis(
  field: Float32Array, w: number, h: number, d: number, axis: 0 | 1 | 2, sigmaVox: number,
): void {
  if (!(sigmaVox > 0.01)) return;
  const radius = Math.max(1, Math.ceil(sigmaVox * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigmaVox * sigmaVox));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const len = axis === 0 ? w : axis === 1 ? h : d;
  const stride = axis === 0 ? 1 : axis === 1 ? w : w * h;
  const lines = axis === 0 ? h * d : axis === 1 ? w * d : w * h;
  const line = new Float32Array(len);
  for (let l = 0; l < lines; l++) {
    // Offset of this line's first element: the two axes that are not being
    // blurred, laid back out in x-fastest order.
    let base: number;
    if (axis === 0) base = (l % h) * w + Math.floor(l / h) * w * h;
    else if (axis === 1) base = (l % w) + Math.floor(l / w) * w * h;
    else base = l;
    for (let i = 0; i < len; i++) line[i] = field[base + i * stride];
    for (let i = 0; i < len; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        // Clamp at the edges: zero-padding would darken the specimen's own
        // boundary, which is exactly where a cluster often sits.
        const j = Math.min(len - 1, Math.max(0, i + k));
        acc += line[j] * kernel[k + radius];
      }
      field[base + i * stride] = acc;
    }
  }
}

/**
 * Which z planes of the grid contain any observation at all — the sampled
 * support, taken from the WHOLE dataset rather than from the subset being
 * rasterised. A rare cluster is sparse because it is rare; the gaps between
 * sections are empty because nobody imaged there, and only the second is a
 * sampling artefact to correct for.
 */
function sampledPlanes(
  obs: SpatialObservations, grid: DensityGrid,
): { cover: Float32Array; first: number; last: number } {
  const cover = new Float32Array(grid.depth);
  const z = obs.z;
  if (!z) return { cover: cover.fill(1), first: 0, last: grid.depth - 1 };
  let first = grid.depth;
  let last = -1;
  for (let i = 0; i < obs.count; i++) {
    const k = Math.floor(z[i] / grid.voxelSize[2]);
    if (k < 0 || k >= grid.depth) continue;
    cover[k] = 1;
    if (k < first) first = k;
    if (k > last) last = k;
  }
  return { cover, first, last };
}

/** Blur a 1D profile with the same kernel `blurVolumeAxis` uses, so the correction and
 *  the field are smoothed identically. */
function blur1d(profile: Float32Array, sigmaVox: number): Float32Array {
  const out = profile.slice();
  blurVolumeAxis(out, 1, 1, out.length, 2, sigmaVox);
  return out;
}

/**
 * Rasterise observations into a uint8 density field on `grid`.
 *
 * Returned as uint8 scaled to its own maximum: a `VolumeLayer` renders 0..255, and
 * the absolute cell count per voxel is not the readable quantity anyway — where
 * the cluster is dense RELATIVE to itself is. Null when nothing lands on the grid,
 * so the caller draws no layer rather than an empty box.
 */
export function rasterizeDensity(
  obs: SpatialObservations, grid: DensityGrid, opts: DensityOptions,
): Uint8Array | null {
  const { width: w, height: h, depth: d, voxelSize } = grid;
  const field = new Float32Array(w * h * d);
  const idx = opts.indices;
  const n = idx ? idx.length : obs.count;
  const z = obs.z;
  let placed = 0;
  for (let k = 0; k < n; k++) {
    const i = idx ? idx[k] : k;
    const vx = Math.floor(obs.x[i] / voxelSize[0]);
    const vy = Math.floor(obs.y[i] / voxelSize[1]);
    const vz = z ? Math.floor(z[i] / voxelSize[2]) : 0;
    if (vx < 0 || vx >= w || vy < 0 || vy >= h || vz < 0 || vz >= d) continue;
    field[(vz * h + vy) * w + vx] += 1;
    placed++;
  }
  if (!placed) return null;

  const sigmaVox: [number, number, number] = [
    opts.sigma[0] / voxelSize[0], opts.sigma[1] / voxelSize[1], opts.sigma[2] / voxelSize[2],
  ];
  blurVolumeAxis(field, w, h, d, 0, sigmaVox[0]);
  blurVolumeAxis(field, w, h, d, 1, sigmaVox[1]);
  blurVolumeAxis(field, w, h, d, 2, sigmaVox[2]);

  // Coverage correction, per plane: the same kernel over the sampled support says
  // how much of each plane's neighbourhood was actually imaged.
  const { cover, first, last } = sampledPlanes(obs, grid);
  const smoothedCover = blur1d(cover, sigmaVox[2]);
  let max = 0;
  const plane = w * h;
  for (let k = 0; k < d; k++) {
    // OUTSIDE the sampled range there is nothing to interpolate between, only
    // one side to extrapolate from — so the field is zeroed rather than scaled.
    // The blur leaves a positive tail past the first and last imaged planes, and
    // keeping it would put estimated cells in front of the specimen's first
    // section and behind its last, which is exactly what "smoothed BETWEEN the
    // imaged sections" promises not to do.
    if (k < first || k > last) {
      field.fill(0, k * plane, (k + 1) * plane);
      continue;
    }
    // Inside it, the correction BRIDGES gaps. Capping the amplification at 2x
    // (coverage floored at 0.5) lifts a plane sitting between two imaged sections
    // — where a bandwidth spanning one gap leaves coverage around a half —
    // without inflating a trace of smoothing leakage into a signal.
    const scale = 1 / Math.max(smoothedCover[k], 0.5);
    for (let i = k * plane; i < (k + 1) * plane; i++) {
      const v = field[i] * scale;
      field[i] = v;
      if (v > max) max = v;
    }
  }
  if (!(max > 0)) return null;

  const out = new Uint8Array(field.length);
  for (let i = 0; i < field.length; i++) out[i] = Math.round((field[i] / max) * 255);
  return out;
}

/**
 * Default kernel for a grid: in-plane tight, along z at least the section
 * spacing.
 *
 * The z term is the load-bearing one — 1.5 voxels of a grid whose depth voxel IS
 * the section spacing puts σ just above one section gap, which is the smallest
 * bandwidth that can bridge one without leaving a disc per plane. `smoothing`
 * scales all three for the user control.
 */
export function defaultSigma(grid: DensityGrid, smoothing = 1): [number, number, number] {
  return [
    grid.voxelSize[0] * 1.5 * smoothing,
    grid.voxelSize[1] * 1.5 * smoothing,
    grid.voxelSize[2] * 1.5 * smoothing,
  ];
}
