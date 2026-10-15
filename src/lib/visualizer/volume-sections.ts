import { BehaviorSubject, Observable } from 'rxjs';

import type { IChannelState } from '../contracts/channel-histogram-api.contract';
import type { SectionAxis, SectionRegions, SectionView, SectionViews } from '../contracts/section-view.contract';
import type { SliceOutlines } from '../geometry/reconstruct';
import { VolumeVoxels, resliceImage } from '../geometry/reslice-image';
import { sectionOutlines } from '../geometry/section';
import type { VolumeVoxelsOnScreen } from '../implementations/napari-js/napari-scene';
import type { SlicePlanes } from '../implementations/napari-js/napari-volume-slice-planes';

/** What the sections are cut from and shown with. */
export interface VolumeSectionsDeps {
  /** The volume on screen as assembled, or null (not a volume view, or not assembled yet). */
  volume(): VolumeVoxelsOnScreen | null;
  /** Show the planes in the volume (null: hide one). */
  showPlanes(planes: SlicePlanes): void;
  /** Every class's outlines on every slice (see RegionStore.outlinesByClass). */
  outlinesByClass(level: number): Promise<Map<string, SliceOutlines[]>>;
  isClassHidden(label: string): boolean;
  colorOf(label: string): string;
  channelStates(): IChannelState[];
  invert(): boolean;
  /** The slice shown and edited. */
  slice(): number;
}

const NONE: SectionViews = { x: null, y: null };

/**
 * The sections beside a split volume view: the planes x = const and y = const (image px), each cut
 * from the assembled volume as an image, displayed like the 2D view displays a slice (the channel
 * windows, tints and invert), with every class's outlines cut by the same plane and the other two
 * planes as a crosshair. Recut when a plane moves, the slice changes, the regions or their
 * visibility change, the display changes or the volume is assembled again — once per frame at most.
 */
export class VolumeSections {
  private readonly views$ = new BehaviorSubject<SectionViews>(NONE);
  private open = false;
  private planes: { x: number | null; y: number | null } = { x: null, y: null };
  /** Every class's outlines at a level, read once until the regions change. */
  private outlines: { level: number; read: Promise<Map<string, SliceOutlines[]>> } | null = null;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  /** Bumped per cut, so a cut that waited on the outlines is dropped when a newer one starts. */
  private request = 0;

  constructor(private readonly deps: VolumeSectionsDeps) {}

  /** Both sections as they are cut; nulls while closed. */
  getViews$(): Observable<SectionViews> {
    return this.views$.asObservable();
  }

  /** Show the sections (their planes through the middle of the image at first). */
  start(): void {
    this.open = true;
    this.schedule();
  }

  stop(): void {
    this.open = false;
    this.request++;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.deps.showPlanes({ x: null, y: null, z: null });
    this.views$.next(NONE);
  }

  /** Move a section's plane to `at` (image px; clamped into the image). */
  setPlane(axis: SectionAxis, at: number): void {
    const size = this.deps.volume()?.frame.size;
    const max = size ? size[axis === 'x' ? 0 : 1] - 1 : Infinity;
    this.planes[axis] = Math.min(max, Math.max(0, at));
    this.schedule();
  }

  /** The planes as they are (image px), the z plane being the slice. */
  getPlanes(): SlicePlanes {
    return { ...this.planes, z: this.open ? this.deps.slice() : null };
  }

  /** The regions changed: their outlines are read again for the next cut. */
  regionsChanged(): void {
    this.outlines = null;
    this.schedule();
  }

  /** Something the sections show changed (the slice, the display, the visible classes, the volume). */
  schedule(): void {
    if (!this.open || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.cut();
    });
  }

  private async cut(): Promise<void> {
    const request = ++this.request;
    const vol = this.deps.volume();
    if (!this.open || !vol) {
      this.views$.next(NONE);
      return;
    }
    const [w, h] = vol.frame.size;
    this.planes.x ??= Math.floor(w / 2);
    this.planes.y ??= Math.floor(h / 2);
    this.deps.showPlanes(this.getPlanes());
    // The outlines at the volume's resolution (image px per voxel).
    const step = w / Math.max(1, vol.width);
    const level = Math.max(0, Math.floor(Math.log2(Math.max(1, step))));
    if (!this.outlines || this.outlines.level !== level) {
      this.outlines = { level, read: this.deps.outlinesByClass(level) };
    }
    let byClass: Map<string, SliceOutlines[]>;
    try {
      byClass = await this.outlines.read;
    } catch (err) {
      console.warn('[visualizer] The regions could not be cut for the sections.', err);
      byClass = new Map();
    }
    if (request !== this.request || !this.open) return;
    for (const label of byClass.keys()) if (this.deps.isClassHidden(label)) byClass.delete(label);
    const voxels = this.voxels(vol);
    this.views$.next({
      x: this.view('x', vol, voxels, byClass, step),
      y: this.view('y', vol, voxels, byClass, step),
    });
  }

  private view(
    axis: SectionAxis,
    vol: VolumeVoxelsOnScreen,
    voxels: VolumeVoxels,
    byClass: ReadonlyMap<string, SliceOutlines[]>,
    step: number,
  ): SectionView {
    const [w, h, d] = vol.frame.size;
    const [ww, wh, wd] = vol.frame.world;
    const at = this.planes[axis] as number;
    const voxel = axis === 'x' ? (at / w) * vol.width : (at / h) * vol.height;
    const cut = sectionOutlines(byClass, axis, at, { depth: d, extent: axis === 'x' ? h : w, step });
    const regions: SectionRegions[] = Array.from(cut, ([label, c]) => ({
      label,
      color: this.deps.colorOf(label),
      ...c,
    }));
    const z = this.deps.slice() + 0.5;
    return {
      axis,
      at,
      image: resliceImage(voxels, axis, Math.floor(voxel)),
      size: axis === 'x' ? [d, h] : [w, d],
      scale: axis === 'x' ? [wd / d, wh / h] : [ww / w, wd / d],
      regions,
      crosshair: axis === 'x' ? { u: z, v: this.planes.y } : { u: this.planes.x, v: z },
    };
  }

  /** The volume's channels as displayed now. */
  private voxels(vol: VolumeVoxelsOnScreen): VolumeVoxels {
    const states = this.deps.channelStates();
    const channels = vol.multichannel
      ? Array.from(vol.channels, ([c, data]) => {
          const st = states.find((s) => s.index === c);
          return {
            data,
            color: st?.color ?? '#ffffff',
            min: st?.min ?? 0,
            max: st?.max ?? 255,
            gamma: st?.gamma ?? 1,
            visible: st?.visible ?? true,
          };
        })
      : [
          {
            data: vol.channels.get(0) as Uint8Array,
            color: '#ffffff',
            min: states[0]?.min ?? 0,
            max: states[0]?.max ?? 255,
            gamma: states[0]?.gamma ?? 1,
            visible: true,
          },
        ];
    return { width: vol.width, height: vol.height, depth: vol.depth, channels, invert: this.deps.invert() };
  }
}
