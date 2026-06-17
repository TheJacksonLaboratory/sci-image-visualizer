import { EMPTY } from 'rxjs';
import { TILE_ACCESS_PORT } from '../contracts/ports/tile-access.port';
import { IMAGE_STATE_PORT } from '../contracts/ports/image-state.port';
import { VIZ_CONFIG } from '../contracts/viz-config';

/**
 * No-op provider stubs for the visualization library's host ports, for unit
 * tests that instantiate library services (e.g. PlotlyService) without a real
 * host. Not part of the production build (tsconfig.app compiles only main.ts's
 * import graph).
 */
export const VIZ_PORT_STUBS = [
  {
    provide: TILE_ACCESS_PORT,
    useValue: {
      getSelectedInfoB64: () => null,
      zoomOnRegion: () => EMPTY,
      selectDiagramDisplay: () => {},
      getAuthHeaders: () => Promise.resolve({}),
    },
  },
  {
    provide: IMAGE_STATE_PORT,
    useValue: {
      getFilename$: () => EMPTY,
      isImageCached$: () => EMPTY,
      getImageInfo$: () => EMPTY,
      getImageLoadingMessage$: () => EMPTY,
      getCacheProgress$: () => EMPTY,
      getPanelWidth$: () => EMPTY,
      isImageLoading$: () => EMPTY,
      isZoom$: () => EMPTY,
      setImageInfo: () => {},
      setImageLoading: () => {},
      setImageLoadingMessage: () => {},
      setZoom: () => {},
      setImageCached: () => {},
      setLoadingError: () => {},
      setDiagram: () => {},
    },
  },
  { provide: VIZ_CONFIG, useValue: { slideCropServer: '' } },
];
