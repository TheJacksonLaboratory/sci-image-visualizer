import { formatLength, scaleBarFor } from 'napari-js/overlays';

import { imageToElement } from './osd-coords';
import { OsdViewerLike } from './osd-viewer-like';

/**
 * A physical scale bar drawn over an OpenSeadragon viewer. The length maths (the nice 1/2/5 × 10ⁿ
 * length nearest the target, and its unit) are napari-js's `scaleBarFor` / `formatLength`, which
 * also size the napari backend's `ScaleBarOverlay`, so the two bars agree; the DOM is the same
 * label-over-a-bracketed-line. Recomputes on every pan/zoom from the image→screen scale and the
 * image's µm/pixel (`mppX`, from Bio-Formats). Hidden when the image has no physical pixel size.
 */
export class OsdScaleBar {
  private readonly bar: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private readonly line: HTMLDivElement;
  private readonly redrawHandler = () => this.update();

  constructor(
    private viewer: OsdViewerLike,
    private mppX: number,
  ) {
    [this.bar, this.label, this.line] = createScaleBarElement(this.viewer.canvas);
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
    // Through osd-coords (world item 0), which stays accurate while the world
    // holds several slices — the viewport's own image conversion does not.
    const a = imageToElement(this.viewer, 0, 0);
    const b = imageToElement(this.viewer, 1, 0);
    const spec = scaleBarFor(Math.abs(b.x - a.x), this.mppX);
    if (!spec) {
      this.bar.style.display = 'none';
      return;
    }
    this.bar.style.display = '';
    this.line.style.width = `${Math.round(spec.widthPx)}px`;
    this.label.textContent = formatLength(spec.length, 'µm');
  }

  destroy(): void {
    this.viewer.removeHandler('update-viewport', this.redrawHandler);
    this.viewer.removeHandler('animation', this.redrawHandler);
    this.viewer.removeHandler('resize', this.redrawHandler);
    this.bar.remove();
  }
}

/**
 * The bar's DOM (a label over a bracketed line, bottom-left, above the canvas), styled as
 * napari-js's `ScaleBarOverlay`, inside `host`, which must establish a containing block.
 * Starts hidden until the first update.
 */
function createScaleBarElement(host: HTMLElement): [HTMLDivElement, HTMLSpanElement, HTMLDivElement] {
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
  bar.append(label, line);
  host.appendChild(bar);
  return [bar, label, line];
}
