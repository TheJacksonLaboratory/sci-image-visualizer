import type * as OpenSeadragon from 'openseadragon';

import { quiet } from './osd-lib';

/** The service state the chrome reads — live, so it follows a viewer rebuild. */
export interface OsdChromeHost {
  viewer(): OpenSeadragon.Viewer | null;
  /** The DOM id OSD is mounted in. */
  plotDiv(): string;
}

/**
 * The viewer chrome and its browser workarounds: the overview navigator
 * (visibility, sizing, corner pinning), image smoothing, the initial
 * fit-to-view as the host layout settles, and the docked-toolbar repaint nudge.
 *
 * `navigatorVisible` and `smoothingEnabled` are read when a viewer is created
 * (see buildViewerOptions) and applied live to a mounted one.
 */
export class OsdNavigatorChrome {
  /** Whether the overview navigator (minimap) is shown. A consumer that doesn't
   *  want it (e.g. a small embedded preview) sets it off before the first render. */
  navigatorVisible = true;
  /** Image smoothing (bilinear). `false` → nearest-neighbour, so zoomed-in pixels
   *  render as crisp blocks (pixel inspection). Defaults to `false` so the image
   *  opens showing raw pixels. */
  smoothingEnabled = false;
  /** The host's docked toolbar (see nudgeToolbarRepaint): undefined until looked
   *  up for the current mount, null when there is none. */
  private toolbarDock: HTMLElement | null | undefined = undefined;
  private lastToolbarNudge = 0;
  static readonly TOOLBAR_NUDGE_INTERVAL_MS = 100;

  constructor(private readonly host: OsdChromeHost) {}

  /** A new image is being mounted: the toolbar is looked up again for it. */
  onMount(): void {
    this.toolbarDock = undefined;
  }

  /**
   * Wire the chrome onto a freshly opened viewer: the toolbar nudges, the
   * fit-to-view retries as the layout settles, and the navigator re-sizing.
   */
  attach(viewer: OpenSeadragon.Viewer, plotDiv: string): void {
    // Chrome compositor bug: after an OSD zoom the docked toolbar (a sibling of
    // #plot in the <visualizer> host) is left laid-out-but-unpainted and
    // vanishes — confirmed via DevTools (DOM intact, region simply not painted).
    // CSS (z-index / isolation / contain) and DOM-reparenting don't fix it; a
    // repaint reliably does. Nudge it during the animation (throttled — each
    // nudge forces a layout) and on settle. The synchronous display toggle
    // re-rasters with no visible gone-frame and no layout shift.
    viewer.addHandler('animation', () => this.nudgeToolbarRepaint(true));
    viewer.addHandler('animation-finish', () => this.nudgeToolbarRepaint());
    // Force fit-to-view as the split/flex layout settles. A tall
    // non-pyramidal image can otherwise open zoomed-in (image width filling
    // the viewer), making OSD demand slow full-res res=0 tiles for the
    // centre instead of the fast coarse overview → white canvas. goHome
    // fits the whole image so OSD selects the coarse synthetic level. Retry
    // across a few frames because the container may not have its final size
    // on the first frame after 'open'.
    const refit = () => quiet(() => {
      this.host.viewer()?.viewport.goHome(true);
      // The navigator was sized in the Viewer constructor — BEFORE the
      // layout settled — so its element can carry a stale (even
      // wrong-aspect) size that floats the visible minimap above the
      // corner. Re-size it from the settled container.
      this.resizeNavigator();
    });
    requestAnimationFrame(refit);
    setTimeout(refit, 150);
    setTimeout(refit, 400);
    // The timed retries above miss the case where the container is STILL
    // zero-size at 400ms — which happens when the render starts while the
    // file viewer is mid-switch from the folder view to the diagram (e.g.
    // "Load as Stack" from a folder, with no image open first). Because
    // preserveViewport suppresses OSD's own open-time fit, the image would
    // then be left un-fitted at the top-left ("a tile"). A one-shot
    // ResizeObserver fits the instant the container first has a real size,
    // regardless of when the render began (jit-ui#106).
    this.fitWhenContainerSized(document.getElementById(plotDiv), refit);
    // Keep the navigator sized to the container as the panel resizes.
    viewer.addHandler('resize', () => this.resizeNavigator());
  }

  /** Show/hide the overview navigator. Stored for the next viewer creation, and
   *  applied live when a viewer is already mounted (hides/reveals its element —
   *  the navigator instance itself only exists when created with showNavigator). */
  setNavigatorVisible(visible: boolean): void {
    this.navigatorVisible = visible;
    const navEl: HTMLElement | undefined = this.host.viewer()?.navigator?.element;
    if (navEl) navEl.style.display = visible ? '' : 'none';
  }

  /** Toggle bilinear smoothing vs nearest-neighbour (crisp pixels). Stored for the
   *  next viewer creation, and applied live (with a redraw) to a mounted viewer. */
  setImageSmoothingEnabled(enabled: boolean): void {
    this.smoothingEnabled = enabled;
    const viewer = this.host.viewer();
    const drawer = viewer?.drawer;
    if (drawer?.setImageSmoothingEnabled) {
      drawer.setImageSmoothingEnabled(enabled);
      viewer?.forceRedraw();
    }
  }

