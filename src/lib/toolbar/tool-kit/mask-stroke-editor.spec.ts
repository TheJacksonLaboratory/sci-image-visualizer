import { MaskStrokeEditor, StrokeCommitOptions } from './mask-stroke-editor';
import { MatrixFrame } from './matrix-frame';
import { Polygon, Region } from '../../models/region';
import { IRegionDataHost } from '../../contracts/coordinate-transform.contract';

/** A host that keeps whatever the editor commits. */
function host(state: { regions: Region[] }): IRegionDataHost {
  return {
    getRegions: () => state.regions,
    setRegions: (regions: Region[]) => {
      state.regions = regions.map((r, i) => {
        if (r.id == null) r.id = i + 1;
        return r;
      });
    },
  } as unknown as IRegionDataHost;
}

const opts: StrokeCommitOptions = {
  erase: false,
  defaultLabel: 'Region',
  newRegion: (bounds) => Object.assign(new Region(), { bounds }),
};

const extent = (p: Polygon) => [
  Math.min(...p.xpoints),
  Math.min(...p.ypoints),
  Math.max(...p.xpoints),
  Math.max(...p.ypoints),
];

describe('MaskStrokeEditor', () => {
  // OSD and napari: a readback 2 data units per pixel, its pixel (0, 0) at data (100, 40).
  const frame = MatrixFrame.from({ ratios: [2, 2], originX: 100, originY: 40 });
  const image = { width: 64, height: 64 };

  it('re-adopting a region (after a zoom, pan, tool switch or undo) does not shrink it', () => {
    const state = { regions: [] as Region[] };
    const editor = new MaskStrokeEditor();
    editor.syncFrame(frame);
    // A painted 40×40 box over matrix pixels [10, 50).
    editor.ensureCovers(10, 10, 50, 50);
    editor.stroke!.mask.fill(1);
    editor.commit(state.regions, frame, host(state), opts);
    const first = extent(state.regions[0].bounds as Polygon);
    expect(first).toEqual([120, 60, 200, 140]);

    for (let i = 0; i < 3; i++) {
      editor.reset(); // the stroke is dropped; the next click adopts the region again
      expect(editor.adoptAt(state.regions, 30, 30, frame, image)).toBe(true);
      expect(editor.stroke!.mask.every((v) => v === 1)).toBe(true);
      expect([editor.stroke!.bw, editor.stroke!.bh]).toEqual([40, 40]);
      editor.commit(state.regions, frame, host(state), opts);
      expect(extent(state.regions[0].bounds as Polygon)).toEqual(first);
    }
  });

  it('adopts a region drawn at data coordinates that are not on the pixel grid', () => {
    // A box from matrix 10.4 to 20.4: pixels whose centres (i + 0.5) fall inside are 10…19.
    const state = { regions: [] as Region[] };
    const p = new Polygon();
    p.xpoints = [120.8, 140.8, 140.8, 120.8];
    p.ypoints = [60.8, 60.8, 80.8, 80.8];
    state.regions.push(Object.assign(new Region(), { id: 1, bounds: p }));
    const editor = new MaskStrokeEditor();
    editor.syncFrame(frame);
    expect(editor.adoptAt(state.regions, 15, 15, frame, image)).toBe(true);
    const s = editor.stroke!;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let y = 0; y < s.bh; y++)
      for (let x = 0; x < s.bw; x++) {
        if (!s.mask[y * s.bw + x]) continue;
        xs.push(s.bx + x);
        ys.push(s.by + y);
      }
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([10, 19, 10, 19]);
    expect(xs.length).toBe(100);
  });
});
