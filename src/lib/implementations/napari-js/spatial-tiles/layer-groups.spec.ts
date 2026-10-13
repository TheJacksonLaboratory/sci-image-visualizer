import { Viewer } from 'napari-js';
import type { ShapesLayer } from 'napari-js';

import type { SpatialPolygons } from '../../../contracts/spatial-dataset.contract';
import { OrderedLayerGroups } from './layer-groups';

describe('OrderedLayerGroups', () => {
  const square: SpatialPolygons = {
    count: 1,
    coords: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]),
    offsets: new Uint32Array([0, 4]),
  };

  function setup() {
    const viewer = new Viewer({ canvas: document.createElement('canvas') });
    const groups = new OrderedLayerGroups<'low' | 'mid' | 'high'>(['low', 'mid', 'high']);
    groups.attach(viewer);
    const names = () => viewer.layers.items.map((l) => l.name);
    /** Every layer-list event from here on, so a spec can tell a restack from a re-add. */
    const events: string[] = [];
    const name = (l: { name: string }) => l.name;
    viewer.layers.removed.connect((l) => events.push(`removed ${name(l)}`));
    viewer.layers.added.connect((l) => events.push(`added ${name(l)}`));
    viewer.layers.moved.connect((m) => events.push(`moved ${name(m.layer)}`));
    return { viewer, groups, names, events };
  }

  it('restores the order once, moving from the first layer out of place', () => {
    const { viewer, groups, names, events } = setup();
    groups.replace('low', viewer.addPoints(new Float32Array(2), { name: 'low' }));
    groups.replace('high', viewer.addPoints(new Float32Array(2), { name: 'high' }));
    groups.replace('mid', viewer.addPoints(new Float32Array(2), { name: 'mid' }));
    const layers = [...viewer.layers.items];
    events.length = 0;
    groups.restoreOrder(false);
    expect(names()).toEqual(['low', 'mid', 'high']);
    // A restack, not a remove + re-add: the layers stay mounted, so their GPU visuals are kept
    // (NAPARI-BOUNDARY-11). 'low' is already in place, and 'mid', on top already, ends up
    // in place once 'high' goes over it.
    expect(events).toEqual(['moved high']);
    expect(new Set(viewer.layers.items)).toEqual(new Set(layers));
    groups.restoreOrder(false); // already in order: nothing moves
    expect(events).toHaveLength(1);
  });

  it('puts its layers back above a layer that is not its own, on request', () => {
    const { viewer, groups, names, events } = setup();
    const low = viewer.addPoints(new Float32Array(2), { name: 'low' });
    groups.replace('low', low);
    viewer.addPoints(new Float32Array(2), { name: 'markers' });
    groups.restoreOrder(false);
    expect(names()).toEqual(['low', 'markers']);
    events.length = 0;
    groups.restoreOrder(true);
    expect(names()).toEqual(['markers', 'low']);
    expect(events).toEqual(['moved low']);
    expect(viewer.layers.items[1]).toBe(low);
  });

  it('restyles a shapes layer in place unless its geometry changed', () => {
    const { viewer, groups } = setup();
    groups.upsertShapes('low', true, true, square, { name: 'cells', draw: 'fill', color: [1, 0, 0, 1] });
    const first = viewer.layers.items[0] as ShapesLayer;
    groups.upsertShapes('low', true, false, square, {
      name: 'cells',
      draw: 'fill',
      color: [0, 1, 0, 1],
      opacity: 0.3,
    });
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
