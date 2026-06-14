import { ChangeDetectorRef, Component, AfterViewInit, EventEmitter, HostListener, Inject, Input, NgZone, OnDestroy, OnInit, Output, ViewChild } from '@angular/core';

import { BehaviorSubject, Subject, Subscription } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { MenuItem, MessageService, TreeNode } from 'primeng/api';
import { ContextMenu } from 'primeng/contextmenu';
import { IImageInfo } from './contracts/image.contract';
import { ImageStatePort, IMAGE_STATE_PORT } from './contracts/ports/image-state.port';
import { Polygon } from './models/region';
import { VisualizerStore } from './store/visualizer-store.service';
import { RenderOrchestrator, SliceScrubber } from './render-orchestrator';
import { PlotType, PlotTypeDescriptor } from './contracts/plot-type';
import { ViewerFeature } from './contracts/capabilities.contract';
import { IntensityProfile, IVisualizer, VISUALIZER } from './contracts/visualizer.contract';
import { SAM_MODELS, getDefaultSamModelId, isSamModelReady } from './toolbar/segmentation/sam-model-registry';
import { SamToolService } from './toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from './toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from './toolbar/segmentation/cell-segment-tool.service';
import { RegionToolMode } from './contracts/region-overlay.contract';
import { ToolbarToolVisibility, ALL_TOOLBAR_TOOLS } from './contracts/toolbar-config';

/** Per-instance plot-div id source. The mount element's id must be unique so two
 *  live viewers (e.g. the main diagram + a modal preview) don't collide on the
 *  same DOM id — `getElementById` would otherwise return whichever came first.
 *  Styling hangs off the `.viz-plot` class instead of the id. */
let plotInstanceSeq = 0;

@Component({
  // Canonical prefixed selector first; the unprefixed original is kept as an
  // alias for one release (pre-publication back-compat).
  selector: 'jaxviz-visualization, visualization',
  templateUrl: './visualization.component.html',
  styleUrls: ['./visualization.component.scss'],
})
export class VisualizationComponent implements OnInit, AfterViewInit, OnDestroy {
  /** Per-instance toast key. MessageService is a global singleton, so two live
   *  `<visualization>` instances (main viewer + pipeline-dialog preview) sharing
   *  one key would each render the same message — a duplicate toast. A unique
   *  key per instance scopes the toast to the component that raised it. */
  private static nextToastId = 0;

  @Output()
  isStackEvent = new EventEmitter(false);
  @Output()
  isGrayscaleEvent = new EventEmitter(false);

  /** Which toolbar groups to show. A partial override merges over the full set,
   *  so `{ specialTools: false }` hides only that group. Defaults to everything. */
  @Input()
  set toolbarTools(v: ToolbarToolVisibility | undefined) {
    this._toolbarTools = { ...ALL_TOOLBAR_TOOLS, ...(v ?? {}) };
  }

  get toolbarTools(): Required<ToolbarToolVisibility> {
    return this._toolbarTools;
  }
  private _toolbarTools: Required<ToolbarToolVisibility> = ALL_TOOLBAR_TOOLS;

  /** Image-smoothing state for the toolbar's Smoothen toggle (OSD only).
   *  Defaults to `false` so OSD shows raw pixels (nearest-neighbour). */
  imageSmoothingEnabled = false;
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

  /** Whether a region action is available to undo (jit-ui#85). Mirrors the
   *  shared RegionStore's history depth; drives the toolbar Undo button. */
  canUndoRegion = false;
  /** Whether an undone region action is available to redo (jit-ui#85). */
  canRedoRegion = false;

  /** Wand sensitivity — higher = stricter (smaller selection). Matches QuPath default. */
  wandSensitivity = 2.0;
  /** Brush diameter in image-pixel coordinates (drives the painted disc size). */
  brushSize = 40;
  /** SAM model picker options + current selection (jit-ui#90 P1). Only models
   *  with a hosted ONNX pair (configured via setSamModelUrls at app init) are
   *  offered, so the picker can't select a model that can't run. */
  samModels = SAM_MODELS.filter(isSamModelReady).map((m) => ({ id: m.id, label: m.label }));
  samModelId = getDefaultSamModelId();
  /** SAM download/segment toast state (bound by the `sam` p-toast template). */
  samStatus = '';
  samProgress = 0; // 0..100, encoder download
  samDownloading = false;
  samBusy = false; // any SAM work in flight (drives the indeterminate spinner)
  /** Whether the shared `sam` toast is currently shown (avoids stacking it on
   *  every point click, which re-runs inference). */
  private samToastShown = false;

