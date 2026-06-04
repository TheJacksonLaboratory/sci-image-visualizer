import { ChangeDetectorRef, Component, AfterViewInit, EventEmitter, Inject, NgZone, OnDestroy, OnInit, Output, ViewChild } from '@angular/core';

import { Subject, Subscription } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { MenuItem, MessageService, TreeNode } from 'primeng/api';
import { ContextMenu } from 'primeng/contextmenu';
import { IImageInfo } from './contracts/image.contract';
import { ImageStatePort, IMAGE_STATE_PORT } from './contracts/ports/image-state.port';
import { Polygon } from './models/region';
import { RoutingVisualizerService } from './routing-visualizer.service';
import { VisualizerStore } from './visualizer-store.service';
import { PlotType, PlotTypeDescriptor } from './contracts/plot-type';
import { ViewerFeature } from './contracts/capabilities.contract';
import { IntensityProfile } from './contracts/visualizer.contract';
import { RegionToolMode } from './contracts/region-overlay.contract';

@Component({
  selector: 'visualization',
  templateUrl: './visualization.component.html',
  styleUrls: ['./visualization.component.scss'],
})
export class VisualizationComponent implements OnInit, AfterViewInit, OnDestroy {
  @Output()
  isStackEvent = new EventEmitter(false);
  @Output()
  isGrayscaleEvent = new EventEmitter(false);
  loadingMessage = 'Loading image...';
  zoom = false;
  fileName: string | undefined;
  private loadedFileName: string | undefined;
  imageInfo: IImageInfo | undefined;

  private unsub = new Subject<void>();
  private previewSubscription = new Subscription();

  public stackLoading = false;
  public imgLoading = false;
  public loadingPercentage = 0;
  // Non-null (0..100) while jit-service is copying the source file into the
  // local cache PVC on first click. When set, the loading overlay swaps the
  // spinner for a determinate progress bar with a "Caching image" message.
  public cacheProgress: number | null = null;
  // True between the small-tier render landing and the large-tier render
  // landing in the multi-tier rendering path. The template uses this to
  // overlay a translucent spinner on top of the blurry small-tier image so
  // the user doesn't mistake it for the final preview.
  public sharpening = false;
  private running = false;
  public zIndex = 0;
  public maxIndex = 0;

  @ViewChild('cm') contextMenu!: ContextMenu;
  contextMenuItems: MenuItem[] = [];

  activeDragMode: string | null = null;

  /** Wand sensitivity — higher = stricter (smaller selection). Matches QuPath default. */
  wandSensitivity = 2.0;
  /** Vertex eraser radius in image-pixel coordinates. */
  vertexEraserRadius = 20;

  colormapsOptions!: any;
  reversescale = false;
  selectedColormap!: any;
  stackOptions = [
    { name: 'Single image', val: 'false' },
    { name: 'Stack', val: 'true' },
  ];
  selectedStackOption: { name: string; val: string } | undefined = this.stackOptions[0];
  plotDivName = 'plot';
  plotType = PlotType.IMAGE;
  isHeatmap = true;
  activeSurface3dMode = 'turntable';

  /** Plot types the active backend advertises (3D gated by capability). */
  plotTypeOptions: PlotTypeDescriptor[] = [];
  selectedPlotType: PlotType = PlotType.IMAGE;

  /** Floating intensity-profile inset (LINE mode). */
  readonly intensityInsetDiv = 'intensity-inset-plot';
  profilePanelPos = { x: 20, y: 70 };
  private profilePanelDragging = false;
  private profilePanelStart = { mx: 0, my: 0, x: 0, y: 0 };

  /** Toolbar docking: docked across the top by default; dragging its handle
   *  detaches it into a floating, movable window (frees the top row for the
   *  visualization). */
  toolbarFloating = false;
  toolbarPos = { x: 8, y: 8 };
  private toolbarDragging = false;
  private toolbarStart = { mx: 0, my: 0, x: 0, y: 0 };
  private latestProfiles: IntensityProfile[] = [];
  /** Drives the intensity inset panel's visibility — true whenever any
   *  intensity-profile line exists (independent of the current plot type). */
  hasProfiles = false;
  private intensityProfileSub?: Subscription;
  private viewportChangeSub?: Subscription;
  private profileDragMoveListener?: (e: MouseEvent) => void;
  private profileDragUpListener?: () => void;
  private profileResizeListener?: () => void;

  /** LINE plot type shows the image + draggable line ROI + intensity inset. */
  get isProfileMode(): boolean {
    return this.selectedPlotType === PlotType.LINE;
  }

  /** True for the Image plot type, which renders as a natively pan/zoom-able
   *  raster — so the backend-agnostic zoom/pan toolbar tools are hidden. The
   *  component drives this off the plot type, not the active backend. */
  get isImageView(): boolean {
    return this.selectedPlotType === PlotType.IMAGE;
  }

  /** Isosurface band as a 0–255 slider position, mapped onto the volume's real
   *  intensity range by the renderer. Defaults to the full range. */
  isoRange: number[] = [0, 255];

  plotWidthSubscription?: Subscription;
  imageLoadingSubscription?: Subscription;
  imgLoadingMessageSubscription?: Subscription;
  isZoomSubscription?: Subscription;
  filenameSubscription?: Subscription;
  autoscaleSubscription?: Subscription;

