/** Where a bundle's all-gene transcript pyramid lives — shared by the builder and the server. */

/**
 * The pyramid's name for a bundle: its file or folder name without `.zip`, plus
 * `.transcripts` — `X_xe_outs.zip` → `X_xe_outs.transcripts`, `…/outs/` → `outs.transcripts`.
 * Kept next to the bundle, it is where jit-service and this server look for it.
 */
export function transcriptPyramidName(source) {
  const base = String(source).replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();
  return `${base.replace(/\.zip$/i, '')}.transcripts`;
}

/** Whether `source` is a local path (not an http(s)://, gs:// or s3:// URL). */
export function isLocalSource(source) {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(String(source));
}
