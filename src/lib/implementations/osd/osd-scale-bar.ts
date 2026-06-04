import * as OpenSeadragon from 'openseadragon';

/** Round up to a "nice" 1/2/5 × 10ⁿ value for scale-bar lengths. */
function niceLength(x: number): number {
  if (x <= 0) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / base;
  const nice = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return nice * base;
}

/**
 * Format a length given in micrometres, picking the unit that suits its
 * magnitude. The value is always µm internally (jit-service normalises whatever
 * unit Bio-Formats reports — nm/µm/mm/cm/inch — to µm), so this adapts the
 * displayed unit to the image's actual scale rather than assuming microns.
 */
function formatUm(um: number): string {
  const trim = (n: number) => (n % 1 === 0 ? `${n}` : n.toFixed(1));
  if (um >= 1e6) return `${trim(um / 1e6)} m`;
  if (um >= 1e4) return `${trim(um / 1e4)} cm`;
  if (um >= 1e3) return `${trim(um / 1e3)} mm`;
  if (um >= 1) return `${trim(um)} µm`;
  return `${trim(um * 1000)} nm`;
}

/**
 * A physical scale bar drawn over an OpenSeadragon viewer. Recomputes on every
 * pan/zoom from the viewport's image→screen scale and the image's µm/pixel
 * (`mppX`, from Bio-Formats). Hidden when the image has no physical pixel size.
 */
export class OsdScaleBar {
  private readonly osd: any = OpenSeadragon as any;
  private readonly bar: HTMLDivElement;
  private readonly line: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private readonly redrawHandler = () => this.update();

  constructor(private viewer: any, private mppX: number) {
    this.bar = document.createElement('div');
    Object.assign(this.bar.style, {
      position: 'absolute', left: '12px', bottom: '12px', zIndex: '30',
      pointerEvents: 'none', color: '#fff', font: '11px sans-serif',
      textShadow: '0 0 3px #000', textAlign: 'center', userSelect: 'none',
    } as CSSStyleDeclaration);
    this.label = document.createElement('span');
    this.line = document.createElement('div');
    Object.assign(this.line.style, {
      height: '4px', marginTop: '2px', background: 'rgba(255,255,255,0.9)',
      borderLeft: '1px solid #fff', borderRight: '1px solid #fff',
      boxShadow: '0 0 3px #000',
    } as CSSStyleDeclaration);
    this.bar.appendChild(this.label);
    this.bar.appendChild(this.line);
    this.viewer.canvas.appendChild(this.bar);

    this.viewer.addHandler('update-viewport', this.redrawHandler);
    this.viewer.addHandler('animation', this.redrawHandler);
    this.viewer.addHandler('resize', this.redrawHandler);
    this.update();
  }

  private update(): void {
    if (!(this.mppX > 0) || !this.viewer.viewport || this.viewer.world?.getItemCount() === 0) {
      this.bar.style.display = 'none';
      return;
    }
    const vp = this.viewer.viewport;
    const a = vp.imageToViewerElementCoordinates(new this.osd.Point(0, 0));
    const b = vp.imageToViewerElementCoordinates(new this.osd.Point(1, 0));
    const pxPerImagePx = Math.abs(b.x - a.x); // screen px per image px
    if (!(pxPerImagePx > 0)) { this.bar.style.display = 'none'; return; }

    const umPerScreenPx = this.mppX / pxPerImagePx;
    const niceUm = niceLength(120 * umPerScreenPx); // target ~120px bar
    this.bar.style.display = '';
    this.line.style.width = `${Math.round(niceUm / umPerScreenPx)}px`;
    this.label.textContent = formatUm(niceUm);
  }

  destroy(): void {
    this.viewer.removeHandler('update-viewport', this.redrawHandler);
    this.viewer.removeHandler('animation', this.redrawHandler);
    this.viewer.removeHandler('resize', this.redrawHandler);
    if (this.bar.parentNode) this.bar.parentNode.removeChild(this.bar);
  }
}
