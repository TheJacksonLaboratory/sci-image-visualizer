import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { InjectionToken } from '@angular/core';
import { MessageService } from 'primeng/api';

import { PlotlyService } from './plotly.service';
import { VIZ_PORT_STUBS } from '../../testing/viz-port-stubs';
import { CachedImageData } from '../../toolbar/wand/wand-tool.service';

/**
 * Locks the intensity-profile sampling used by the LINE plot type's draggable
 * line ROI → floating inset.
 */
describe('PlotlyService intensity profile sampling', () => {
  let service: PlotlyService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        PlotlyService, ...VIZ_PORT_STUBS,
        MessageService,
      ],
    });
    service = TestBed.inject(PlotlyService);
  });

  it('samples grayscale intensity along a horizontal line ROI', () => {
    // 1 frame, 2 rows x 3 cols.
    (service as any).cachedImageFrames = [[[10, 20, 30], [40, 50, 60]]];
    (service as any).cachedImageRatios = [1, 1];

    const profile = (service as any).computeIntensityProfile({ x0: 0, y0: 0, x1: 2, y1: 0 });
    expect(profile.values).toEqual([10, 30]);
    expect(profile.positions).toEqual([0, 2]);
  });

  it('uses RGB luminance for colour frames', () => {
    // single RGB pixel row: red, then white.
    (service as any).cachedImageFrames = [[[[255, 0, 0], [255, 255, 255]]]];
    (service as any).cachedImageRatios = [1, 1];

    const profile = (service as any).computeIntensityProfile({ x0: 0, y0: 0, x1: 1, y1: 0 });
    expect(profile.values[0]).toBeCloseTo(0.299 * 255, 2); // red luminance
    expect(profile.values[1]).toBeCloseTo(255, 2);         // white luminance
  });

  it('returns empty when no image is cached', () => {
    (service as any).cachedImageFrames = [];
    expect((service as any).computeIntensityProfile({ x0: 0, y0: 0, x1: 1, y1: 0 }))
      .toEqual({ positions: [], values: [] });
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
    const crop = [[1, 2, 3], [4, 5, 6]];
    service.setSamplingFrames([crop], [0.5, 0.5], [100, 50]);

    const data = (service as unknown as Cache).getCachedImageData();
    expect(data).toEqual(expect.objectContaining({
      originX: 100, originY: 50, width: 3, height: 2, ratios: [0.5, 0.5],
    }));
  });

  it('reports origin 0,0 for a full-frame cache', () => {
    service.setSamplingFrames([[[1, 2], [3, 4]]], [1, 1]);
    const data = (service as unknown as Cache).getCachedImageData();
    expect(data).toEqual(expect.objectContaining({ originX: 0, originY: 0, width: 2, height: 2 }));
  });
});
