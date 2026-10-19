/**
 * Annotations opened by themselves, with no image under them: a label volume (`.nii`, `.nii.gz`,
 * `.nrrd`, with the ontology JSON chosen with it), an OME-Zarr store's label image, a folder of
 * per-slice GeoJSON (with its `regionset.json`), one GeoJSON (z-indexed by `geometry.plane.z` or
 * not), or a `.zip` of any of these.
 *
 * {@link openAnnotations} builds the image they are shown on, which every view takes as it takes
 * any other (OpenSeadragon, napari, Plotly; a stack when there are several slices; the Volume and
 * Isosurface views and their 3D region surfaces): a label volume's slices in gray levels, its
 * regions filled over them in their classes' colours, else a blank stack the size of the regions.
 * The image carries the annotations as its own region sources, one per slice
 * ({@link IImageInfo.regionSlices}), traced or parsed the first time a slice is shown.
 * The host publishes it as it publishes any image, and disposes it when another replaces it.
 *
 * {@link readAnnotationSlices} is the part the Region Editor's import shares: the sources, by slice.
 */
import { encode as encodePng } from 'fast-png';

import type { IImageInfo } from '../contracts/image.contract';
import type { RegionSource } from '../region-source/region-source';
import { openGeoJsonRegionSource } from '../region-source/worker-region-source';
import { ATLAS_STYLE, labelClasses, LabelClasses, labelSliceGeoJson } from './label-classes';
import { Gunzip, LabelVolume, readLabelVolume } from './label-volume';
import { hasZarrMetadata, LabelStack, readOmeZarrLabels } from './ome-zarr-labels';
import { folderSliceGeoJson, planRegionImport, RegionImportFile } from './region-import';
import { Inflate } from './zarr-codecs';
import { expandZips, InflateRaw } from './zip';

/** The longest side an image built for annotations may have: OpenSeadragon's non-tiled limit. */
export const ANNOTATION_IMAGE_MAX_DIM = 8192;

/** Opens a slice's region source (again, after the store closed it). */
type Opener = () => Promise<RegionSource>;

/** Decoders, injectable for tests and workers (defaults: the platform's streams). */
export interface AnnotationDecoders {
  inflateRaw?: InflateRaw;
  inflate?: Inflate;
  gunzip?: Gunzip;
  /** Open a GeoJSON text as a region source (default: in the shared region worker). */
  openGeoJson?: (text: string) => Promise<RegionSource>;
  /**
   * Give a label image's regions the atlas look (dark outlines, labels) when its ontology names
   * no style: drawn over the label image itself, outlines in their classes' own colours would not
   * show. (Imported over a real image, the default look reads.)
   */
  outlineLabels?: boolean;
}

/** The annotations among some files, as one region source per slice. */
export interface AnnotationSlices {
  kind: 'labels' | 'folder' | 'single';
  /** A name for what was opened (the label image's, the folder's, the file's). */
  name: string;
  slices: number;
  /** One opener per slice index. */
  openers: Map<number, Opener>;
  /** A label image's slices and classes (to draw them, see openAnnotations). */
  labels?: { stack: LabelStack; classes: LabelClasses };
  /** Slice width and height, when known without opening the sources (a label image's). */
  size?: [number, number];
  /** Voxel size x, y, z in micrometres, when the source says. */
  spacing?: [number, number, number];
  /** What was read, for a message ("12 slices of 456 × 320"). */
  summary: string;
}

/**
 * The annotations among `files` (zips expanded), as one region source per slice; null when there
 * are none to read. A label image's slices are traced, and a GeoJSON parsed, when the slice is
 * first shown.
 */
export async function readAnnotationSlices(
  chosen: readonly RegionImportFile[],
  decoders: AnnotationDecoders = {},
): Promise<AnnotationSlices | null> {
  const files = await expandZips(chosen, decoders.inflateRaw);
  const openGeoJson = decoders.openGeoJson ?? ((text: string) => openGeoJsonRegionSource(text));
  if (hasZarrMetadata(files)) {
    const zarr = await readOmeZarrLabels(files, decoders.inflate);
    if (!zarr) throw new Error('The zarr store has no label image (an OME-Zarr labels/ group).');
    return labelSlices('labels', zarr.name, zarr.stack, styled(zarr.classes, decoders), openGeoJson);
  }
  const plan = planRegionImport(files);
  if (!plan) return null;
  if (plan.kind === 'volume') {
    const volume = await readLabelVolume(plan.volume.name, await plan.volume.bytes(), decoders.gunzip);
    const classes = labelClasses(plan.ontology ? JSON.parse(await plan.ontology.text()) : undefined);
    return labelSlices('labels', stem(plan.volume.name), stackOf(volume), styled(classes, decoders), openGeoJson);
  }
  if (plan.kind === 'folder') {
    const regionSet = plan.regionSet ? JSON.parse(await plan.regionSet.text()) : null;
    const openers = new Map<number, Opener>();
    plan.slices.forEach((file, z) =>
      openers.set(z, async () => openGeoJson(await folderSliceGeoJson(file, regionSet))),
    );
    const folder = plan.slices[0].name.split('/').slice(-2, -1)[0] || 'regions';
    return {
      kind: 'folder',
      name: folder,
      slices: plan.slices.length,
      openers,
      summary: `${plan.slices.length} slice files`,
    };
  }
  const slices = splitByPlane(await plan.file.text());
  const openers = new Map<number, Opener>();
  slices.forEach((text, z) => openers.set(z, () => openGeoJson(text)));
  return {
    kind: 'single',
    name: stem(plan.file.name),
    slices: slices.length,
    openers,
    summary: slices.length > 1 ? `${slices.length} slices` : 'one plane',
  };
}

