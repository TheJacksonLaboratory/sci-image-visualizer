import { Subscription, combineLatest } from 'rxjs';
import { colormapFromLut, reverseColormap, tintColormap } from 'napari-js';
import type { Colormap } from 'napari-js';

import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { buildColormapLut, Rgb } from '../../contracts/colormap-lut';
import { ColormapNode, SpatialViewState } from '../../contracts/display-types';
import { spatialContinuousLut } from '../../spatial/spatial-encoding';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { colormapId } from './napari-helpers';

/** The display settings every napari layer's colours are derived from. */
export interface DisplaySnapshot {
  /** The selected display colormap node (a name or inline stops in `data.value`), if any. */
  colormap: ColormapNode | null;
  reverse: boolean;
  invert: boolean;
}

/** The selected display colormap's value (a name or inline stops), if any. */
function colormapValue(s: DisplaySnapshot): unknown {
  return s.colormap?.data?.value;
}

/** The grayscale display colormap from the store selection (+reverse), defaulting to gray.
 *  Maps the store colormap node to a napari `Colormap` via the library's LUT factory; the
 *  multichannel tint ramps are built inside napari-js's `MultiChannelImageView` from each
 *  channel's hex colour. */
export function grayscaleColormap(s: DisplaySnapshot): Colormap | string {
  const value = colormapValue(s);
  const lut = value != null ? buildColormapLut(value, s.reverse) : null;
  if (lut) return colormapFromLut('gray-cmap', lut);
  return s.reverse
    ? colormapFromLut('gray-rev', [[255, 255, 255], [0, 0, 0]] as Rgb[])
    : 'gray';
}

/** A channel's tint colormap (black→colour) with reverse-scale / invert applied by flipping. */
export function channelTintColormap(color: string, s: DisplaySnapshot): Colormap | string {
  let cmap: Colormap | string = tintColormap(color);
  if (s.reverse) cmap = reverseColormap(cmap);
  if (s.invert) cmap = reverseColormap(cmap);
  return cmap;
}

/**
 * Colour map for the volume/isosurface (and the surface and 3D scatter). A real colormap
 * selection (viridis/magma/…) wins; otherwise the channel's colour tints it (so the channel-dialog
 * colour swatch recolors the 3D render). Reverse-scale and invert each flip the ramp — the
 * `VolumeLayer` has no per-layer invert, so both are emulated by reversing the colormap.
 */
export function volumeColormap(st: IChannelState | undefined, s: DisplaySnapshot): Colormap | string {
  const node = s.colormap;
  // A colored colormap (viridis/magma/…) drives the volume; the default grayscale family
  // (gray / Greys / Greys Inv) yields to the channel's colour so the dialog colour swatch
  // recolors the 3D render.
  const label = (node?.label ?? '').toLowerCase();
  const grayFamily = label === '' || label.includes('grey') || label.includes('gray');
  const value = node?.data?.value;
  const lut = !grayFamily && value != null ? buildColormapLut(value, false) : null;
  let cmap: Colormap | string = lut
    ? colormapFromLut('vol-cmap', lut)
    : tintColormap(st?.color ?? '#ffffff');
  // Reverse-scale and invert each flip the ramp (the VolumeLayer has no per-layer invert).
  if (s.reverse) cmap = reverseColormap(cmap);
  if (s.invert) cmap = reverseColormap(cmap);
  return cmap;
}

/** The LUT a continuous spatial layer draws with: the view's own choice, else the display
 *  colormap and its reverse flag — one rule for the markers, the cloud and both gene maps. */
export function spatialLut(view: SpatialViewState, s: DisplaySnapshot): Rgb[] {
  return spatialContinuousLut(colormapValue(s), s.reverse, view.continuousColormap);
}

/**
 * Identity of the colour scale a continuous spatial layer will draw with, for a
 * cache key: the explicit choice, or else the display colormap and its reverse
 * flag, since that is what {@link spatialLut} falls back to.
 *
 * The gene maps cache their coloured output, so without this in the key a change
 * of colour scale left the field on screen in the previous colours — the markers
 * recoloured and the map under them did not.
 */
export function continuousColormapKey(view: SpatialViewState, s: DisplaySnapshot): string {
  return [
    colormapId(view.continuousColormap),
    colormapId(colormapValue(s)),
    s.reverse ? 'rev' : '',
  ].join(':');
}

/**
 * The store's display state as the napari layers consume it (review Appendix B, step 3;
 * NAPARI-SVC-21): one subscription to channel states, colormap, reverse, invert and the selected
 * channel, a {@link DisplaySnapshot} of the last values seen, and the colormap/LUT derivations
 * every scene shares.
 *
 * The snapshot outlives a scene, as the scenes' builders read it before their own subscription
 * has emitted; each scene owns the subscription {@link watch} hands it.
 */
export class NapariDisplayState implements DisplaySnapshot {
  colormap: ColormapNode | null = null;
  reverse = false;
  invert = false;

  constructor(private readonly store: VisualizerStore) {}

  /**
   * Follow the store: record the colormap/reverse/invert the builders read, then hand `apply`
   * the channel states and the selected channel. Emits at once with the current values.
   */
  watch(apply: (channels: IChannelState[], selected: number) => void): Subscription {
    return combineLatest([
      this.store.getChannelStates(),
      this.store.getColormap(),
      this.store.getReverseScale(),
      this.store.getInvert(),
      this.store.getSelectedChannel(),
    ]).subscribe(([channels, colormap, reverse, invert, selected]) => {
      this.colormap = (colormap as ColormapNode) ?? null;
      this.reverse = reverse;
      this.invert = invert;
      apply(channels, selected);
    });
  }

  /** The spatial scenes' share: they follow the colormap and reverse flag (not invert) through
   *  their own subscription, because a gene map recolours with them. */
  record(colormap: ColormapNode | null, reverse: boolean): void {
    this.colormap = colormap;
    this.reverse = reverse;
  }

  grayscaleColormap(): Colormap | string {
    return grayscaleColormap(this);
  }
  channelTintColormap(color: string): Colormap | string {
    return channelTintColormap(color, this);
  }
  volumeColormap(st: IChannelState | undefined): Colormap | string {
    return volumeColormap(st, this);
  }
  spatialLut(view: SpatialViewState): Rgb[] {
    return spatialLut(view, this);
  }
  continuousColormapKey(view: SpatialViewState): string {
    return continuousColormapKey(view, this);
  }
}
