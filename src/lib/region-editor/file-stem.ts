/**
 * A file name without its extension: `slide.ome.tif` → `slide.ome`. A name with
 * no extension — or only a leading dot, like `.hidden` — is returned whole, so
 * a derived name is never a bare `.geojson`. `fallback` stands in for a missing
 * name.
 */
export function fileStem(name: string | null | undefined, fallback: string): string {
  if (!name) return fallback;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.substring(0, dot) : name;
}