/** What {@link openAnnotations} built: the image to publish, and how to release it. */
export interface OpenedAnnotations {
  info: IImageInfo;
  summary: string;
  /** Revoke the image's blob URLs, and release the slices' sources the region store never took
   *  (once another image replaced it). */
  dispose(): void;
}

let opened = 0;

/**
 * The image `files`' annotations are shown on by themselves (see the module comment). Throws when
 * there are none, or when their regions span more than {@link ANNOTATION_IMAGE_MAX_DIM} pixels
 * (they are then imported onto the image they were drawn on).
 */
export async function openAnnotations(
  files: readonly RegionImportFile[],
  decoders: AnnotationDecoders = {},
): Promise<OpenedAnnotations> {
  const set = await readAnnotationSlices(files, { outlineLabels: true, ...decoders });
  if (!set) {
    throw new Error(
      'Choose a label volume (.nii, .nii.gz, .nrrd, with its ontology JSON), an OME-Zarr store, ' +
        'GeoJSON files or a folder of them, or a .zip of any of these.',
    );
  }
  let urls: string[] = [];
  let width: number;
  let height: number;
  let openers = set.openers;
  // Releases the sources measuring opened that the store has not taken (none for a label image).
  let release = () => undefined as void;
  try {
    if (set.labels && set.size) {
      [width, height] = set.size;
      checkSize(width, height);
      urls = await labelSliceUrls(set.labels.stack, set.labels.classes);
    } else {
      // Regions alone: a blank stack as large as they reach, measured on the sources (kept open
      // for their slices, so each is parsed once).
      const measured = await measure(set.openers);
      openers = measured.openers;
      release = measured.release;
      [width, height] = measured.size;
      checkSize(width, height);
      const png = encodePng({ width, height, data: new Uint8Array(width * height), channels: 1, depth: 8 });
      const blank = new Blob([png as BlobPart], { type: 'image/png' });
      urls = Array.from({ length: set.slices }, () => URL.createObjectURL(blank));
    }
  } catch (err) {
    urls.forEach((u) => URL.revokeObjectURL(u));
    release();
    throw err;
  }
  const [mx, my, mz] = set.spacing ?? [];
  const isStack = set.slices > 1;
  const info: IImageInfo = {
    isGrayscale: true,
    trueImageSize: [width, height],
    urls,
    isStack,
    showStack: false,
    scaleRatio: true,
    // Unique: the slice cache keys on the name, and two opened sets must not share slices.
    fileName: `${set.name} · annotations [${++opened}]`,
    imageMeta: [
      {
        channelCount: 1,
        rgbChannels: 1,
        x: width,
        y: height,
        z: set.slices,
        mppX: mx ?? null,
        mppY: my ?? null,
        ...(mz != null ? { mppZ: mz } : {}),
      },
    ],
    tiled: false,
    // Open mid-stack: an atlas's first and last sections are mostly empty.
    initialZIndex: isStack ? set.slices >> 1 : undefined,
    regionSlices: openers,
  } as IImageInfo;
  return {
    info,
    summary: `${set.summary}, ${width} × ${height}`,
    dispose: () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      release();
    },
  };
}

function labelSlices(
  kind: 'labels',
  name: string,
  stack: LabelStack,
  classes: LabelClasses,
  openGeoJson: (text: string) => Promise<RegionSource>,
): AnnotationSlices {
  const openers = new Map<number, Opener>();
  for (let z = 0; z < stack.slices; z++) {
    openers.set(z, async () => openGeoJson(labelSliceGeoJson(oneSlice(stack, await stack.labels(z)), 0, classes)));
  }
  return {
    kind,
    name,
    slices: stack.slices,
    openers,
    labels: { stack, classes },
    size: [stack.width, stack.height],
    ...(stack.spacing ? { spacing: stack.spacing } : {}),
    summary: `${stack.slices} slice${stack.slices === 1 ? '' : 's'} of ${stack.width} × ${stack.height}`,
  };
}

/** `classes`, with the atlas look when asked for and they name no style of their own. */
function styled(classes: LabelClasses, decoders: AnnotationDecoders): LabelClasses {
  return decoders.outlineLabels && !classes.style ? { ...classes, style: ATLAS_STYLE } : classes;
}

