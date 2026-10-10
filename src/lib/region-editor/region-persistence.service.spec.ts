import { fakeAsync, tick } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';

import { Region } from '../models/region';
import { IRegionEditorApi } from '../contracts/region-editor-api.contract';
import { RegionIoPort } from '../contracts/ports/region-io.port';
import { RegionPersistenceService } from './region-persistence.service';

jest.mock('file-saver', () => ({ saveAs: jest.fn() }));
import { saveAs } from 'file-saver';

describe('RegionPersistenceService', () => {
  let api: jest.Mocked<Pick<IRegionEditorApi, 'isStackMode' | 'getStackSaveLayout' | 'getSliceAnnotationRegions'
    | 'getStackSaveAnnotationSlices' | 'getGeoJsonString'>>;
  let io: jest.Mocked<RegionIoPort>;
  let svc: RegionPersistenceService;
  const r = (z?: number) => Object.assign(new Region(), { id: 1, z });

  beforeEach(() => {
    api = {
      isStackMode: jest.fn(() => false),
      getStackSaveLayout: jest.fn(() => 'combined' as const),
      getSliceAnnotationRegions: jest.fn(() => [r(0), r(1)]),
      getStackSaveAnnotationSlices: jest.fn(() => new Map([[2, [r(2)]], [3, []]])),
      getGeoJsonString: jest.fn((regs: Region[]) => JSON.stringify(regs.map((x) => x.z))),
    };
    io = {
      getSelectedFileName: jest.fn(() => 'slide.ome.tif'),
      roiFileExists: jest.fn((_name: string) => of(true)),
      saveGeoJson: jest.fn((_geo: string, _name: string) => of(void 0)),
      saveSliceGeoJsons: jest.fn((_slices: { z: number; geoJsonStr: string }[]) => of(void 0)),
    };
    svc = new RegionPersistenceService(api as unknown as IRegionEditorApi, io);
  });

  it('derives default names from the selected file (RT-19)', () => {
    expect(svc.defaultSaveName()).toBe('slide.ome.geojson');
    expect(svc.defaultExportName()).toBe('slide.ome.geojson');
    expect(svc.defaultMaskName()).toBe('slide.ome_mask.png');
    io.getSelectedFileName.mockReturnValue(undefined);
    expect(svc.defaultSaveName()).toBeUndefined();
    expect(svc.defaultExportName()).toBe('rois.geojson');
    expect(svc.defaultMaskName()).toBe('regions_mask.png');
  });

  it('saves every slice for a combined z-stack, else the live set', () => {
    const live = [r()];
    expect(svc.regionsForSave(live)).toBe(live);
    api.isStackMode.mockReturnValue(true);
    expect(svc.regionsForSave(live).map((x) => x.z)).toEqual([0, 1]);
    api.getStackSaveLayout.mockReturnValue('per-slice-file');
    expect(svc.savesPerSlice()).toBe(true);
    expect(svc.regionsForSave(live)).toBe(live);
  });

  it('debounces the exists check to the latest name', fakeAsync(() => {
    const seen: boolean[] = [];
    const names = new Subject<string>();
    const sub = svc.fileExists(names).subscribe((e) => seen.push(e));
    names.next('a');
    tick(100);
    names.next('b');
    tick(400);
    expect(io.roiFileExists).toHaveBeenCalledTimes(1);
    expect(io.roiFileExists).toHaveBeenCalledWith('b');
    expect(seen).toEqual([true]);
    sub.unsubscribe();
  }));

  it('save serializes on the next tick and uploads; unsubscribing first cancels it', fakeAsync(() => {
    const done = jest.fn();
    svc.save(() => [r()], 'x.geojson').subscribe({ complete: done });
    expect(io.saveGeoJson).not.toHaveBeenCalled();
    tick();
    expect(io.saveGeoJson).toHaveBeenCalledWith('[null]', 'x.geojson');
    expect(done).toHaveBeenCalled();

    io.saveGeoJson.mockClear();
    svc.save(() => [r()], 'y.geojson').subscribe().unsubscribe();
    tick();
    expect(io.saveGeoJson).not.toHaveBeenCalled();
  }));

  it('save reports a serialize failure and an upload failure as errors', fakeAsync(() => {
    const errors: unknown[] = [];
    api.getGeoJsonString.mockImplementationOnce(() => { throw new Error('ser'); });
    svc.save(() => [], 'a').subscribe({ error: (e) => errors.push((e as Error).message) });
    io.saveGeoJson.mockReturnValueOnce(throwError(() => new Error('up')));
    svc.save(() => [], 'b').subscribe({ error: (e) => errors.push((e as Error).message) });
    tick();
    expect(errors).toEqual(['ser', 'up']);
  }));

  it('serializes per-slice files on the default plane, empty slices included', () => {
    expect(svc.sliceGeoJsons()).toEqual([{ z: 2, geoJsonStr: '[0]' }, { z: 3, geoJsonStr: '[]' }]);
  });

  it('download writes the GeoJSON blob under the given name', () => {
    svc.download([r()], 'out.geojson');
    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob), 'out.geojson');
  });
});
