import { isLabelVolumeName } from './label-volume';

/** A file to import regions from: one the user chose, or one the host's server sent. */
export interface RegionImportFile {
  name: string;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

/** A file's contents as the host may hand them over (see `ServerRegionPick`). */
export type RegionImportData = Blob | ArrayBuffer | Uint8Array | string;

/** `data`, named `name`, as an import file. A `File`'s own name is used when `name` is omitted. */
export function importFile(data: RegionImportData, name = (data as File).name ?? ''): RegionImportFile {
  const encoder = new TextEncoder();
  return {
    name,
    text: async () =>
      typeof data === 'string'
        ? data
        : data instanceof Blob
          ? data.text()
          : new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data)),
    bytes: async () =>
      typeof data === 'string'
        ? encoder.encode(data)
        : data instanceof Blob
          ? new Uint8Array(await data.arrayBuffer())
          : data instanceof Uint8Array
            ? data
            : new Uint8Array(data),
  };
}

/** What a set of chosen files imports as. */
export type RegionImportPlan =
  /** A label volume, its classes named by an ontology (or a region set description) beside it. */
  | { kind: 'volume'; volume: RegionImportFile; ontology: RegionImportFile | null }
  /** A folder of per-slice region files, in slice order, with the set's `regionset.json`. */
  | { kind: 'folder'; slices: RegionImportFile[]; regionSet: RegionImportFile | null }
  /** One region file. */
  | { kind: 'single'; file: RegionImportFile };

const leaf = (name: string) => name.split(/[\\/]/).pop() ?? name;
const isRegionSet = (f: RegionImportFile) => leaf(f.name).toLowerCase() === 'regionset.json';
const isGeoJson = (f: RegionImportFile) => /\.geojson$/i.test(f.name);
const isJson = (f: RegionImportFile) => /\.json$/i.test(f.name);

/**
 * What `files` import as: a label volume (`.nii`, `.nii.gz`, `.nrrd`) with the ontology JSON chosen
 * with it (a `regionset.json`, else an Allen `structure_graph*.json`, else any `.json`); several
 * region files (a folder of per-slice `.geojson`, in natural name order, its `regionset.json`
 * apart); or one region file (`.geojson` or `.json`). Null when none of them is one.
 */
export function planRegionImport(files: readonly RegionImportFile[]): RegionImportPlan | null {
  const volume = files.find((f) => isLabelVolumeName(f.name));
  if (volume) {
    const jsons = files.filter((f) => f !== volume && isJson(f));
    const ontology =
      jsons.find(isRegionSet) ??
      jsons.find((f) => /structure_graph.*\.json$/i.test(leaf(f.name))) ??
      jsons[0] ??
      null;
    return { kind: 'volume', volume, ontology };
  }
  const regionSet = files.find(isRegionSet) ?? null;
  const geojsons = files.filter((f) => isGeoJson(f));
  const regionFiles = geojsons.length ? geojsons : files.filter((f) => isJson(f) && !isRegionSet(f));
  if (regionFiles.length > 1 || (regionFiles.length === 1 && regionSet)) {
    const slices = [...regionFiles].sort((a, b) => naturalCompare(leaf(a.name), leaf(b.name)));
    return { kind: 'folder', slices, regionSet };
  }
  return regionFiles.length === 1 ? { kind: 'single', file: regionFiles[0] } : null;
}

/** "slice_2" before "slice_10": runs of digits compared as numbers. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * A folder slice's GeoJSON with the set's class tree and style (its `regionset.json`) as the
 * collection's own members, unless the file has its own: what a served folder's slice carries.
 */
export async function folderSliceGeoJson(
  file: RegionImportFile,
  regionSet: { classHierarchy?: unknown; style?: unknown } | null,
): Promise<string> {
  const text = await file.text();
  if (!regionSet || (!regionSet.classHierarchy && !regionSet.style)) return text;
  const doc = JSON.parse(text) as Record<string, unknown>;
  if (doc['type'] !== 'FeatureCollection') return text;
  if (regionSet.classHierarchy && !doc['classHierarchy']) doc['classHierarchy'] = regionSet.classHierarchy;
  if (regionSet.style && !doc['style']) doc['style'] = regionSet.style;
  return JSON.stringify(doc);
}