  readonly samToastKey = `sam-${VisualizationComponent.nextToastId++}`;
  /** Subscriptions to the point tool's live feeds (status/busy/download). */
  private samPointSub = new Subscription();
  /** Vertex eraser radius in image-pixel coordinates. */
  vertexEraserRadius = 20;

  colormapsOptions!: any;
  reversescale = false;
  selectedColormap!: any;
  /** Channels & Histogram dialog visibility (opened from the toolbar). */
  showChannelHistogram = false;
  stackOptions = [
    { name: 'Single image', val: 'false' },
    { name: 'Stack', val: 'true' },
  ];
  selectedStackOption: { name: string; val: string } | undefined = this.stackOptions[0];
  readonly plotDivName = `viz-plot-${plotInstanceSeq++}`;
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

  /** Debounced z-slice scrubbing (see SliceScrubber — refactoring plan Step 7). */
  private readonly scrubber = new SliceScrubber((z) => this.plotService.setZIndex(z));

  constructor(
    @Inject(IMAGE_STATE_PORT) private state: ImageStatePort,
    @Inject(VISUALIZER) public plotService: IVisualizer,
    public messageService: MessageService,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
    private session: VisualizerStore,
    private samTool: SamToolService,
    private cellSegmentTool: CellSegmentToolService,
    private samPointTool: SamPointToolService,
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
    // Undo availability (jit-ui#85): the shared RegionStore emits whenever its
    // history depth changes; greys out the toolbar Undo button accordingly.
    this.plotService
      .getCanUndo$()
      .pipe(takeUntil(this.unsub))
      .subscribe((canUndo) => {
        this.canUndoRegion = canUndo;
        this.cdr.detectChanges();
      });
    this.plotService
      .getCanRedo$()
      .pipe(takeUntil(this.unsub))
      .subscribe((canRedo) => {
        this.canRedoRegion = canRedo;
        this.cdr.detectChanges();
      });
    // Interactive point-prompt segmentation runs inside the renderer on each
    // click; surface its live status + download progress in the shared `sam`
    // toast so the user sees it working (the first click pulls the encoder).
    this.samPointSub.add(
      this.samPointTool.progress$.subscribe((f) => {
        this.samDownloading = f >= 0 && f < 1;
        if (f >= 0) this.samProgress = Math.min(100, Math.round(f * 100));
        this.cdr.detectChanges();
      }),
    );
    this.samPointSub.add(
      this.samPointTool.status$.subscribe((m) => {
        this.samStatus = m;
        this.cdr.detectChanges();
      }),
    );
    this.samPointSub.add(
      this.samPointTool.busy$.subscribe((busy) => {
        this.samBusy = busy;
        if (busy) this.showSamToast('SAM point segmentation');
        this.cdr.detectChanges();
      }),
    );
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
      // The panel div is behind *ngIf="hasProfiles". detectChanges() materializes
      // it synchronously (the subscription may fire outside Angular's zone — e.g.
      // from an OSD drag — so CD wouldn't run on its own). Then render on the next
      // animation frame, AFTER the browser lays the panel out: a synchronous draw
      // hits a zero-size container on first create and Plotly keeps that size, so
      // the inset stays blank and live updates redraw into the same zero box.
      this.cdr.detectChanges();
      requestAnimationFrame(() => this.renderIntensityInset());
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
            const plotDiv: HTMLElement | null = document.getElementById(this.plotDivName);
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
              // Multi-tier rendering (small blurry tier first, then sharpen in
              // place) — sequencing lives in RenderOrchestrator; this component
              // supplies the phase render and owns the UI flags via callbacks.
              // 3D plot types render single-pass: the in-place large pass doesn't
              // rebuild a 3D gl-mesh isosurface, so the sharpen step blanked it.
              const hasSmallTier =
                this.isHeatmap &&
                (imgInfo.smallUrls?.length ?? 0) === urls.length &&
                (imgInfo.smallUrls?.length ?? 0) > 0;
              const smallImgInfo = hasSmallTier ? { ...imgInfo, urls: imgInfo.smallUrls as string[] } : null;

              const applyRoi = () => {
                if (imgInfo.roiJsonStr) {
                  const regions = this.plotService.importRegions(imgInfo.roiJsonStr);
                  this.plotService.setRegions(regions);
                  const shapes = regions.map((region) =>
                    region.getShape(this.plotService.getShowShapeLabel()),
                  );
                  this.plotService.setPreviousShapes(shapes);
                }
                // Loading an image's saved ROIs is not a user edit — start the
                // undo history fresh so the first undo can't wipe them (jit-ui#85).
                this.plotService.resetUndoHistory();
              };
              const releaseOverlay = () => {
                if (imgInfo.isStack && imgInfo.showStack) this.stackLoading = false;
                this.state.setImageLoading(false);
              };

              new RenderOrchestrator({
                // inPlace=true updates the existing render instead of rebuilding
                // it, so the canvas doesn't blank during the small→large swap.
                renderPhase: (phaseInfo, inPlace) =>
                  this.plotService.load(phaseInfo, this.zIndex).then((loadedImage) => {
                    // Guard against a newer click reaching us mid-render.
                    if (phaseInfo.fileName !== loadedImage.filename) return null;
                    return this.plotService.plot(
                      this.plotDivName,
                      loadedImage,
                      phaseInfo,
                      screenHeight,
                      this.plotType,
                      inPlace,
                    );
                  }),
                smallShown: () => {
                  // Small tier on screen — drop the full overlay but keep a
                  // translucent spinner so the blurry render isn't mistaken for
                  // the final image.
                  releaseOverlay();
                  this.sharpening = true;
                },
                sharpenSettled: () => {
                  this.sharpening = false;
                },
                finished: (viaSmall, logTag) => {
                  if (!viaSmall) releaseOverlay();
                  this.running = false;
                  applyRoi();
                  console.log(logTag);
                },
                sharpenFailed: (err: any) => {
                  // The small tier stays on screen as the fallback — tell the
                  // user the sharper version isn't coming.
                  const msg = err?.error?.message || err?.message || err?.statusText || String(err);
                  this.messageService.add({
                    key: 'center-toast',
                    severity: 'warn',
                    summary: 'Preview not sharpened',
                    detail: `The full-resolution preview did not load (${msg}). The low-resolution preview is still shown. Try clicking the image again.`,
                  });
                  this.running = false;
                  applyRoi();
                },
              }).render(imgInfo, smallImgInfo);
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
      const plotEl = document.getElementById(this.plotDivName);
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
      // SAM point mode: Enter commits the object, Esc clears the prompt.
      if (this.activeDragMode === 'samPoint' && (event.key === 'Enter' || event.key === 'Escape')) {
        this.ngZone.run(() => {
          if (event.key === 'Enter') this.plotService.commitSamPoints();
          else this.plotService.clearSamPoints();
          this.hideSamToast(); // prompt resolved → dismiss the status toast
        });
        return;
      }
      // Region history (jit-ui#85): Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z or
      // Ctrl/Cmd+Y redoes.
      if (event.ctrlKey || event.metaKey) {
        const k = event.key.toLowerCase();
        if (k === 'z' && !event.shiftKey) {
          event.preventDefault();
          this.ngZone.run(() => this.undoRegion());
          return;
        }
        if ((k === 'z' && event.shiftKey) || k === 'y') {
          event.preventDefault();
          this.ngZone.run(() => this.redoRegion());
          return;
        }
      }
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
      const plotEl = document.getElementById(this.plotDivName);
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
      const rect = document.getElementById(this.plotDivName)?.getBoundingClientRect();
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
    this.scrubber.cancel();
    this.samPointSub.unsubscribe();
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

  /** Open the Channels & Histogram dialog (toolbar button). */
  openChannelHistogram() {
    this.showChannelHistogram = true;
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
    this.zIndex = z;
    this.scrubber.commit(z);
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
    this.scrubber.scrub(z);
  }

  /**
   * Keyboard stack navigation: ←/→ step the z-slice in the Image view, the same
   * way the slider does. Only active for a loaded stack in Image view, and
   * ignored while a form field is focused so typing isn't hijacked. Up/Down are
   * left to OpenSeadragon (panning).
   */
  @HostListener('window:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (!this.imageInfo?.isStack || !this.isImageView) return;
    const t = e.target as HTMLElement | null;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    // The slice slider handles arrows natively when focused (also a +1 step) —
    // skip here so we don't double-step it.
    if (t && (t.getAttribute('role') === 'slider' || t.closest('.p-slider'))) return;
    e.preventDefault();
    this.stepSlice(e.key === 'ArrowRight' ? 1 : -1);
  }

  /** Move the displayed slice by `delta`, clamped to the stack bounds. */
  stepSlice(delta: number): void {
    const next = Math.min(this.maxIndex, Math.max(0, this.zIndex + delta));
    if (next === this.zIndex) return;
    this.onZSlide(next);
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

  /** Toolbar pixel/smooth toggle: flip smoothing and apply to the active backend. */
  onToggleImageSmoothing(): void {
    this.imageSmoothingEnabled = !this.imageSmoothingEnabled;
    this.plotService.setImageSmoothingEnabled(this.imageSmoothingEnabled);
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
    this.plotService.setBrushMode(active === 'brush', { size: this.brushSize });
    this.plotService.setSamPointMode(active === 'samPoint');
    // Leaving point mode dismisses any lingering status toast.
    if (active !== 'samPoint') this.hideSamToast();
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

  onBrushSizeChange(value: number | undefined) {
    if (value === undefined || !Number.isFinite(value)) return;
    this.brushSize = value;
    this.plotService.setBrushOptions({ size: value });
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

  /** Undo the most recent region action (jit-ui#85). Up to 10 steps back. */
  undoRegion() {
    this.plotService.undo();
  }

  /** Redo the most recently undone region action (jit-ui#85). */
  redoRegion() {
    this.plotService.redo();
  }

  /** Box-prompted SAM segmentation of the drawn rectangles (jit-ui#90). A sticky
   *  `sam` toast shows live status + a download progress bar (first run pulls the
   *  encoder, ~170 MB); it stays open until the run finishes (bar hits 100%). */
  async segmentRegions() {
    await this.runSegmentWithToast('SAM', this.samTool, () => this.plotService.segmentRectangles());
  }

  /** Auto-segment cells inside each drawn rectangle with cellpose-SAM, client-side
   *  (jit-ui#90). Each box is cropped (browser slide-crop) then run through the
   *  cellpose-js model; the same sticky `sam` toast + progress bar is reused. */
  async segmentCellpose() {
    await this.runSegmentWithToast('Cellpose', this.cellSegmentTool, () =>
      this.plotService.segmentRectanglesCellpose(),
    );
  }

  /** Shared driver for the box-prompt segment tools: wires the tool's status +
   *  download progress into the sticky `sam` toast, runs `op`, and reports the
   *  region count. Keeps the toast open until the run settles (bar hits 100%). */
  private async runSegmentWithToast(
    label: string,
    tool: { status$: BehaviorSubject<string>; progress$: BehaviorSubject<number> },
    op: () => Promise<number>,
  ) {
    this.samStatus = 'Starting…';
    this.samProgress = 0;
    this.samDownloading = false;
    this.samBusy = true;
    const psub = tool.progress$.subscribe((f) => {
      this.samDownloading = f >= 0 && f < 1;
      if (f >= 0) this.samProgress = Math.min(100, Math.round(f * 100));
      this.cdr.detectChanges();
    });
    const ssub = tool.status$.subscribe((m) => {
      if (m) {
        this.samStatus = m;
        this.cdr.detectChanges();
      }
    });
    this.showSamToast(label);
    try {
      const n = await op();
      this.messageService.add({
        severity: n > 0 ? 'success' : 'warn',
        summary: label,
        detail: tool.status$.value || (n > 0 ? `Added ${n} region(s).` : 'No regions added.'),
      });
    } catch (e) {
      this.messageService.add({ severity: 'error', summary: `${label} failed`, detail: String(e) });
    } finally {
      psub.unsubscribe();
      ssub.unsubscribe();
      this.hideSamToast();
    }
  }

  /** Show the shared sticky `sam` toast once (idempotent — re-adding would stack
   *  a new toast on every point click). */
  private showSamToast(summary: string): void {
    if (this.samToastShown) return;
    this.samToastShown = true;
    this.messageService.add({ key: this.samToastKey, sticky: true, severity: 'info', summary });
  }

  /** Dismiss the shared `sam` toast and reset its progress/spinner state. */
  private hideSamToast(): void {
    this.samToastShown = false;
    this.samBusy = false;
    this.samDownloading = false;
    this.samProgress = 0;
    this.messageService.clear(this.samToastKey);
    this.cdr.detectChanges();
  }

  /** Pick the SAM model the segment tools use (jit-ui#90 P1). */
  onSamModelChange(id: string) {
    this.samModelId = id;
    this.plotService.setSamModel(id);
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
          label: 'Brush',
          icon: 'brush-icon',
          styleClass: active === 'brush' ? activeClass : '',
          command: () => this.toggleDragMode('brush'),
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
    this.plotService.setBrushMode(false);
    this.plotService.setSamPointMode(false);
    this.plotService.setVertexEraserMode(false);
  }
}

