/**
 * Backend-neutral physical scale bar: the length math and the DOM, shared by the OpenSeadragon and
 * napari-js scale bars (which used to carry byte-identical copies). Each backend keeps only an
 * adapter that knows how to read "screen px per image px" from its viewer and when to redraw.
 * (Long-term home: a napari-js overlay; see the review's napari-js table.)
 */

/** The bar's target on-screen length; the drawn bar is within a factor of ~1.5 of it. */
export const SCALE_BAR_TARGET_PX = 120;

/** Snap to the nearest "nice" 1/2/5 × 10ⁿ value for scale-bar lengths (1.4 → 1, 1.6 → 2). */
export function niceLength(x: number): number {
  if (x <= 0) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / base;
  const nice = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return nice * base;
}

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

/** What a scale bar shows: its on-screen width and its label. */
export interface ScaleBarSpec {
  widthPx: number;
  label: string;
}

/**
 * The bar for a view showing `pxPerImagePx` screen px per image pixel of an image with `mppX`
 * µm per pixel: the nice length nearest `targetPx` on screen. Null (no bar) when either scale is
 * unknown or degenerate.
 */
export function scaleBarFor(
  pxPerImagePx: number,
  mppX: number,
  targetPx: number = SCALE_BAR_TARGET_PX,
): ScaleBarSpec | null {
  if (!(mppX > 0) || !(pxPerImagePx > 0)) return null;
  const umPerScreenPx = mppX / pxPerImagePx;
  const niceUm = niceLength(targetPx * umPerScreenPx);
  return { widthPx: Math.round(niceUm / umPerScreenPx), label: formatUm(niceUm) };
}

/** A scale bar's DOM, appended to its host (bottom-left, above the canvas). */
export interface ScaleBarElement {
  /** Show `spec`, or hide the bar for null. */
  render(spec: ScaleBarSpec | null): void;
  /** Remove the bar from its host. */
  destroy(): void;
}

/**
 * Build the scale bar's DOM (a label over a bracketed line) inside `host`, which must establish a
 * containing block for the absolutely-positioned bar. Starts hidden until the first render.
 */
export function createScaleBarElement(host: HTMLElement): ScaleBarElement {
  const bar = document.createElement('div');
  Object.assign(bar.style, {
    position: 'absolute',
    left: '12px',
    bottom: '12px',
    zIndex: '30',
    pointerEvents: 'none',
    color: '#fff',
    font: '11px sans-serif',
    textShadow: '0 0 3px #000',
    textAlign: 'center',
    userSelect: 'none',
    display: 'none',
  } as Partial<CSSStyleDeclaration>);
  const label = document.createElement('span');
  const line = document.createElement('div');
  Object.assign(line.style, {
    height: '4px',
    marginTop: '2px',
    background: 'rgba(255,255,255,0.9)',
    borderLeft: '1px solid #fff',
    borderRight: '1px solid #fff',
    boxShadow: '0 0 3px #000',
  } as Partial<CSSStyleDeclaration>);
  bar.appendChild(label);
  bar.appendChild(line);
  host.appendChild(bar);
  return {
    render(spec: ScaleBarSpec | null): void {
      if (!spec) {
        bar.style.display = 'none';
        return;
      }
      bar.style.display = '';
      line.style.width = `${spec.widthPx}px`;
      label.textContent = spec.label;
    },
    destroy(): void {
      bar.parentNode?.removeChild(bar);
    },
  };
}