  /**
   * Fit-to-home once `el` first has a non-zero size. If it's already sized we
   * rely on the timed refits the caller scheduled; otherwise a one-shot
   * ResizeObserver runs `refit` the moment the container is laid out (then
   * disconnects), so the initial fit doesn't depend on the render's start time
   * relative to the diagram container's layout. No-op without a container or
   * ResizeObserver (the timed refits remain the fallback). One-shot + only
   * attached on a fresh mount, so slice-scrub re-opens keep the user's zoom.
   */
  fitWhenContainerSized(el: HTMLElement | null, refit: () => void): void {
    if (!el || typeof ResizeObserver === 'undefined') return;
    if (el.clientWidth > 0 && el.clientHeight > 0) return; // already sized — timed refits suffice
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        ro.disconnect();
        refit();
      }
    });
    ro.observe(el);
    // Safety net: stop observing even if it never gains a size.
    setTimeout(() => ro.disconnect(), 5000);
  }

  /** Size the navigator from the CURRENT container (navigatorSizeRatio of the
   *  viewer element) and keep it pinned to the corner. OSD computes the size
   *  once in the Viewer constructor — before the host flex layout settles —
   *  and never corrects it, leaving a stale-size element whose visible minimap
   *  floats above the bottom-right corner. */
  resizeNavigator(): void {
    const v = this.host.viewer();
    const nav = v?.navigator;
    const el: HTMLElement | undefined = v?.element;
    if (!nav?.element || !el?.clientWidth || !el?.clientHeight) return;
    const w = Math.round(el.clientWidth * 0.16);
    const h = Math.round(el.clientHeight * 0.16);
    if (nav.element.style.width !== `${w}px` || nav.element.style.height !== `${h}px`) {
      quiet(() => {
        nav.setWidth(w);
        nav.setHeight(h);
      });
    }
    // Normalize OSD's control-corner stack so the minimap sits flush in the
    // corner, inset 12px to line up with the scale bar:
    //  - the inline-block wrapper carries line-box struts and can retain stale
    //    sizing → make it a tight block;
    //  - anything else OSD left in the corner would stack below the navigator
    //    and float it up → hide it;
    //  - inset the corner itself (bottom/right 12px), keeping the element in
    //    normal flow.
    const wrapper = nav.element.parentElement as HTMLElement | null;
    const corner = wrapper?.parentElement as HTMLElement | null;
    if (wrapper && corner) {
      wrapper.style.display = 'block';
      wrapper.style.lineHeight = '0';
      wrapper.style.fontSize = '0';
      // The wrapper keeps the navigator's stale pre-settle height as an
      // explicit size (the nav was 0.16x the UNSETTLED container at creation),
      // leaving an empty band under the resized minimap — measured live:
      // navH=87 inside wrapH=167. Force it to hug its content.
      wrapper.style.height = 'auto';
      wrapper.style.width = 'auto';
      for (const child of Array.from(corner.children) as HTMLElement[]) {
        if (child !== wrapper) child.style.display = 'none';
      }
      for (const child of Array.from(wrapper.children) as HTMLElement[]) {
        if (child !== nav.element) child.style.display = 'none';
      }
      corner.style.bottom = '12px';
      corner.style.right = '12px';
    }
    Object.assign(nav.element.style, { position: 'relative', top: '', left: '', bottom: '', right: '', margin: '0' });
  }

  /** Force the docked toolbar to repaint after an OSD zoom. Chrome leaves it
   *  laid-out-but-unpainted (the canvas's compositing churn strands the toolbar's
   *  raster). A synchronous display toggle re-rasters it with no visible gone-frame
   *  and no layout shift. Located via the DOM since the service doesn't own the
   *  toolbar; a no-op when there's no toolbar (e.g. embedded without one). The
   *  element is looked up once per mount. `throttled` (animation frames) nudges
   *  at most every {@link TOOLBAR_NUDGE_INTERVAL_MS}: each nudge forces a layout. */
  nudgeToolbarRepaint(throttled = false): void {
    if (throttled) {
      const now = performance.now();
      if (now - this.lastToolbarNudge < OsdNavigatorChrome.TOOLBAR_NUDGE_INTERVAL_MS) return;
      this.lastToolbarNudge = now;
    }
    if (this.toolbarDock === undefined || (this.toolbarDock && !this.toolbarDock.isConnected)) {
      const plotDiv = this.host.plotDiv();
      const plotEl = plotDiv ? document.getElementById(plotDiv) : null;
      this.toolbarDock = plotEl?.closest('visualization')?.querySelector<HTMLElement>('.toolbar-dock') ?? null;
    }
    const dock = this.toolbarDock;
    if (!dock) return;
    const prev = dock.style.display;
    dock.style.display = 'none';
    void dock.offsetHeight; // reflow so the toggle re-rasters on the next paint
    dock.style.display = prev;
  }
}
