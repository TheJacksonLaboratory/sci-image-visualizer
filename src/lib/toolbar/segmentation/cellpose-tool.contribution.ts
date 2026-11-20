import { Inject, Injectable, Optional } from '@angular/core';

import { CELL_SEGMENTER, ICellSegmenter } from '../../contracts/cell-segmenter.contract';
import { TILE_ACCESS_PORT, TileAccessPort } from '../../contracts/ports/tile-access.port';
import type {
  ToolModelOption,
  ToolParamSpec,
  ToolbarToolContribution,
} from '../../contracts/toolbar-tool.contract';
import type { IVisualizer } from '../../contracts/visualizer.contract';
import { Rectangle } from '../../models/region';
import { CellSegmentToolService } from './cell-segment-tool.service';
import { currentMicronsPerPixel } from './view-at-scale';

/** The built-in Cellpose tool's id among the toolbar tools. */
export const CELLPOSE_TOOL_ID = 'cellpose';

/** The one checkpoint: the hosted cellpose-SAM. */
const CPSAM_MODEL: ToolModelOption = {
  id: 'cpsam',
  label: 'Cellpose-SAM',
  info:
    '<b>Cellpose-SAM</b> (CPSAM, fp16)<br>Generalist cell and nucleus segmentation, ~588&nbsp;MB, ' +
    'GPU-accelerated (WebGPU). Segments best with cells about 30&nbsp;px across: set the cell ' +
    'diameter in <i class="pi pi-sliders-h"></i> Parameters.',
};

const PARAMS: ToolParamSpec[] = [
  {
    id: 'cellDiameterUm',
    label: 'Cell diameter (µm)',
    type: 'number',
    min: 0,
    max: 1000,
    step: 1,
    fractionDigits: 1,
    tooltip:
      'Typical cell diameter. With the image pixel size it sets the resolution Cellpose segments at, ' +
      'whatever the zoom: cells are brought to about 30 px. 0 segments the pixels as displayed.',
  },
  {
    id: 'cellDiameterPx',
    label: 'Cell diameter (px)',
    type: 'number',
    min: 0,
    max: 2000,
    step: 1,
    tooltip:
      'Used when the image reports no pixel size: typical cell diameter in full-resolution pixels. ' +
      '0 segments the pixels as displayed.',
  },
];

/**
 * The library's own Cellpose tool, shown like a contributed tool: run, checkpoint
 * and parameters (sci-image-visualizer#97, #98).
 *
 * Run it with rectangles drawn and it segments inside each one, as before; with none
 * it segments the whole view. The cell diameter, in µm (with the image's pixel size)
 * or in pixels, sets the resolution it works at — the visualizer's zoom stays as the
 * user left it.
 */
@Injectable({ providedIn: 'root' })
export class CellposeToolContribution implements ToolbarToolContribution {
  readonly id = CELLPOSE_TOOL_ID;
  readonly label = 'Cellpose-SAM';
  readonly icon = { src: 'assets/plotting/cells.svg' };
  readonly runTooltip =
    'Segment cells (Cellpose-SAM) across the whole view, or inside each drawn rectangle if there are any. ' +
    'Runs at the resolution set by the cell diameter in Parameters; your zoom does not change.';
  readonly modelTooltip = 'About the Cellpose-SAM model';
  readonly paramsTooltip = 'Cellpose-SAM parameters (cell diameter)';
  /** After the SAM tools, before the contributed ones (100+). */
  readonly order = 50;
  readonly params = PARAMS;

  constructor(
    private readonly tool: CellSegmentToolService,
    @Inject(CELL_SEGMENTER) private readonly segmenter: ICellSegmenter,
    @Optional() @Inject(TILE_ACCESS_PORT) private readonly tileAccess: TileAccessPort | null = null,
  ) {}

  get progress() {
    return this.tool;
  }

  models(): ToolModelOption[] {
    return [CPSAM_MODEL];
  }

  defaultModelId(): string {
    return CPSAM_MODEL.id;
  }

  defaultParams(): Record<string, unknown> {
    // 10 µm: a typical nucleus. 30 px: cellpose-SAM's own scale, i.e. full resolution.
    return { cellDiameterUm: 10, cellDiameterPx: 30 };
  }

  run(viz: IVisualizer, params: Record<string, unknown>): Promise<number> {
    const diameterPx = cellDiameterPx(params, currentMicronsPerPixel(viz));
    const hasBoxes = (viz.getRegions() ?? []).some((r) => r.bounds instanceof Rectangle);
    if (hasBoxes) return viz.segmentRectanglesCellpose({ diameterPx });
    return this.tool.segmentView(viz, this.segmenter, { diameterPx, tileAccess: this.tileAccess });
  }
}

/**
 * The cell diameter in full-resolution image pixels: from µm when the image has a
 * pixel size (`mpp`, µm per pixel), else the pixel setting. Null means "as displayed".
 */
export function cellDiameterPx(params: Record<string, unknown>, mpp: number | null): number | null {
  const um = Number(params['cellDiameterUm'] ?? 0);
  const px = Number(params['cellDiameterPx'] ?? 0);
  const d = mpp && mpp > 0 ? um / mpp : px;
  return Number.isFinite(d) && d > 0 ? d : null;
}