  private plotContextMenuListener?: (e: MouseEvent) => void;
  private keydownListener?: (e: KeyboardEvent) => void;
  private wheelListener?: (e: WheelEvent) => void;

  private zScrubTimer?: any;

  constructor(
    @Inject(IMAGE_STATE_PORT) private state: ImageStatePort,
    public plotService: RoutingVisualizerService,
    public messageService: MessageService,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
    private session: VisualizerStore,
  ) {
    this.colormapsOptions = plotService.getColormapOptions();
    this.computePlotTypeOptions();
  }

  /**
   * Plot types offered in the selector for the current image:
   *  - 3D types hidden when the backend can't render a 3D scene
   *  - stack-only types (scatter3d, isosurface) hidden unless the file is a
   *    stack — a volume needs multiple z-slices.
   *  - scalar-intensity types (contour, intensity profile, surface, isosurface)
   *    hidden for RGB images — they map a single intensity per pixel. Image,
   *    Heatmap and Scatter remain available for any image.
   */
  private computePlotTypeOptions() {
    const caps = this.plotService.capabilities;
    const isStack = !!this.imageInfo?.isStack;
    const isGrayscale = !!this.imageInfo?.isGrayscale;
    this.plotTypeOptions = this.plotService.getPlotTypeDescriptors().filter((d) => {
      if (d.dimensions === '3d' && !caps.has(ViewerFeature.Surface3D)) return false;
      if (d.requiresStack && !isStack) return false;
      if (d.requiresGrayscale && !isGrayscale) return false;
      return true;
    });
  }

