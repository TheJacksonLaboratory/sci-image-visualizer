import { ATLAS_STYLE, labelClasses, labelSliceGeoJson } from './label-classes';
import type { LabelVolume } from './label-volume';

const allen = {
  msg: [
    {
      id: 997,
      acronym: 'root',
      name: 'root',
      color_hex_triplet: 'FFFFFF',
      graph_order: 0,
      children: [
        {
          id: 8,
          acronym: 'grey',
          name: 'Basic cell groups and regions',
          color_hex_triplet: 'bfdae3',
          graph_order: 1,
          children: [],
        },
      ],
    },
  ],
};

/** One 4 × 3 slice: label 8 on the left three columns, label 997 enclosed in it, 0 elsewhere. */
const slice: LabelVolume = {
  format: 'nrrd',
  width: 4,
  height: 3,
  slices: 1,
  sliceLabels: () => Uint32Array.from([8, 8, 8, 0, 8, 997, 8, 0, 8, 8, 8, 0]),
};

describe('labelClasses', () => {
  it("names an Allen structure graph's labels by acronym, with its tree and the atlas look", () => {
    const classes = labelClasses(allen);
    expect(classes.classOf(8)).toEqual({ name: 'grey', color: '#BFDAE3', title: 'Basic cell groups and regions' });
    expect(classes.hierarchy).toEqual([
      { name: 'root', title: 'root', color: '#FFFFFF', order: 0 },
      { name: 'grey', title: 'Basic cell groups and regions', parent: 'root', color: '#BFDAE3', order: 1 },
    ]);
    expect(classes.style).toEqual(ATLAS_STYLE);
    expect(classes.classOf(5).name).toBe('label 5');
  });

  it("names a region set's labels by their value (or a labels map), with its tree and style", () => {
    const classes = labelClasses({
      classHierarchy: [
        { name: 'Retina' },
        { name: 'ILM', parent: 'Retina', color: '#ff0000', value: 1 },
        { name: 'RPE', parent: 'Retina' },
      ],
      labels: { '2': 'RPE' },
      style: { fillOpacity: 0.3 },
    });
    expect(classes.classOf(1)).toEqual({ name: 'ILM', color: '#ff0000', title: undefined });
    expect(classes.classOf(2).name).toBe('RPE');
    expect(classes.hierarchy?.map((n) => n.name)).toEqual(['Retina', 'ILM', 'RPE']);
    expect(classes.style).toEqual({ fillOpacity: 0.3 });
  });

  it('names each label its own class without an ontology, a colour apiece', () => {
    const classes = labelClasses();
    expect(classes.classOf(3).name).toBe('label 3');
    expect(classes.classOf(3).color).toMatch(/^#[0-9A-F]{6}$/);
    expect(classes.classOf(3).color).not.toBe(classes.classOf(4).color);
    expect(classes.hierarchy).toBeUndefined();
  });
});

describe('labelSliceGeoJson', () => {
  it('traces each label of a slice into one feature, its holes kept, classified and with the tree', () => {
    const fc = JSON.parse(labelSliceGeoJson(slice, 0, labelClasses(allen)));
    expect(fc.classHierarchy.length).toBe(2);
    expect(fc.style).toEqual(ATLAS_STYLE);
    const byId = new Map(fc.features.map((f: { id: string }) => [f.id, f]));
    const grey = byId.get('8') as {
      geometry: { coordinates: number[][][][] };
      properties: { classification: unknown };
    };
    expect(grey.properties.classification).toEqual({ name: 'grey', color: [191, 218, 227] });
    // One piece, its outer ring around the 3 × 3 block and a hole where 997 is.
    expect(grey.geometry.coordinates.length).toBe(1);
    expect(grey.geometry.coordinates[0].length).toBe(2);
    const root = byId.get('997') as { geometry: { coordinates: number[][][][] } };
    expect(root.geometry.coordinates[0][0]).toEqual([
      [1, 1],
      [2, 1],
      [2, 2],
      [1, 2],
      [1, 1],
    ]);
  });
});
