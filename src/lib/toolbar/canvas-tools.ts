import { WandService } from './wand/wand.service';
import { WandTool } from './wand/wand-tool.service';
import { BrushTool } from './brush/brush-tool.service';
import { VertexEraserTool } from './vertex-eraser/vertex-eraser-tool.service';
import { ZoomToBoxTool } from './zoom-to-box/zoom-to-box-tool.service';
import { SamPointToolService } from './segmentation/sam-point-tool.service';
import { CanvasToolHost } from './tool-kit/canvas-tool';
import { CanvasToolManager } from './tool-kit/canvas-tool-manager';
import { UndoGestureTarget } from './tool-kit/undo-gesture';

/** What a backend supplies to build its canvas tools — all from its own injector. */
export interface CanvasToolDeps {
  /** The (stateless) wand patch sampler. */
  wandService: WandService;
  /** The chain's region store: makes each wand/brush/eraser drag one undo step. */
  regionStore: UndoGestureTarget | null;
  /** The chain's SAM point feeds; the point tool reports through them. */
  samPoint: SamPointToolService;
}

/**
 * A backend's canvas-tool manager: fresh wand, brush, vertex eraser,
 * zoom-to-box and SAM point tools over `host`. Each backend calls this once, so
 * no tool instance — and no tool state — is shared between backends (RT-21).
 */
export function createCanvasToolManager(host: CanvasToolHost, deps: CanvasToolDeps): CanvasToolManager {
  return new CanvasToolManager(host, [
    new WandTool(deps.wandService, deps.regionStore),
    new BrushTool(deps.regionStore),
    new VertexEraserTool(deps.regionStore),
    new ZoomToBoxTool(),
    deps.samPoint.createTool(),
  ]);
}