  ngOnInit(): void {
    this.state.setDiagram(this);
    this.selectedColormap =
      this.colormapsOptions[0].children.find((c: any) => c.label === 'Greys Inv') ??
      this.colormapsOptions[0].children[0];
    this.stackOptions = [
      { name: 'Single image', val: 'false' },
      { name: 'Stack', val: 'true' },
    ];
    this.selectedStackOption = this.stackOptions[0];
    this.autoscaleSubscription = this.plotService.getAutoscaleEvent().subscribe(() => {
      // reset the image mode to single image
      this.selectedStackOption = { name: 'Single image', val: 'false' };
      this.activeDragMode = null;
      this.session.setActiveTool(null);
    });
    this.imageLoadingSubscription = this.state.isImageLoading$().subscribe((isImageLoading) => {
      this.imgLoading = isImageLoading;
    });
    this.plotService.getStackLoadingProgress().subscribe((loadingProgress) => {
      this.loadingPercentage = loadingProgress;
    });
    this.plotService.isStackLoading().subscribe((stackLoading) => {
      this.stackLoading = stackLoading;
    });
    this.plotWidthSubscription = this.state.getPanelWidth$().subscribe(() => {
      this.plotService.relayout();
      // The intensity inset is a separate Plotly chart in a floating panel; reflow
      // it to its current size when the canvas resizes, else it keeps the stale
      // size and blanks out. Defer a tick so the panel layout has settled.
      if (this.hasProfiles) {
        setTimeout(() => this.renderIntensityInset(), 0);
      }
    });
    this.imgLoadingMessageSubscription = this.state.getImageLoadingMessage$().subscribe((message) => {
      this.loadingMessage = message;
    });
    this.state
      .getCacheProgress$()
      .pipe(takeUntil(this.unsub))
      .subscribe((progress) => {
        this.cacheProgress = progress;
      });
    this.isZoomSubscription = this.state.isZoom$().subscribe((zoom) => {
      this.zoom = zoom;
    });
    this.filenameSubscription = this.state.getFilename$().subscribe((filename) => {
      if (filename) {
        this.fileName = filename;
      }
    });
    this.plotService.getColormap().subscribe((colormap) => {
      this.selectedColormap = colormap;
    });
    this.plotService.getReverseScale().subscribe((reversescale) => {
      this.reversescale = reversescale;
    });
    this.intensityProfileSub = this.plotService.getIntensityProfile$().subscribe((profiles) => {
      this.latestProfiles = profiles;
      this.hasProfiles = profiles.length > 0;
      // The panel div is behind *ngIf="hasProfiles". A bare setTimeout(0) fires
      // BEFORE Angular materializes the *ngIf (change detection runs after the
      // timeout callback), so on the first profile the renderer drew into a div
      // that didn't exist yet — the inset only appeared on the second click.
      // Run change detection synchronously so the div exists, then render.
      this.cdr.detectChanges();
      this.renderIntensityInset();
    });
    // When the OSD view settles at a new zoom/pan, re-sample the intensity lines
    // from a crop of the visible region so the inset reflects the zoom-level
    // resolution (Plotly's own high-def zoom updates the sampling cache inline).
    this.viewportChangeSub = this.plotService.getViewportChange$().subscribe((roi) => {
      if (this.hasProfiles && this.isImageView) {
        this.plotService.refreshIntensitySamplingForRoi(roi.x, roi.y, roi.width, roi.height, this.zIndex);
      }
    });
    this.previewSubscription = this.state.getImageInfo$().subscribe({
      next: (imgInfo) => {
        if (imgInfo) {
          this.imageInfo = imgInfo;
          // Stack-only plot types (isosurface, scatter3d) depend on whether this
          // file is a stack — recompute the selector options.
          this.computePlotTypeOptions();
          // If the active plot type isn't valid for this image (e.g. a scalar
          // type like Contour carried over to an RGB image), fall back to Image.
          if (!this.plotTypeOptions.some((d) => d.type === this.selectedPlotType)) {
            this.selectedPlotType = PlotType.IMAGE;
            this.plotType = PlotType.IMAGE;
            this.isHeatmap = true;
            this.plotService.setPlotType(PlotType.IMAGE);
          }
          // reset stack options selection
          this.selectedStackOption = imgInfo.showStack ? this.stackOptions[1] : this.stackOptions[0];

          this.isGrayscaleEvent.emit(this.imageInfo.isGrayscale);
          this.isStackEvent.emit(this.imageInfo.isStack);
          // Reset to the default 2D Image view when a different image is
          // selected while a 3D type is active.
          if (!this.isHeatmap && imgInfo.fileName !== this.loadedFileName) {
            this.isHeatmap = true;
            this.plotType = PlotType.IMAGE;
            this.selectedPlotType = PlotType.IMAGE;
            this.plotService.setPlotType(this.plotType);
            this.activeSurface3dMode = 'turntable';
          }
          this.loadedFileName = imgInfo.fileName;
          this.plotService.setImageMeta(this.imageInfo.imageMeta);
          const urls = imgInfo.urls;
          if (!this.running) {
            // image size — measure the plot div directly so the toolbar height is excluded
            const plotDiv: HTMLElement | null = document.getElementById('plot');
            const screenHeight = plotDiv?.offsetHeight || 500;
            if (urls) {
              this.plotService.reset();
              this.stackLoading = imgInfo.isStack && imgInfo.showStack;
              // make sure the zindex is within bounds
              this.updateZIndex(urls);
              this.running = true;
              // set max index of stack
              // One URL per slice (0-indexed), so the last reachable index is
              // length-1 — earlier `length-2` dropped the final slice.
              this.maxIndex = urls.length > 1 ? urls.length - 1 : 0;
              // Multi-tier rendering. When the file has small-tier URLs, we
              // render the small tier first so the user gets a fast blurry
              // preview, release the loading overlay, then sharpen by
              // re-rendering with the canonical large-tier URLs in the
              // background. Without small URLs we keep the original single-
              // pass behavior.
              // Multi-tier (blurry small → sharp large) is a 2D-image preview
              // optimisation. 3D plot types (surface, scatter3d, isosurface) load
              // the whole stack regardless, and the large pass updates in place via
              // Plotly.react — which doesn't rebuild a 3D gl-mesh isosurface, so the
              // sharpen step blanked the scene. Render those single-pass.
              const hasSmallTier =
                this.isHeatmap &&
                (imgInfo.smallUrls?.length ?? 0) === urls.length &&
                (imgInfo.smallUrls?.length ?? 0) > 0;
              const smallImgInfo = hasSmallTier ? { ...imgInfo, urls: imgInfo.smallUrls as string[] } : null;

              // inPlace=true updates the existing render instead of rebuilding
              // it, so the canvas doesn't blank during the small→large swap.
              // First (small) pass always builds fresh; large pass updates in
              // place on top of the small render.
              const renderPhase = (phaseInfo: typeof imgInfo, inPlace = false) =>
                this.plotService.load(phaseInfo, this.zIndex).then((loadedImage) => {
                  // check if the latest file selected is what has been loaded
                  // (guards against a newer click reaching us mid-render)
                  if (phaseInfo.fileName !== loadedImage.filename) return null;
                  return this.plotService.plot(
                    this.plotDivName,
                    loadedImage,
                    phaseInfo,
                    screenHeight,
                    this.plotType,
                    inPlace,
                  );
                });

              // Retry the large-tier render once after a brief delay before
              // giving up. The /api/preview request can hit a transient 503
              // or land in a lock-contention window where the response
              // arrives after the dev server proxy gives up. One retry costs
              // little and rescues the common case where the second attempt
              // sees fresh pre-gen-cached PNGs.
              const renderLargeWithRetry = () =>
                renderPhase(imgInfo, true).catch((err) => {
                  console.warn('Large-tier preview failed on first try, retrying in 1s', err);
                  return new Promise<void>((resolve) => setTimeout(resolve, 1000)).then(() =>
                    renderPhase(imgInfo, true),
                  );
                });

              const applyRoi = () => {
                if (imgInfo.roiJsonStr) {
                  const regions = this.plotService.importRegions(imgInfo.roiJsonStr);
                  this.plotService.setRegions(regions);
                  const shapes = regions.map((region) =>
                    region.getShape(this.plotService.getShowShapeLabel()),
                  );
                  this.plotService.setPreviousShapes(shapes);
                }
              };

              const finalize = (logTag: string) => {
                if (imgInfo.isStack && imgInfo.showStack) this.stackLoading = false;
                this.state.setImageLoading(false);
                this.running = false;
                applyRoi();
                console.log(logTag);
              };

              if (smallImgInfo) {
                let smallReleasedOverlay = false;
                renderPhase(smallImgInfo)
                  .then(
                    () => {
                      // Small tier is on screen — drop the full overlay so the
                      // user can see the blurry preview, but keep a translucent
                      // spinner on top of it (this.sharpening=true) so they don't
                      // mistake the low-res render for the final image.
                      if (imgInfo.isStack && imgInfo.showStack) this.stackLoading = false;
                      this.state.setImageLoading(false);
                      this.sharpening = true;
                      smallReleasedOverlay = true;
                      console.log('multi-tier: small tier rendered, starting large');
                    },
                    (err) => {
                      // Small-tier render failed (older backend without tier
                      // support, transient error, etc.). Log and continue with
                      // large only; the overlay stays up until large finishes.
                      console.warn('Small-tier preview failed, falling back to large', err);
                    },
                  )
                  .then(() => renderLargeWithRetry())
                  .then(
                    () => {
                      this.sharpening = false;
                      if (smallReleasedOverlay) {
                        // Overlay already gone; just clean up running state and ROI.
                        this.running = false;
                        applyRoi();
                        console.log('multi-tier: large tier rendered, sharpening complete');
                      } else {
                        finalize('finished plotting (large only after small fallback)');
                      }
                    },
                    (err) => {
                      // Both attempts of the large-tier render failed. The small
                      // tier is still on screen as a fallback. Surface a toast
                      // so the user knows the sharper version isn't coming —
                      // they can re-click to retry or move on.
                      this.sharpening = false;
                      console.error('Large-tier preview failed after retry', err);
                      const msg = err?.error?.message || err?.message || err?.statusText || String(err);
                      this.messageService.add({
                        key: 'center-toast',
                        severity: 'warn',
                        summary: 'Preview not sharpened',
                        detail: `The full-resolution preview did not load (${msg}). The low-resolution preview is still shown. Try clicking the image again.`,
                      });
                      // Don't call finalize() — overlay was already dismissed by
                      // the small-tier render; we just need to release running
                      // state so the next click can proceed.
                      this.running = false;
                      applyRoi();
                    },
                  );
              } else {
                renderPhase(imgInfo).then(
                  () => finalize('finished plotting'),
                  (err) => {
                    console.error('Preview failed', err);
                    finalize('plotting aborted');
                  },
                );
              }
            }
          }
        }
      },
      error: (err) => {
        const msg = err?.error?.message || err?.message || err?.statusText || String(err);
        console.error('Error occured when getting image info', err);
        this.messageService.add({
          key: 'center-toast',
          sticky: true,
          severity: 'error',
          summary: 'An error occured',
          detail: `The following error occured while getting image info: ${msg}.
                   Please try to open the image again through the file navigator.`,
        });
        this.stackLoading = false;
        this.state.setImageLoading(false);
        this.running = false;
        this.plotService.reset();
      },
    });
  }

