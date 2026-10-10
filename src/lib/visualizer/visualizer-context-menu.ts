import { MenuItem } from 'primeng/api';

import { PlotType } from '../contracts/plot-type';
import { MultiPolygon, Polygon, Rectangle, Region } from '../models/region';

/** What the right-click menu is built from: the view, the armed modes and the regions. */
export interface ContextMenuState {
  /** 2D view (region tools, step zoom) vs a 3D scene (camera modes). */
  isHeatmap: boolean;
  /** The built-in type on screen; the Image view adds the vertex and Bézier items. */
  basePlotType: PlotType;
  activeDragMode: string | null;
  activeSurface3dMode: string;
  /** Every region on the image (intensity-profile lines included). */
  regions: Region[];
  /** The selection, as indices into {@link regions}. */
  selectedIndices: number[];
  /** Whether a region is a multi-part region that can be split back into parts. */
  canUngroup(region: Region): boolean;
}

/** What the menu's items do. */
export interface ContextMenuActions {
  autoscale(): void;
  zoomIn(): void;
  zoomOut(): void;
  toggleDragMode(mode: string): void;
  toggleSurface3dMode(mode: string): void;
  resetSurfaceCamera(): void;
  selectAllRegions(): void;
  mergeRegions(): void;
  ungroupRegions(): void;
  inverseRegions(): void;
  simplifyRegions(thresholdPx: number): void;
  openSimplifyDialog(): void;
  toBezierRegion(): void;
  toPolygonRegion(): void;
  deleteRegion(): void;
}

const ACTIVE = 'context-menu-active';

/** The live regions at `indices` (stale indices dropped). */
export function regionsAt(regions: Region[], indices: number[]): Region[] {
  return indices.map((i) => regions[i]).filter((r): r is Region => !!r);
}

/** Regions eligible for set-ops: closed areas (rect / closed polygon / multi-polygon),
 *  excluding intensity-profile lines. */
export function opEligible(regions: Region[]): Region[] {
  return regions.filter((r) => r.kind !== 'profile' && (
    r.bounds instanceof Rectangle ||
    r.bounds instanceof MultiPolygon ||
    (r.bounds instanceof Polygon && r.bounds.closed !== false)
  ));
}

/**
 * The right-click menu: the selected-region actions lead (2D only), then the
 * viewport and tool toggles for a 2D view, or the camera modes for a 3D scene. The
 * armed mode is highlighted.
 */
export function buildContextMenu(state: ContextMenuState, actions: ContextMenuActions): MenuItem[] {
  if (!state.isHeatmap) return surface3dItems(state, actions);
  const active = state.activeDragMode;
  const toggle = (label: string, icon: string, mode: string): MenuItem => ({
    label, icon, styleClass: active === mode ? ACTIVE : '', command: () => actions.toggleDragMode(mode),
  });
  const isImageView = state.basePlotType === PlotType.IMAGE;
  const items: MenuItem[] = [];
  const regionActions = buildRegionActionItems(state, actions);
  if (regionActions.length) items.push(...regionActions, { separator: true });
  items.push({ label: 'Autoscale', icon: 'pi pi-window-maximize', command: () => actions.autoscale() },
    { separator: true });
  // 'Zoom selection' is Plotly's rubber-band zoom; it doesn't apply to the
  // OpenSeadragon-backed Image view (use 'Zoom to box' there instead).
  if (!isImageView) items.push(toggle('Zoom selection', 'pi pi-search', 'zoom'));
  items.push(
    toggle('Zoom to box', 'zoom-box-off-icon', 'zoomToBox'),
    toggle('Pan', 'pi pi-arrows-alt', 'pan'),
    { label: 'Zoom in', icon: 'pi pi-search-plus', command: () => actions.zoomIn() },
    { label: 'Zoom out', icon: 'pi pi-search-minus', command: () => actions.zoomOut() },
    { separator: true },
    toggle('Select', 'pi pi-arrow-up-right', 'select'),
    toggle('Freeform', 'pi pi-pencil', 'drawclosedpath'),
    toggle('Brush', 'brush-icon', 'brush'),
    toggle('Polyline', 'polyline-icon', 'drawopenpath'),
    toggle('Rectangle', 'pi pi-stop', 'drawrect'),
    toggle('Wand', 'wand-icon', 'wand'),
    toggle('Vertex eraser', 'pi pi-eraser', 'eraseVertex'),
  );
  // Vertex editing runs on the OpenSeadragon overlay, which backs the Image plot
  // type. Hidden for other 2D types (Plotly), where these modes are no-ops.
  if (isImageView) {
    items.push(
      toggle('Polygon (click vertices)', 'polygon-vertices-icon', 'drawpolygon'),
      toggle('Add vertex', 'vertex-add-icon', 'addpoint'),
      toggle('Delete vertex', 'vertex-delete-icon', 'deletepoint'),
    );
  }
  return items;
}

