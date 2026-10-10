import { Region } from '../models/region';
import { IImageInfo } from '../contracts/image.contract';
import { RegionScopeCache } from './region-scope-cache';

const reg = (id: number, z?: number): Region => Object.assign(new Region(), { id, z });

describe('RegionScopeCache', () => {
  let cache: RegionScopeCache;
  beforeEach(() => { cache = new RegionScopeCache(); });

  it('keys an image by its first URL, else its file name', () => {
    expect(RegionScopeCache.imageKey(undefined)).toBeUndefined();
    expect(RegionScopeCache.imageKey({ urls: ['a/x.tif'], fileName: 'x.tif' } as IImageInfo)).toBe('a/x.tif');
    expect(RegionScopeCache.imageKey({ urls: [''], fileName: 'x.tif' } as IImageInfo)).toBe('x.tif');
    expect(RegionScopeCache.imageKey({ fileName: '' } as IImageInfo)).toBeUndefined();
  });

  it('caches the live set per image and restores it on switch back', () => {
    expect(cache.switchImage('a', [])).toEqual([]);
    const a = [reg(1)];
    cache.sync(a);
    expect(cache.switchImage('b', a)).toEqual([]);
    expect(cache.switchImage('a', [reg(2)])).toEqual(a);
    expect(cache.switchImage('a', a)).toBeNull(); // same image: no swap
  });

  it('switching images ends stack mode', () => {
    cache.switchImage('a', []);
    cache.enterStack(new Map([[0, [reg(1, 0)]]]), 0, 'per-slice-file');
    cache.switchImage('b', []);
    expect(cache.stackMode).toBe(false);
    expect(cache.displaySlice).toBe(0);
  });

  it('showSlice captures the live slice and returns the target; null when nothing swaps', () => {
    expect(cache.showSlice(4, [])).toBeNull();
    expect(cache.displaySlice).toBe(4); // recorded outside stack mode
    const live0 = cache.enterStack(new Map([[0, [reg(1, 0)]], [2, [reg(2, 2)]]]), 0, 'combined');
    expect(live0.map((r) => r.id)).toEqual([1]);
    const edited = [reg(1, 0), reg(3, 0)];
    expect(cache.showSlice(2, edited)!.map((r) => r.id)).toEqual([2]);
    expect(cache.showSlice(2, [])).toBeNull();
    expect(cache.showSlice(0, [reg(2, 2)])!.map((r) => r.id)).toEqual([1, 3]);
  });

  it('sliceRegions flattens every slice in order, tagging copies with z', () => {
    const untagged = reg(2);
    cache.enterStack(new Map([[3, [untagged]], [1, [reg(1, 1)]]]), 1, 'combined');
    const all = cache.sliceRegions([reg(1, 1)]);
    expect(all.map((r) => [r.id, r.z])).toEqual([[1, 1], [2, 3]]);
    expect(untagged.z).toBeUndefined();
  });

  it('stackSaveSlices includes slices loaded non-empty that are now empty', () => {
    cache.enterStack(new Map([[0, [reg(1, 0)]], [1, []]]), 0, 'per-slice-file');
    const save = cache.stackSaveSlices([]);
    expect(Array.from(save.keys())).toEqual([0]);
    expect(save.get(0)).toEqual([]);
    expect(new RegionScopeCache().stackSaveSlices([reg(1)]).size).toBe(0);
  });
});