  ngAfterViewInit() {
    this.plotContextMenuListener = (event: MouseEvent) => {
      const plotEl = document.getElementById('plot');
      if (!plotEl?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.ngZone.run(() => {
        this.contextMenuItems = this.buildContextMenuItems();
        this.cdr.detectChanges();
        this.contextMenu.show(event);
      });
    };
    window.addEventListener('contextmenu', this.plotContextMenuListener, true);

    this.keydownListener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (event.key === 'Delete' || event.key === 'Backspace' || event.key === 'd' || event.key === 'D') {
        this.ngZone.run(() => this.deleteRegion());
      } else if (event.key === '+' || event.key === '=') {
        this.ngZone.run(() => this.zoomIn());
      } else if (event.key === '-' || event.key === '_') {
        this.ngZone.run(() => this.zoomOut());
      } else if (event.key === 'p') {
        this.ngZone.run(() => this.toggleDragMode('pan'));
      } else if (event.key === 'b') {
        this.ngZone.run(() => this.toggleDragMode('zoomToBox'));
      } else if (event.key === 'r') {
        this.ngZone.run(() => this.toggleDragMode('drawrect'));
      } else if (event.key === 'f') {
        this.ngZone.run(() => this.toggleDragMode('drawclosedpath'));
      } else if (event.key === 'w') {
        this.ngZone.run(() => this.toggleDragMode('wand'));
      } else if (event.key === 'e') {
        this.ngZone.run(() => this.toggleDragMode('eraseVertex'));
      } else if (event.key === 's') {
        this.ngZone.run(() => this.toggleDragMode('select'));
      } else if (event.key === 'l') {
        this.ngZone.run(() => this.toggleDragMode('drawopenpath'));
      }
    };
    window.addEventListener('keydown', this.keydownListener);

    this.wheelListener = (event: WheelEvent) => {
      const plotEl = document.getElementById('plot');
      if (!plotEl?.contains(event.target as Node)) return;
      // The Image view handles scroll-zoom natively (it respects the scroll
      // delta). Intercepting here would fire a fixed zoom step per wheel
      // event — far too sensitive — so let the renderer own it.
      if (this.isImageView) return;
      // 3D plot types (surface, scatter3d, isosurface) render in a Plotly scene
      // that orbits/zooms natively on scroll. The 2D step-zoom doesn't apply and
      // would throw (no xaxis on a scene), so let Plotly handle the wheel.
      if (!this.isHeatmap) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.deltaY < 0) {
        this.ngZone.run(() => this.zoomIn());
      } else if (event.deltaY > 0) {
        this.ngZone.run(() => this.zoomOut());
      }
    };
    window.addEventListener('wheel', this.wheelListener, { capture: true, passive: false });

