import { Injectable } from '@angular/core';

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
    'diameter with <b>Set cell diameter…</b>.',
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
      'The typical diameter of the cells or nuclei to segment, in micrometres. Cellpose-SAM ' +
      'finds cells best when they are about 30 pixels across, so it uses this diameter and the ' +
      "image's pixel size to choose the resolution it reads the image at, whatever your zoom " +
      '(10 µm cells at 0.25 µm per pixel are 40 pixels, so they are scaled by 0.75). ' +
      'Too large a value merges small cells or misses them; too small a value splits cells. ' +
      'Used when the image reports its pixel size; otherwise Cell diameter (px) is used. ' +
      '0 segments the pixels as displayed.',
  },
  {
    id: 'cellDiameterPx',
    label: 'Cell diameter (px)',
    type: 'number',
    min: 0,
    max: 2000,
    step: 1,
    tooltip:
      'The typical diameter of the cells or nuclei, in full-resolution image pixels (measure ' +
      'one with a line at full zoom). Used instead of Cell diameter (µm) when the image ' +
      'does not report its pixel size. Cellpose-SAM scales the image so cells are about 30 ' +
      'pixels across. 0 segments the pixels as displayed.',
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
  readonly runTooltip = 'Segment cells with Cellpose-SAM in the displayed view, or in drawn rectangles';
  readonly modelTooltip = 'Set cell diameter';
  readonly paramsTooltip = 'Cellpose-SAM parameters (cell diameter)';
  /** The model menu is just this entry (one checkpoint): ▾ → Set cell diameter… */
  readonly paramsInModelMenu = 'Set cell diameter…';
  /** After the SAM tools, before the contributed ones (100+). */
  readonly order = 50;
  readonly params = PARAMS;

  constructor(private readonly tool: CellSegmentToolService) {}

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
    // Both go through the visualizer, which picks the backend regions are edited on — the
    // slice pane while the volume view is split — with its own pixels, slice and tiles.
    return hasBoxes ? viz.segmentRectanglesCellpose({ diameterPx }) : viz.segmentViewCellpose({ diameterPx });
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