/** A label volume as a stack read on demand. */
function stackOf(volume: LabelVolume): LabelStack {
  return {
    width: volume.width,
    height: volume.height,
    slices: volume.slices,
    ...(volume.spacing ? { spacing: volume.spacing } : {}),
    labels: async (z) => volume.sliceLabels(z),
  };
}

/** One slice's labels as the one-slice volume the tracer reads. */
function oneSlice(stack: LabelStack, labels: Uint32Array): LabelVolume {
  return { format: 'nrrd', width: stack.width, height: stack.height, slices: 1, sliceLabels: () => labels };
}

/**
 * Every slice as a grayscale PNG blob URL, each label at its class colour's luminance (never 0),
 * background black. Grayscale, not colour: the Volume and Isosurface views take a grayscale stack,
 * and the colour is the regions' own, filled over it in their classes' colours (the atlas look).
 */
async function labelSliceUrls(stack: LabelStack, classes: LabelClasses): Promise<string[]> {
  const levels = new Map<number, number>();
  const levelOf = (v: number) => {
    let l = levels.get(v);
    if (l === undefined) {
      const hex = classes.classOf(v).color;
      const [r, g, b] = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16));
      l = Math.max(1, Math.round(0.299 * r + 0.587 * g + 0.114 * b));
      levels.set(v, l);
    }
    return l;
  };
  const urls: string[] = [];
  const gray = new Uint8Array(stack.width * stack.height);
  for (let z = 0; z < stack.slices; z++) {
    const labels = await stack.labels(z);
    for (let i = 0; i < labels.length; i++) gray[i] = labels[i] ? levelOf(labels[i]) : 0;
    const png = encodePng({ width: stack.width, height: stack.height, data: gray, channels: 1, depth: 8 });
    urls.push(URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' })));
  }
  return urls;
}

/**
 * Open every slice's source to learn how far the regions reach (the image is as large, from the
 * origin, as region coordinates are image pixels). Each opener then hands its already-open source
 * over the first time (the region store owns it from then on) and opens anew after. `release`
 * disposes the sources not handed over yet; they are released here when measuring fails.
 */
async function measure(
  openers: Map<number, Opener>,
): Promise<{ openers: Map<number, Opener>; size: [number, number]; release: () => void }> {
  // Sources opened here and not yet handed to the store: theirs to release until then.
  const held = new Map<number, RegionSource>();
  const release = () => {
    for (const source of held.values()) source.dispose();
    held.clear();
  };
  let x1 = 0;
  let y1 = 0;
  try {
    for (const [z, open] of openers) {
      const source = await open();
      held.set(z, source);
      const bounds = source.info.bounds;
      if (bounds) {
        x1 = Math.max(x1, bounds[2]);
        y1 = Math.max(y1, bounds[3]);
      }
    }
    if (!(x1 > 0 && y1 > 0)) throw new Error('The regions have no extent to show.');
  } catch (err) {
    release();
    throw err;
  }
  const reused = new Map<number, Opener>();
  for (const [z, open] of openers) {
    reused.set(z, () => {
      const first = held.get(z);
      if (!first) return open();
      held.delete(z);
      return Promise.resolve(first);
    });
  }
  return { openers: reused, size: [Math.ceil(x1), Math.ceil(y1)], release };
}

function checkSize(width: number, height: number): void {
  if (Math.max(width, height) > ANNOTATION_IMAGE_MAX_DIM) {
    throw new Error(
      `The annotations span ${width} × ${height} pixels, more than ${ANNOTATION_IMAGE_MAX_DIM} on a side: ` +
        'open the image they were drawn on, and import them onto it from the Region Editor.',
    );
  }
}

/**
 * One GeoJSON's slices: a collection whose features name planes (`geometry.plane.z`) split into
 * one collection per plane, each keeping the set's class tree and style, its features moved to
 * plane 0 (a slice's source shows plane 0); any other GeoJSON is one slice as it is.
 */
export function splitByPlane(text: string): string[] {
  const doc = JSON.parse(text) as { type?: string; features?: Array<{ geometry?: { plane?: { z?: number } } }> };
  const features = doc.type === 'FeatureCollection' ? (doc.features ?? []) : [];
  const zOf = (f: (typeof features)[number]) => Math.max(0, Math.floor(f.geometry?.plane?.z ?? 0));
  const last = features.reduce((m, f) => Math.max(m, zOf(f)), 0);
  if (last === 0) return [text];
  const slices = Array.from({ length: last + 1 }, () => [] as unknown[]);
  for (const f of features) {
    const z = zOf(f);
    const geometry = f.geometry ? { ...f.geometry } : f.geometry;
    if (geometry) delete geometry.plane;
    slices[z].push({ ...f, geometry });
  }
  return slices.map((list) => JSON.stringify({ ...doc, features: list }));
}

function stem(name: string): string {
  return (name.split('/').pop() ?? name).replace(/\.(nii\.gz|nii|nrrd|geojson|json|zip)$/i, '');
}
