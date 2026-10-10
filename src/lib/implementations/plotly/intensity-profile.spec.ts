import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { InjectionToken } from '@angular/core';
import { MessageService } from 'primeng/api';

import { PlotlyService } from './plotly.service';
import { VIZ_PORT_STUBS } from '../../testing/viz-port-stubs';
import { CachedImageData } from '../../toolbar/wand/wand-tool.service';
import { RegionStore } from '../../store/region-store.service';
import { Polygon, Region } from '../../models/region';
import { IntensityProfile } from '../../contracts/visualizer.contract';
import { IImageInfo } from '../../contracts/image.contract';
import { IntensityProfileService } from '../../intensity/intensity-profile.service';

/**
 * Locks the intensity-profile sampling used by the LINE plot type's draggable
 * line ROI → floating inset.
 */
describe('IntensityProfileService sampling', () => {
  let service: IntensityProfileService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS, MessageService],
    });
    service = TestBed.inject(IntensityProfileService);
  });

  it('samples grayscale intensity along a horizontal line ROI', () => {
    // 1 frame, 2 rows x 3 cols.
    service.setFrames({
      frames: [
        [
          [10, 20, 30],
          [40, 50, 60],
        ],
      ],
      ratios: [1, 1],
    });

    const profile = service.computeIntensityProfile({ x0: 0, y0: 0, x1: 2, y1: 0 });
    expect(profile.values).toEqual([10, 30]);
    expect(profile.positions).toEqual([0, 2]);
  });

  it('uses RGB luminance for colour frames', () => {
    // single RGB pixel row: red, then white.
    service.setFrames({
      frames: [
        [
          [
            [255, 0, 0],
            [255, 255, 255],
          ],
        ],
      ],
      ratios: [1, 1],
    });

    const profile = service.computeIntensityProfile({ x0: 0, y0: 0, x1: 1, y1: 0 });
    expect(profile.values[0]).toBeCloseTo(0.299 * 255, 2); // red luminance
    expect(profile.values[1]).toBeCloseTo(255, 2); // white luminance
  });

  it('returns empty when no image is cached', () => {
    service.setFrames({ frames: [], ratios: [1, 1] });
    expect(service.computeIntensityProfile({ x0: 0, y0: 0, x1: 1, y1: 0 })).toEqual({ positions: [], values: [] });
  });
});

/**
 * The wand/brush/SAM read the same cache through getCachedImageData(). After a
 * high-def zoom it holds the zoomed CROP, so it must report the crop's origin
 * and size, not the full image's (review OSD-PLOTLY-2).
 */
describe('PlotlyService sampling cache after setSamplingFrames (OSD-PLOTLY-2)', () => {
  let service: PlotlyService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS, MessageService],
    });
    service = TestBed.inject(PlotlyService);
  });

  type Cache = { getCachedImageData(): CachedImageData | null };

  it('reports the crop origin and the crop size to the pixel tools', () => {
    // Full image first (as plot() caches it): 1000 x 800.
    Object.assign(service, { cachedImageWidth: 1000, cachedImageHeight: 800 });
    // A 3-wide, 2-tall crop whose top-left sits at image (100, 50).
    const crop = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    service.setSamplingFrames([crop], [0.5, 0.5], [100, 50]);

    const data = (service as unknown as Cache).getCachedImageData();
    expect(data).toEqual(
      expect.objectContaining({
        originX: 100,
        originY: 50,
        width: 3,
        height: 2,
        ratios: [0.5, 0.5],
      }),
    );
  });

  it('reports origin 0,0 for a full-frame cache', () => {
    service.setSamplingFrames(
      [
        [
          [1, 2],
          [3, 4],
        ],
      ],
      [1, 1],
    );
    const data = (service as unknown as Cache).getCachedImageData();
    expect(data).toEqual(expect.objectContaining({ originX: 0, originY: 0, width: 2, height: 2 }));
  });
});

/**
 * Characterization ahead of the IntensityProfileService extraction (review §6,
 * proposal B step 4): line placement, physical-unit scaling and crop-origin
 * sampling.
 */
