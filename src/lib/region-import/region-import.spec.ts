import { folderSliceGeoJson, importFile, naturalCompare, planRegionImport } from './region-import';

const f = (name: string, text = '{}') => importFile(text, name);

describe('planRegionImport', () => {
  it('takes a label volume with the ontology chosen with it', () => {
    const plan = planRegionImport([
      f('ontology/structure_graph_1.json'),
      f('annotation_25.nrrd'),
      f('notes.json'),
    ]);
    expect(plan?.kind).toBe('volume');
    if (plan?.kind !== 'volume') return;
    expect(plan.volume.name).toBe('annotation_25.nrrd');
    expect(plan.ontology?.name).toBe('ontology/structure_graph_1.json');
    expect(planRegionImport([f('labels.nii.gz')])).toEqual({
      kind: 'volume',
      volume: expect.anything(),
      ontology: null,
    });
  });

  it("takes a folder's per-slice files in natural name order, its regionset.json apart", () => {
    const plan = planRegionImport([
      f('s/slice_10.geojson'),
      f('s/regionset.json'),
      f('s/slice_2.geojson'),
      f('s/slice_1.geojson'),
    ]);
    expect(plan?.kind).toBe('folder');
    if (plan?.kind !== 'folder') return;
    expect(plan.slices.map((s) => s.name)).toEqual([
      's/slice_1.geojson',
      's/slice_2.geojson',
      's/slice_10.geojson',
    ]);
    expect(plan.regionSet?.name).toBe('s/regionset.json');
  });

  it('takes one region file as before, and nothing usable as nothing', () => {
    expect(planRegionImport([f('slide.geojson')])?.kind).toBe('single');
    expect(planRegionImport([f('slide.json')])?.kind).toBe('single');
    expect(planRegionImport([f('image.tif')])).toBeNull();
    expect(planRegionImport([])).toBeNull();
  });

  it('compares names naturally', () => {
    expect(['b10', 'b2', 'a1'].sort(naturalCompare)).toEqual(['a1', 'b2', 'b10']);
  });
});

describe('folderSliceGeoJson', () => {
  it("gives a slice the set's class tree and style unless it has its own", async () => {
    const set = { classHierarchy: [{ name: 'A' }], style: { labels: true } };
    const plain = JSON.parse(
      await folderSliceGeoJson(f('0.geojson', '{"type":"FeatureCollection","features":[]}'), set),
    );
    expect(plain.classHierarchy).toEqual([{ name: 'A' }]);
    expect(plain.style).toEqual({ labels: true });
    const own = JSON.parse(
      await folderSliceGeoJson(
        f('1.geojson', '{"type":"FeatureCollection","classHierarchy":[{"name":"B"}],"features":[]}'),
        set,
      ),
    );
    expect(own.classHierarchy).toEqual([{ name: 'B' }]);
    expect(await folderSliceGeoJson(f('2.geojson', 'TEXT'), null)).toBe('TEXT');
  });
});

describe('importFile', () => {
  it('reads a string, bytes or a Blob as text and as bytes', async () => {
    expect(await importFile('abc', 'a').text()).toBe('abc');
    expect(Array.from(await importFile(new Uint8Array([104, 105]), 'b').bytes())).toEqual([104, 105]);
    expect(await importFile(new Uint8Array([104, 105]).buffer, 'c').text()).toBe('hi');
  });
});