    // Drag handling for the floating intensity-profile panel.
    this.profileDragMoveListener = (e: MouseEvent) => {
      if (this.profilePanelDragging) {
        this.ngZone.run(() => {
          this.profilePanelPos = {
            x: this.profilePanelStart.x + (e.clientX - this.profilePanelStart.mx),
            y: this.profilePanelStart.y + (e.clientY - this.profilePanelStart.my),
          };
        });
      } else if (this.toolbarDragging) {
        this.ngZone.run(() => {
          this.toolbarPos = {
            x: this.toolbarStart.x + (e.clientX - this.toolbarStart.mx),
            y: this.toolbarStart.y + (e.clientY - this.toolbarStart.my),
          };
        });
      }
    };
    this.profileDragUpListener = () => {
      this.profilePanelDragging = false;
      this.toolbarDragging = false;
    };
    window.addEventListener('mousemove', this.profileDragMoveListener);
    window.addEventListener('mouseup', this.profileDragUpListener);

    // On any window resize, reflow the intensity inset to its (fixed) panel size
    // on the next frame, once layout has settled. Without this the inset can be
    // left at a stale/zero size by a mid-reflow resize and stop showing.
    this.profileResizeListener = () => {
      if (!this.hasProfiles) return;
      requestAnimationFrame(() => this.renderIntensityInset());
    };
    window.addEventListener('resize', this.profileResizeListener);
  }

  onProfilePanelDragStart(e: MouseEvent) {
    this.profilePanelDragging = true;
    this.profilePanelStart = {
      mx: e.clientX,
      my: e.clientY,
      x: this.profilePanelPos.x,
      y: this.profilePanelPos.y,
    };
    e.preventDefault();
  }

  /** Grab the toolbar handle: detach it into a floating window (if still docked)
   *  and start dragging. */
  onToolbarDragStart(e: MouseEvent) {
    if (!this.toolbarFloating) {
      this.toolbarFloating = true;
      this.toolbarPos = { x: 8, y: 8 };
    }
    this.toolbarDragging = true;
    this.toolbarStart = {
      mx: e.clientX,
      my: e.clientY,
      x: this.toolbarPos.x,
      y: this.toolbarPos.y,
    };
    e.preventDefault();
  }

  /** Snap the floating toolbar back to its docked position across the top. */
  dockToolbar() {
    this.toolbarFloating = false;
  }

  /** Render the intensity inset chart from the latest profile data. The actual
   *  charting is owned by the visualizer service — the component just decides
   *  when (profile mode + a fresh profile). */
  private renderIntensityInset(): void {
    if (!this.hasProfiles) return;
    this.plotService.renderIntensityInset(this.intensityInsetDiv, this.latestProfiles);
  }

  /** Toolbar "Intensity" group: add another line ROI (next bright colour). */
  async addProfileLine(): Promise<void> {
    // Park the floating inset near the plot's top-right when the first line is
    // added (it's position:fixed, so use viewport coords from the plot rect).
    if (!this.hasProfiles) {
      const rect = document.getElementById('plot')?.getBoundingClientRect();
      this.profilePanelPos = rect
        ? { x: Math.max(10, rect.right - 300), y: rect.top + 10 }
        : { x: 20, y: 70 };
    }
    // Image (OSD) mode: Plotly never rendered, so it has no pixel cache / extent.
    // Load the current slice's frames for sampling + line placement first.
    if (this.isImageView && this.imageInfo) {
      await this.plotService.ensureIntensitySampling(this.imageInfo, this.zIndex);
    }
    const region = this.plotService.getIntensityControls()?.addProfileLine();
    // Auto-select the new line on the active backend (Plotly handles / OSD
    // highlight) so it's ready to move or delete immediately.
    if (region) {
      this.plotService.selectRegion(region);
      // OSD only draws a selected region's handles in an edit mode, so a line in
      // 'none' mode looks unselected. Switch to 'select' so the new line shows
      // its endpoint handles and can be dragged/deleted right away.
      if (this.isImageView && this.activeDragMode !== 'select') {
        this.toggleDragMode('select');
      }
    }
  }

  ngOnDestroy() {
    if (this.zScrubTimer) {
      clearTimeout(this.zScrubTimer);
      this.zScrubTimer = undefined;
    }
    if (this.plotContextMenuListener) {
      window.removeEventListener('contextmenu', this.plotContextMenuListener, true);
    }
    if (this.keydownListener) {
      window.removeEventListener('keydown', this.keydownListener);
    }
    if (this.wheelListener) {
      window.removeEventListener('wheel', this.wheelListener, true);
    }
    if (this.profileDragMoveListener) {
      window.removeEventListener('mousemove', this.profileDragMoveListener);
    }
    if (this.profileDragUpListener) {
      window.removeEventListener('mouseup', this.profileDragUpListener);
    }
    if (this.profileResizeListener) {
      window.removeEventListener('resize', this.profileResizeListener);
    }
    if (this.intensityProfileSub) {
      this.intensityProfileSub.unsubscribe();
    }
    if (this.viewportChangeSub) {
      this.viewportChangeSub.unsubscribe();
    }
    this.unsub.next();
    this.unsub.complete();
    if (this.previewSubscription) {
      this.previewSubscription.unsubscribe();
    }
    if (this.plotWidthSubscription) {
      this.plotWidthSubscription.unsubscribe();
    }
    if (this.imageLoadingSubscription) {
      this.imageLoadingSubscription.unsubscribe();
    }
    if (this.imgLoadingMessageSubscription) {
      this.imgLoadingMessageSubscription.unsubscribe();
    }
    if (this.isZoomSubscription) {
      this.isZoomSubscription.unsubscribe();
    }
    if (this.autoscaleSubscription) {
      this.autoscaleSubscription.unsubscribe();
    }
    if (this.filenameSubscription) {
      this.filenameSubscription.unsubscribe();
    }
    this.plotService.unsubscribe();
  }

  public hasRegions(): boolean {
    // Use the contract's framework-neutral region accessor, not the raw
    // Plotly-shaped getShapes() — the component only needs to know whether any
    // region exists, and must not depend on a backend's wire format.
    return this.plotService.getRegions().length > 0;
  }

  /**
   * This method is called in mainFacade.configRequest() - DO NOT DELETE
   */
  public getRegionPolygons(): Polygon[] {
    return this.plotService.getRegionPolygons();
  }

  /**
   * Select the color scale type: called by the color scale select button
   * @param event
   */
  toggleReverseScale() {
    this.reversescale = !this.reversescale;
    this.plotService.setReverseScale(this.reversescale);
  }

  /**
   * Select a color map: called by the color map dropdown button
   * @param colormapNode
   */
  selectColormap(colormapNode: TreeNode) {
    if (!colormapNode.children) {
      this.plotService.setColormap(colormapNode);
    }
  }

  /**
   * Called by the stack/single image dropdown button
   * @param showstack
   */
  selectStackOption(selectedStackOption: any) {
    const showstack = selectedStackOption.val === 'true';
    this.selectedStackOption = selectedStackOption;
    console.log('selected stack option' + JSON.stringify(this.selectedStackOption));
    this.stackLoading = showstack;
    this.state.setImageLoading(!showstack);
    // Stack mode is always a 2D heatmap — reset surface mode if active
    if (!this.isHeatmap) {
      this.isHeatmap = true;
      this.plotType = PlotType.HEATMAP;
      this.selectedPlotType = PlotType.HEATMAP;
      this.plotService.setPlotType(this.plotType);
    }
    this.plotService.setShowStack(showstack);
  }

  updateZIndex(urls?: string[]) {
    if (this.zIndex > this.maxIndex) {
      this.zIndex = this.maxIndex;
    }
    if (this.zIndex < 0) {
      this.zIndex = 0;
    }
    if (urls) {
      if (this.zIndex > urls?.length) {
        this.zIndex = 0;
        this.maxIndex = urls.length - 1;
      }
    }
    this.plotService.setZIndex(this.zIndex);
  }

  /**
   * Live z-slice scrub for the Image view: the renderer swaps the displayed
   * slice in place (no re-mount), so dragging the slider steps through the
   * stack the same way the heatmap frame slider does.
   */
  onZSlide(z: number | undefined) {
    if (z === undefined) return;
    if (this.zScrubTimer) {
      clearTimeout(this.zScrubTimer);
      this.zScrubTimer = undefined;
    }
    this.zIndex = z;
    this.plotService.setZIndex(z);
    // Keep the intensity inset in sync with the displayed slice (Image/OSD mode,
    // where the profile sampler is fed from the loaded preview frames).
    if (this.hasProfiles && this.isImageView && this.imageInfo) {
      this.plotService.ensureIntensitySampling(this.imageInfo, z);
    }
  }

  /**
   * Live (debounced) scrub while dragging the Image-view z-slider: update the
   * slice as the user drags, but coalesce rapid changes so we don't fire a
   * slice swap on every pixel. The final value also lands via onZSlide (onSlideEnd).
   */
  onZScrub(z: number | undefined) {
    if (z === undefined) return;
    this.zIndex = z;
    if (this.zScrubTimer) clearTimeout(this.zScrubTimer);
    this.zScrubTimer = setTimeout(() => {
      this.zScrubTimer = undefined;
      this.plotService.setZIndex(this.zIndex);
    }, 120);
  }

  reloadAndPlot() {
    this.state.setImageLoading(true);
    // Re-drive the render pipeline from the current image info (the source of
    // truth, with real urls/fileName). Don't use plotService.reloadAndPlot():
    // that rebuilds the info from the renderer's internal state, which can be
    // stale (e.g. after switching plot type Image -> Heatmap) and re-emit
    // empty/old urls, failing to hand the div over to the new renderer.
    if (this.imageInfo) {
      this.state.setImageInfo(this.imageInfo);
    } else {
      this.plotService.reloadAndPlot();
    }
  }
  cancelLoading() {
    this.stackLoading = false;
    this.imgLoading = false;
    this.state.setImageLoading(false);
    this.zIndex = 0;
    this.plotService.setZIndex(this.zIndex);
    this.running = false;
    this.plotService.setStackLoading(false);
  }

  downloadImage() {
    this.plotService.downloadImage();
  }

  autoscaleImage() {
    this.plotService.autoscale();
  }

  resetAxes() {
    this.plotService.resetAxes();
  }

  toggleDragMode(mode: string) {
    // Toggle off if the same mode is re-selected.
    this.activeDragMode = this.activeDragMode === mode ? null : mode;
    const active = this.activeDragMode;
    // Record the armed tool in the shared session store.
    this.session.setActiveTool(active);

    // Region draw/select run through the renderer's region overlay.
    this.plotService
      .getRegionOverlay()
      ?.setMode(this.isRegionMode(active) ? (active as RegionToolMode) : 'none');

    // Viewport drag modes (pan/box-zoom). Region modes own the drag mode via
    // the overlay, so don't also set one here.
    if (!this.isRegionMode(active)) {
      const viewportDrag = active === 'pan' || active === 'zoom';
      this.plotService.setDragMode(viewportDrag ? active : false);
    }

    // On-canvas tool overlays.
    this.plotService.setZoomToBoxMode(active === 'zoomToBox');
    this.plotService.setWandMode(active === 'wand', { sensitivity: this.wandSensitivity });
    this.plotService.setVertexEraserMode(active === 'eraseVertex');
    if (active === 'eraseVertex') {
      this.plotService.setVertexEraserRadius(this.vertexEraserRadius);
    }
  }

  /** Region draw/select/edit modes routed through the region overlay. The
   *  The vertex tools (drawpolygon/addpoint/deletepoint/move) are
   *  handled by the OpenSeadragon overlay; Plotly's overlay maps them to no-op. */
  private isRegionMode(mode: string | null): boolean {
    return (
      mode === 'drawrect' ||
      mode === 'drawclosedpath' ||
      mode === 'drawopenpath' ||
      mode === 'select' ||
      mode === 'drawpolygon' ||
      mode === 'addpoint' ||
      mode === 'deletepoint' ||
      mode === 'move'
    );
  }

  /** Live-update the isosurface as the range slider moves. The control is only
   *  available when the active backend renders isosurfaces (ISOSURFACE mode). */
  onIsoRangeChange(values: number[] | undefined) {
    if (!values || values.length < 2) return;
    this.isoRange = values;
    this.plotService.getIsosurfaceControls()?.setIsoRange(values[0], values[1]);
  }

  onWandSensitivityChange(value: number | undefined) {
    if (value === undefined || !Number.isFinite(value)) return;
    this.wandSensitivity = value;
    this.plotService.setWandOptions({ sensitivity: value });
  }

  onVertexEraserRadiusChange(value: number | undefined) {
    if (value === undefined || !Number.isFinite(value)) return;
    this.vertexEraserRadius = value;
    this.plotService.setVertexEraserRadius(value);
  }

  zoomIn() {
    this.plotService.zoomIn();
  }

  zoomOut() {
    this.plotService.zoomOut();
  }

  deleteRegion() {
    this.plotService.deleteActiveShape();
  }

  /** Convert the selected region to a smooth bezier curve. */
  toBezierRegion() {
    this.plotService.getRegionOverlay()?.setSelectedBezier(true);
  }

  /** Convert the selected region back to a straight-edged polygon. */
  toPolygonRegion() {
    this.plotService.getRegionOverlay()?.setSelectedBezier(false);
  }

  private buildContextMenuItems(): MenuItem[] {
    const active = this.activeDragMode;
    const activeClass = 'context-menu-active';
    const items: MenuItem[] = [];
    if (this.isHeatmap) {
      items.push(
        { label: 'Autoscale', icon: 'pi pi-window-maximize', command: () => this.autoscaleImage() },
        { separator: true },
        {
          label: 'Zoom selection',
          icon: 'pi pi-search',
          styleClass: active === 'zoom' ? activeClass : '',
          command: () => this.toggleDragMode('zoom'),
        },
        {
          label: 'Zoom to box',
          icon: 'zoom-box-off-icon',
          styleClass: active === 'zoomToBox' ? activeClass : '',
          command: () => this.toggleDragMode('zoomToBox'),
        },
      );
    }
    if (this.isHeatmap) {
      items.push({
        label: 'Pan',
        icon: 'pi pi-arrows-alt',
        styleClass: active === 'pan' ? activeClass : '',
        command: () => this.toggleDragMode('pan'),
      });
    } else {
      const s3d = this.activeSurface3dMode;
      items.push(
        {
          label: 'Zoom',
          icon: 'pi pi-search',
          styleClass: s3d === 'zoom' ? activeClass : '',
          command: () => this.toggleSurface3dMode('zoom'),
        },
        {
          label: 'Pan',
          icon: 'pi pi-arrows-alt',
          styleClass: s3d === 'pan' ? activeClass : '',
          command: () => this.toggleSurface3dMode('pan'),
        },
        {
          label: 'Orbital rotation',
          icon: 'pi pi-globe',
          styleClass: s3d === 'orbit' ? activeClass : '',
          command: () => this.toggleSurface3dMode('orbit'),
        },
        {
          label: 'Turntable rotation',
          icon: 'pi pi-sync',
          styleClass: s3d === 'turntable' ? activeClass : '',
          command: () => this.toggleSurface3dMode('turntable'),
        },
        { separator: true },
        { label: 'Reset camera', icon: 'pi pi-home', command: () => this.resetSurfaceCamera() },
      );
    }
    if (this.isHeatmap) {
      items.push(
        { label: 'Zoom in', icon: 'pi pi-search-plus', command: () => this.zoomIn() },
        { label: 'Zoom out', icon: 'pi pi-search-minus', command: () => this.zoomOut() },
        { separator: true },
        {
          label: 'Freeform region',
          icon: 'pi pi-pencil',
          styleClass: active === 'drawclosedpath' ? activeClass : '',
          command: () => this.toggleDragMode('drawclosedpath'),
        },
        {
          label: 'Polyline',
          icon: 'polyline-icon',
          styleClass: active === 'drawopenpath' ? activeClass : '',
          command: () => this.toggleDragMode('drawopenpath'),
        },
        {
          label: 'Rectangular region',
          icon: 'pi pi-stop',
          styleClass: active === 'drawrect' ? activeClass : '',
          command: () => this.toggleDragMode('drawrect'),
        },
        {
          label: 'Wand',
          icon: 'wand-icon',
          styleClass: active === 'wand' ? activeClass : '',
          command: () => this.toggleDragMode('wand'),
        },
        {
          label: 'Vertex eraser',
          icon: 'pi pi-eraser',
          styleClass: active === 'eraseVertex' ? activeClass : '',
          command: () => this.toggleDragMode('eraseVertex'),
        },
        {
          label: 'Select',
          icon: 'pi pi-arrow-up-right',
          styleClass: active === 'select' ? activeClass : '',
          command: () => this.toggleDragMode('select'),
        },
      );
      // Vertex editing runs on the OpenSeadragon overlay, which
      // backs the Image plot type. Hidden for other 2D types (Plotly), where
      // these modes are no-ops.
      if (this.selectedPlotType === PlotType.IMAGE) {
        items.push(
          {
            label: 'Polygon (click vertices)',
            icon: 'polygon-vertices-icon',
            styleClass: active === 'drawpolygon' ? activeClass : '',
            command: () => this.toggleDragMode('drawpolygon'),
          },
          {
            label: 'Add vertex',
            icon: 'vertex-add-icon',
            styleClass: active === 'addpoint' ? activeClass : '',
            command: () => this.toggleDragMode('addpoint'),
          },
          {
            label: 'Delete vertex',
            icon: 'vertex-delete-icon',
            styleClass: active === 'deletepoint' ? activeClass : '',
            command: () => this.toggleDragMode('deletepoint'),
          },
          {
            label: 'Move region',
            icon: 'region-move-icon',
            styleClass: active === 'move' ? activeClass : '',
            command: () => this.toggleDragMode('move'),
          },
          { label: 'Convert to Bézier', icon: 'to-bezier-icon', command: () => this.toBezierRegion() },
          { label: 'Convert to polygon', icon: 'to-polygon-icon', command: () => this.toPolygonRegion() },
        );
      }
      items.push({ label: 'Delete region', icon: 'pi pi-trash', command: () => this.deleteRegion() });
    }
    return items;
  }

  toggleSurface3dMode(mode: string) {
    this.activeSurface3dMode = mode;
    this.plotService.setSurfaceDragMode(mode);
  }

  resetSurfaceCamera() {
    this.plotService.resetSurfaceCamera();
  }

  /**
   * Switch the active plot type (heatmap, surface, contour, scatter, line,
   * scatter3d, isosurface). Keeps `isHeatmap` as the 2D-vs-3D flag the rest of
   * the toolbar/context-menu logic relies on, deactivates 2D-only tools when
   * moving to a 3D type, then re-plots.
   */
  onSelectPlotType(type: PlotType) {
    this.plotType = type;
    this.selectedPlotType = type;
    const descriptor = this.plotTypeOptions.find((d) => d.type === type);
    const is3d = descriptor?.dimensions === '3d';
    this.isHeatmap = !is3d;
    this.plotService.setPlotType(type);
    // Switching plot type cancels the active tool — not every type supports the
    // same tools (line/scatter charts and 3D scenes have no box zoom or region
    // drawing), so leaving a tool armed would misbehave on the new plot.
    this.deactivateActiveTool();
    if (is3d) {
      this.activeSurface3dMode = 'turntable';
    }
    if (descriptor?.requiresStack) {
      // Volume types (isosurface, scatter3d) need the whole z-stack loaded as a
      // 3D array, and they always render on Plotly. Drive the stack reload
      // directly through the image-info stream rather than the active renderer's
      // setShowStack: when OpenSeadragon owns the Image view its setShowStack is
      // a no-op, so the reload never fired and the loader spun forever. We arm
      // Plotly's stack-loading flag (keeps its frame-fetch loop alive) and
      // re-emit the image info with showStack on so the pipeline reloads on
      // Plotly regardless of which backend was on screen.
      this.selectedStackOption = this.stackOptions[1];
      this.stackLoading = true;
      this.plotService.setStackLoading(true);
      if (this.imageInfo) {
        this.imageInfo.showStack = true;
        this.state.setImageInfo(this.imageInfo);
      }
      return;
    }
    this.reloadAndPlot();
  }

  /** Deactivate whatever tool is armed and clear every tool mode. */
  private deactivateActiveTool() {
    this.activeDragMode = null;
    this.session.setActiveTool(null);
    this.plotService.getRegionOverlay()?.setMode('none');
    this.plotService.setDragMode(false);
    this.plotService.setZoomToBoxMode(false);
    this.plotService.setWandMode(false);
    this.plotService.setVertexEraserMode(false);
  }
}