describe('PlotlyService intensity profile lines (characterization)', () => {
  let service: PlotlyService;
  let intensity: IntensityProfileService;
  let regionStore: RegionStore;
  /** The image the profile lines are placed over ([x0, x1, y0, y1]). */
  const image = (extent: number[], imageInfo = {} as IImageInfo) =>
    intensity.setFrames({ frames: [], ratios: [1, 1] }, { imageInfo, extent });

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS, MessageService],
    });
    service = TestBed.inject(PlotlyService);
    regionStore = TestBed.inject(RegionStore);
    intensity = TestBed.inject(IntensityProfileService);
  });

  const ends = (r: Region | null) => {
    const b = r!.bounds as Polygon;
    return { xs: b.xpoints, ys: b.ypoints, closed: b.closed, kind: r!.kind };
  };

  it('needs an image extent before it can place a line', () => {
    expect(service.addProfileLine()).toBeNull();
  });

  it('spans 2/3 of the image width, centred, staggering each new line down the image', () => {
    image([0, 1000, 0, 800]);
    const first = ends(service.addProfileLine());
    expect(first.xs[0]).toBeCloseTo(1000 / 6);
    expect(first.xs[1]).toBeCloseTo(5000 / 6);
    expect(first.ys).toEqual([400, 400]);
    expect(first).toMatchObject({ closed: false, kind: 'profile' });
    const second = ends(service.addProfileLine());
    expect(second.ys).toEqual([400 + 800 * 0.12, 400 + 800 * 0.12]);
    expect(regionStore.getRegions()).toHaveLength(2);
  });

  it('places the line inside the last visible region when it overlaps the image', () => {
    image([0, 1000, 0, 800]);
    intensity.refreshIntensitySamplingForRoi(100, 100, 200, 100, 0);
    const line = ends(service.addProfileLine());
    expect(line.xs[0]).toBeCloseTo(200 - 200 / 3);
    expect(line.xs[1]).toBeCloseTo(200 + 200 / 3);
    expect(line.ys).toEqual([150, 150]);
  });

  it('cycles a bright palette, one colour per line', () => {
    image([0, 100, 0, 100]);
    const colors = Array.from({ length: 9 }, () => service.addProfileLine()!.color);
    expect(new Set(colors.slice(0, 8)).size).toBe(8);
    expect(colors[8]).toBe(colors[0]);
  });

  it('measures along the line in microns when the image carries a pixel size', () => {
    image([0, 3, 0, 2], { imageMeta: [{ mppX: 0.5, mppY: 0.25 }] } as IImageInfo);
    intensity.setFrames({
      frames: [
        [
          [10, 20, 30],
          [40, 50, 60],
        ],
      ],
      ratios: [1, 1],
    });
    const profile = intensity.computeIntensityProfile({ x0: 0, y0: 0, x1: 2, y1: 0 });
    expect(profile).toEqual({ positions: [0, 1], values: [10, 30], unit: 'µm' });
  });

  it('samples a zoom crop at its origin', () => {
    service.setSamplingFrames(
      [
        [
          [1, 2, 3],
          [4, 5, 6],
        ],
      ],
      [1, 1],
      [100, 50],
    );
    const profile = intensity.computeIntensityProfile({ x0: 100, y0: 51, x1: 102, y1: 51 });
    expect(profile.values).toEqual([4, 6]);
    expect(profile.unit).toBe('px');
  });

  it("re-emits every line's profile, tagged with its id and colour, when a region changes", () => {
    image([0, 3, 0, 2]);
    service.setSamplingFrames(
      [
        [
          [10, 20, 30],
          [40, 50, 60],
        ],
      ],
      [1, 1],
    );
    const seen: IntensityProfile[][] = [];
    intensity.getIntensityProfile$().subscribe((p) => seen.push(p));
    const line = service.addProfileLine()!;
    const last = seen[seen.length - 1];
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ id: line.id, color: line.color });
    expect(last[0].values.length).toBeGreaterThan(1);
  });
});
