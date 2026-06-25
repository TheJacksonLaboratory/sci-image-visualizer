/**
 * Physical scale bar for the napari-js WebGPU image view (jit-ui#102), mirroring the OSD
 * backend's {@link OsdScaleBar}. napari keeps layers at pixel scale, so the camera's `zoom`
 * (CSS px per world unit) is exactly screen px per image pixel; combined with the image's
 * µm/pixel (`mppX`, from Bio-Formats `/tiles/info`) that gives a real-world bar length.
 * Recomputes on every camera change and host resize. Hidden when the image has no physical size.
 */

/** Round up to a "nice" 1/2/5 × 10ⁿ value for scale-bar lengths. */
function niceLength(x: number): number {
  if (x <= 0) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / base;
  const nice = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return nice * base;
}

/** Format a length given in micrometres, picking the unit that suits its magnitude (jit-service
 *  normalises whatever unit Bio-Formats reports to µm). */
function formatUm(um: number): string {
  const trim = (n: number): string => (n % 1 === 0 ? `${n}` : n.toFixed(1));
  if (um >= 1e6) return `${trim(um / 1e6)} m`;
  if (um >= 1e4) return `${trim(um / 1e4)} cm`;
  if (um >= 1e3) return `${trim(um / 1e3)} mm`;
  if (um >= 1) return `${trim(um)} µm`;
  return `${trim(um * 1000)} nm`;
}

/** The slice of the napari Camera the scale bar reads (zoom = CSS px per world/image pixel). */
interface ScaleBarCamera {
  readonly zoom: number;
  readonly changed: { connect(listener: () => void): () => void };
}

export class NapariScaleBar {
  private readonly bar: HTMLDivElement;
  private readonly line: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private readonly disconnectCamera: () => void;
  private readonly resizeObserver?: ResizeObserver;

  constructor(
    private readonly host: HTMLElement,
    private readonly camera: ScaleBarCamera,
    private readonly mppX: number,
  ) {
    // The bar is absolutely positioned within the host, so the host must establish a containing
    // block (the plot host is often statically positioned).
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    this.bar = document.createElement('div');
    Object.assign(this.bar.style, {
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
    } as Partial<CSSStyleDeclaration>);
    this.label = document.createElement('span');
    this.line = document.createElement('div');
    Object.assign(this.line.style, {
      height: '4px',
      marginTop: '2px',
      background: 'rgba(255,255,255,0.9)',
      borderLeft: '1px solid #fff',
      borderRight: '1px solid #fff',
      boxShadow: '0 0 3px #000',
    } as Partial<CSSStyleDeclaration>);
    this.bar.appendChild(this.label);
    this.bar.appendChild(this.line);
    this.host.appendChild(this.bar);

    this.disconnectCamera = this.camera.changed.connect(() => this.update());
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.update());
      this.resizeObserver.observe(this.host);
    }
    this.update();
  }

  private update(): void {
    const pxPerImagePx = this.camera.zoom; // CSS screen px per image pixel
    if (!(this.mppX > 0) || !(pxPerImagePx > 0)) {
      this.bar.style.display = 'none';
      return;
    }
    const umPerScreenPx = this.mppX / pxPerImagePx;
    const niceUm = niceLength(120 * umPerScreenPx); // target ~120px bar
    this.bar.style.display = '';
    this.line.style.width = `${Math.round(niceUm / umPerScreenPx)}px`;
    this.label.textContent = formatUm(niceUm);
  }

  destroy(): void {
    this.disconnectCamera();
    this.resizeObserver?.disconnect();
    if (this.bar.parentNode) this.bar.parentNode.removeChild(this.bar);
  }
}