/** A 3D scene's camera modes and reset. */
function surface3dItems(state: ContextMenuState, actions: ContextMenuActions): MenuItem[] {
  const mode = (label: string, icon: string, m: string): MenuItem => ({
    label, icon, styleClass: state.activeSurface3dMode === m ? ACTIVE : '',
    command: () => actions.toggleSurface3dMode(m),
  });
  return [
    mode('Zoom', 'pi pi-search', 'zoom'),
    mode('Pan', 'pi pi-arrows-alt', 'pan'),
    mode('Orbital rotation', 'pi pi-globe', 'orbit'),
    mode('Turntable rotation', 'pi pi-sync', 'turntable'),
    { separator: true },
    { label: 'Reset camera', icon: 'pi pi-home', command: () => actions.resetSurfaceCamera() },
  ];
}

/**
 * Immediate region actions on the current selection (jit-ui#85): merge, ungroup,
 * inverse, simplify, the Bézier conversions, and delete — the one-shot geometry
 * transforms, grouped apart from the tool/mode toggles and shown only when something
 * is selected. Each item is gated on what the selection supports. "Select all" leads
 * whenever the image has regions.
 */
export function buildRegionActionItems(state: ContextMenuState, actions: ContextMenuActions): MenuItem[] {
  if (!state.regions.some((r) => r.kind !== 'profile')) return [];
  const items: MenuItem[] = [
    { label: 'Select all regions', icon: 'pi pi-check-square', command: () => actions.selectAllRegions() },
  ];
  const selected = regionsAt(state.regions, state.selectedIndices);
  if (selected.length === 0) return items;
  const eligible = opEligible(selected);
  if (eligible.length >= 2) {
    items.push({ label: 'Merge / group', icon: 'pi pi-link', command: () => actions.mergeRegions() });
  }
  if (selected.some((r) => state.canUngroup(r))) {
    items.push({ label: 'Ungroup', icon: 'pi pi-sitemap', command: () => actions.ungroupRegions() });
  }
  if (eligible.length >= 1) {
    items.push(
      { label: 'Inverse', icon: 'pi pi-clone', command: () => actions.inverseRegions() },
      {
        label: 'Simplify', icon: 'pi pi-chart-line',
        items: [
          { label: 'Light (1 px)', command: () => actions.simplifyRegions(1) },
          { label: 'Medium (3 px)', command: () => actions.simplifyRegions(3) },
          { label: 'Strong (8 px)', command: () => actions.simplifyRegions(8) },
          { separator: true },
          { label: 'Custom…', command: () => actions.openSimplifyDialog() },
        ],
      },
    );
  }
  // Bézier conversions are vertex-level edits — Image (OpenSeadragon) view only —
  // gated on the selection's current form.
  if (state.basePlotType === PlotType.IMAGE) {
    if (selected.some((r) => (r.bounds instanceof Polygon && !r.bounds.bezier) || r.bounds instanceof Rectangle)) {
      items.push({ label: 'Convert to Bézier', icon: 'to-bezier-icon', command: () => actions.toBezierRegion() });
    }
    if (selected.some((r) => r.bounds instanceof Polygon && r.bounds.bezier)) {
      items.push({ label: 'Convert to polygon', icon: 'to-polygon-icon', command: () => actions.toPolygonRegion() });
    }
  }
  items.push({ label: 'Delete region', icon: 'pi pi-trash', command: () => actions.deleteRegion() });
  return items;
}
