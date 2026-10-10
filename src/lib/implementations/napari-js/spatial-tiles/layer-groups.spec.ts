import { Viewer } from 'napari-js';
import type { ShapesLayer } from 'napari-js';

import type { SpatialPolygons } from '../../../contracts/spatial-dataset.contract';
import { OrderedLayerGroups } from './layer-groups';

describe('OrderedLayerGroups', () => {
  const square: SpatialPolygons = {
    count: 1, coords: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]), offsets: new Uint32Array([0, 4]),
  };

  function setup() {
    const viewer = new Viewer({ canvas: document.createElement('canvas') });
    const groups = new OrderedLayerGroups<'low' | 'mid' | 'high'>(['low', 'mid', 'high']);
    groups.attach(viewer);
    const removals: unknown[] = [];
    viewer.layers.removed.connect((l) => removals.push(l));
    const names = () => viewer.layers.items.map((l) => l.name);
    return { viewer, groups, removals, names };
  }

  it('restores the order once, re-adding from the first layer out of place', () => {
    const { viewer, groups, removals, names } = setup();
    groups.replace('low', viewer.addPoints(new Float32Array(2), { name: 'low' }));
    groups.replace('high', viewer.addPoints(new Float32Array(2), { name: 'high' }));
    groups.replace('mid', viewer.addPoints(new Float32Array(2), { name: 'mid' }));
    groups.restoreOrder(false);
    expect(names()).toEqual(['low', 'mid', 'high']);
    expect(removals.map((l) => (l as { name: string }).name)).toEqual(['mid', 'high']); // 'low' kept
    groups.restoreOrder(false); // already in order: nothing moves
    expect(removals).toHaveLength(2);
  });

  it('puts its layers back above a layer that is not its own, on request', () => {
    const { viewer, groups, names } = setup();
    groups.replace('low', viewer.addPoints(new Float32Array(2), { name: 'low' }));
    viewer.addPoints(new Float32Array(2), { name: 'markers' });
    groups.restoreOrder(false);
    expect(names()).toEqual(['low', 'markers']);
    groups.restoreOrder(true);
    expect(names()).toEqual(['markers', 'low']);
  });

  it('restyles a shapes layer in place unless its geometry changed', () => {
    const { viewer, groups } = setup();
    groups.upsertShapes('low', true, true, square, { name: 'cells', draw: 'fill', color: [1, 0, 0, 1] });
    const first = viewer.layers.items[0] as ShapesLayer;
    groups.upsertShapes('low', true, false, square, { name: 'cells', draw: 'fill', color: [0, 1, 0, 1], opacity: 0.3 });
    expect(viewer.layers.items).toEqual([first]);
    expect(first.opacity).toBe(0.3);
    groups.upsertShapes('low', true, true, square, { name: 'cells', draw: 'fill', color: [0, 0, 1, 1] });
    expect(viewer.layers.items).toHaveLength(1);
    expect(viewer.layers.items[0]).not.toBe(first);
  });

  it('drops a group (layer and key), owns only its layers, and lets go of all on detach', () => {
    const { viewer, groups } = setup();
    const low = viewer.addPoints(new Float32Array(2), { name: 'low' });
    const other = viewer.addPoints(new Float32Array(2), { name: 'other' });
    groups.replace('low', low);
    groups.setKey('low', 'k');
    expect(groups.owns(low)).toBe(true);
    expect(groups.owns(other)).toBe(false);
    expect(groups.shown('low')).toBe(true);
    groups.upsertShapes('mid', false, true, square, { name: 'x' }); // not wanted: dropped
    expect(groups.has('mid')).toBe(false);
    groups.drop('low');
    expect(groups.key('low')).toBeUndefined();
    expect(viewer.layers.items).toEqual([other]);
    groups.replace('high', viewer.addPoints(new Float32Array(2), { name: 'high' }));
    groups.detach();
    expect(viewer.layers.items).toEqual([other]);
    expect(groups.viewer).toBeNull();
  });
});
