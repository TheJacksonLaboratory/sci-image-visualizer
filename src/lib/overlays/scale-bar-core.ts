/**
 * Length formatting for the napari 3D axis labels. The scale bars' maths (nice lengths, units)
 * are napari-js's `scaleBarFor` / `formatLength` (napari-js/overlays).
 */

/**
 * Format a length given in micrometres, picking the unit that suits its magnitude. The value is
 * always µm internally (jit-service normalises whatever unit Bio-Formats reports — nm/µm/mm/cm/inch
 * — to µm), so this adapts the displayed unit to the image's actual scale rather than assuming
 * microns.
 */
export function formatUm(um: number): string {
  const trim = (n: number): string => (n % 1 === 0 ? `${n}` : n.toFixed(1));
  if (um >= 1e6) return `${trim(um / 1e6)} m`;
  if (um >= 1e4) return `${trim(um / 1e4)} cm`;
  if (um >= 1e3) return `${trim(um / 1e3)} mm`;
  if (um >= 1) return `${trim(um)} µm`;
  return `${trim(um * 1000)} nm`;
}
