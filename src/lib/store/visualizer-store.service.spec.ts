import { GIST_NCAR_LUT } from 'napari-js/colormaps';
import { IImageMetadata } from '../contracts/image.contract';
import { VisualizerStore } from './visualizer-store.service';
import {
  DEFAULT_VISIBLE_CHANNELS,
  defaultChannelVisible,
  IChannelState,
} from '../contracts/channel-histogram-api.contract';

/**
 * Pins the "Reset" baseline behaviour of the Channels & Histogram pane: resetting
 * a channel must restore its display window AND gamma AND its default tint colour
 * (not just min/max), so a colour the user changed snaps back on reset. The store
 * is constructed directly (no preferences port).
 */
describe('VisualizerStore.resetChannelState', () => {
  // channelCount>1 with rgbChannels==1 → one tinted channel per band, default
  // palette #ff0000/#00ff00/#0000ff (see deriveChannels).
  const meta = [{ channelCount: 3, rgbChannels: 1, x: 100, y: 100, z: 1 }] as any;

  it('restores window, gamma AND the default tint colour', () => {
    const store = new VisualizerStore();
    store.setImageMeta(meta);
    expect(store.currentChannelStates()[0].color).toBe('#ff0000');

    store.setChannelState(0, { color: '#123456', min: 10, max: 200, gamma: 2 });
    expect(store.currentChannelStates()[0].color).toBe('#123456');

    store.resetChannelState(0);
    expect(store.currentChannelStates()[0]).toMatchObject({
      color: '#ff0000',
      min: 0,
      max: 255,
      gamma: 1,
    });
  });

  it('only resets the targeted channel', () => {
    const store = new VisualizerStore();
    store.setImageMeta(meta);
    store.setChannelState(1, { color: '#abcdef', min: 50, max: 150 });

    store.resetChannelState(0);

    const states = store.currentChannelStates();
    expect(states[0].color).toBe('#ff0000'); // reset to default
    expect(states[1].color).toBe('#abcdef'); // untouched
    expect(states[1].min).toBe(50);
  });

  it('falls back to neutral defaults when no image baseline was captured', () => {
    const store = new VisualizerStore();
    const seed: IChannelState = {
      index: 0,
      name: 'X',
      color: '#abcabc',
      min: 5,
      max: 9,
      gamma: 3,
      visible: true,
    };
    store.setChannelStates([seed]);

    store.resetChannelState(0);

    expect(store.currentChannelStates()[0]).toMatchObject({
      color: '#ffffff',
      min: 0,
      max: 255,
      gamma: 1,
    });
  });
});

describe('VisualizerStore.setPhysicalPixelSize', () => {
  function latestMeta(store: VisualizerStore): any[] {
    let meta: any[] = [];
    store.getImageMeta().subscribe((m) => (meta = m));
    return meta;
  }

  it('patches mpp onto the current meta and re-emits (for unscaled file-info)', () => {
    const store = new VisualizerStore();
    store.setImageMeta([{ channelCount: 1, rgbChannels: 1 }] as any);
    store.setPhysicalPixelSize(0.5, 0.5);
    const meta = latestMeta(store);
    expect(meta[0].mppX).toBe(0.5);
    expect(meta[0].mppY).toBe(0.5);
    expect(meta[0].channelCount).toBe(1); // existing fields preserved
  });

  it('does not change the derived channel count (no clobber)', () => {
    const store = new VisualizerStore();
    store.setImageMeta([{ channelCount: 3, rgbChannels: 1 }] as any);
    store.setChannelState(0, { color: '#123456' });
    store.setPhysicalPixelSize(0.5, 0.5);
    expect(store.currentChannelStates()[0].color).toBe('#123456'); // edits survive
    expect(store.currentChannelStates().length).toBe(3);
  });

  it('is a no-op when neither axis is positive', () => {
    const store = new VisualizerStore();
    store.setImageMeta([{ channelCount: 1, rgbChannels: 1 }] as any);
    store.setPhysicalPixelSize(0, undefined);
    expect(latestMeta(store)[0].mppX).toBeUndefined();
  });
});

/**
 * Preset set accessors must not leak the store's internal state: getPresetSet()
 * returns a defensive copy and normalizePresetSet() (via setPresetSet) clones the
 * caller's arrays, so outside mutation can't desync presetSet$/persistence
 * (jit-ui#70, Copilot review).
 */
describe('VisualizerStore preset-set isolation', () => {
  it('getPresetSet() returns a defensive copy (mutating it leaves the store intact)', () => {
    const store = new VisualizerStore();
    const got = store.getPresetSet();
    const before = store.getPresetSet().classes.length;
    got.classes.push({ name: 'Injected', color: '#000000' });
    got.fallbackPalette.push('#abcdef');
    expect(store.getPresetSet().classes.length).toBe(before);
    expect(store.getPresetSet().classes.some((c) => c.name === 'Injected')).toBe(false);
  });

  it('setPresetSet() clones caller arrays (later mutation does not reach the store)', () => {
    const store = new VisualizerStore();
    const incoming = {
      classes: [{ name: 'Tumor', color: '#FF0000' }],
      fallbackPalette: ['#111111'],
      autoPromote: false,
      matchMode: 'exact' as const,
    };
    store.setPresetSet(incoming);
    incoming.classes.push({ name: 'Sneaky', color: '#00FF00' });
    incoming.classes[0].name = 'Renamed';
    expect(store.getPresetSet().classes.map((c) => c.name)).toEqual(['Tumor']);
  });
});

/**
 * The pane-selected channel drives a single-scalar 3D Surface (jit-ui#76). It
 * defaults to 0, dedups, emits to subscribers, and resets when the channel
 * structure changes (a new image with a different band count).
 */
describe('VisualizerStore.selectedChannel', () => {
  it('defaults to 0, updates on set, and resets on a new channel structure', () => {
    const store = new VisualizerStore();
    expect(store.currentSelectedChannel()).toBe(0);

    store.setImageMeta([{ channelCount: 4, rgbChannels: 1, x: 8, y: 8, z: 1 }] as any);
    store.setSelectedChannel(2);
    expect(store.currentSelectedChannel()).toBe(2);

    // a different band count resets the selection to 0
    store.setImageMeta([{ channelCount: 2, rgbChannels: 1, x: 8, y: 8, z: 1 }] as any);
    expect(store.currentSelectedChannel()).toBe(0);
  });

  it('emits to subscribers and dedups repeat sets', () => {
    const store = new VisualizerStore();
    const seen: number[] = [];
    const sub = store.getSelectedChannel().subscribe((i) => seen.push(i));
    store.setSelectedChannel(3);
    store.setSelectedChannel(3); // deduped
    sub.unsubscribe();
    expect(seen).toEqual([0, 3]); // initial + one change
  });
});

describe('VisualizerStore.setImageMeta channel re-derivation (CORE-8)', () => {
  const fluo = (names: string[]): IImageMetadata[] => [
    {
      channelCount: names.length,
      rgbChannels: 1,
      x: 10,
      y: 10,
      z: 1,
      channelInfo: names.map((name) => ({ name })),
    } as IImageMetadata,
  ];

  it("keeps the user's window edits on a re-plot of the SAME image", () => {
    const store = new VisualizerStore();
    store.setImageMeta(fluo(['DAPI', 'GFP', 'RFP']), 'a.tif');
    store.setChannelState(1, { min: 20, max: 180 });
    store.setImageMeta(fluo(['DAPI', 'GFP', 'RFP']), 'a.tif');
    expect(store.currentChannelStates()[1]).toMatchObject({ name: 'GFP', min: 20, max: 180 });
  });

  it('re-derives names, tints and windows for a DIFFERENT image with the same channel count', () => {
    const store = new VisualizerStore();
    store.setImageMeta(fluo(['DAPI', 'GFP', 'RFP']), 'a.tif');
    store.setChannelState(1, { min: 20, max: 180 });
    store.setSelectedChannel(2);
    store.setImageMeta(fluo(['CD3', 'CD8', 'PanCK']), 'b.tif');
    expect(store.currentChannelStates().map((c) => c.name)).toEqual(['CD3', 'CD8', 'PanCK']);
    expect(store.currentChannelStates()[1]).toMatchObject({ min: 0, max: 255 });
    expect(store.currentSelectedChannel()).toBe(0);
  });

  it('an RGB image followed by a 3-channel fluorescence image drops Red/Green/Blue', () => {
    const store = new VisualizerStore();
    store.setImageMeta([{ rgbChannels: 3, channelCount: 1, x: 1, y: 1, z: 1 } as IImageMetadata], 'rgb.png');
    store.setImageMeta(fluo(['DAPI', 'GFP', 'RFP']), 'fluo.tif');
    expect(store.currentChannelStates()[0].name).toBe('DAPI');
  });
});

describe('VisualizerStore colormap options (NAPARI-BOUNDARY-23)', () => {
  it("carries matplotlib's tables inline, from napari-js/colormaps, with no asset to fetch", () => {
    const leaves = new VisualizerStore()
      .getColormapOptions()
      .flatMap((g: { children?: { label: string; data: { value: unknown } }[] }) => g.children ?? []);
    // Every leaf is usable at once: an inline scale, or a Plotly built-in name.
    for (const leaf of leaves) expect(String(leaf.data.value)).not.toMatch(/_LUT$/);
    const ncar = leaves.find((c: { label: string }) => c.label === 'gist_ncar')!.data.value as [number, string][];
    expect(ncar).toHaveLength(256);
    expect(ncar[0]).toEqual([0, `rgb(${GIST_NCAR_LUT[0]}, ${GIST_NCAR_LUT[1]}, ${GIST_NCAR_LUT[2]})`]);
    expect(ncar[255]).toEqual([1, `rgb(${GIST_NCAR_LUT[765]}, ${GIST_NCAR_LUT[766]}, ${GIST_NCAR_LUT[767]})`]);
  });
});

/**
 * A multichannel image starts with only its first DEFAULT_VISIBLE_CHANNELS visible: each
 * visible channel draws from tiles of its own, so a 22-channel plate asked for 22 tiles per
 * position on every pan and zoom.
 */
describe('VisualizerStore default channel visibility', () => {
  const plate = (count: number, info?: IImageMetadata['channelInfo']): IImageMetadata[] => [
    { channelCount: count, rgbChannels: 1, x: 10, y: 10, z: 1, channelInfo: info } as IImageMetadata,
  ];
  const visible = (store: VisualizerStore) => store.currentChannelStates().map((c) => c.visible);

  it('shows every channel of an image with at most DEFAULT_VISIBLE_CHANNELS', () => {
    const store = new VisualizerStore();
    store.setImageMeta(plate(DEFAULT_VISIBLE_CHANNELS));
    expect(visible(store)).toEqual(Array(DEFAULT_VISIBLE_CHANNELS).fill(true));
  });

  it('shows only the first DEFAULT_VISIBLE_CHANNELS of a 22-channel plate', () => {
    const store = new VisualizerStore();
    store.setImageMeta(plate(22));
    const v = visible(store);
    expect(v.filter(Boolean)).toHaveLength(DEFAULT_VISIBLE_CHANNELS);
    expect(v.slice(0, DEFAULT_VISIBLE_CHANNELS).every(Boolean)).toBe(true);
  });

  it('keeps a visibility the image specifies', () => {
    const store = new VisualizerStore();
    const info = Array.from({ length: 6 }, (_, i) => ({ name: `c${i}`, color: '', visible: i === 5 }));
    store.setImageMeta(plate(6, info));
    expect(visible(store)).toEqual([false, false, false, false, false, true]);
  });

  it('a hidden channel can be shown, and a re-plot of the same image keeps it shown', () => {
    const store = new VisualizerStore();
    store.setImageMeta(plate(22), 'plate.ome.tif');
    store.setChannelState(10, { visible: true });
    store.setImageMeta(plate(22), 'plate.ome.tif');
    expect(store.currentChannelStates()[10].visible).toBe(true);
  });

  it.each([2, 3, 4])('shows every channel of a %i-channel image, as before', (count) => {
    const store = new VisualizerStore();
    store.setImageMeta(plate(count));
    expect(visible(store)).toEqual(Array(count).fill(true));
  });

  it('shows the one channel of a grayscale image, and of one with no channel count', () => {
    const one = new VisualizerStore();
    one.setImageMeta(plate(1));
    expect(visible(one)).toEqual([true]);
    const unknown = new VisualizerStore();
    unknown.setImageMeta([{ rgbChannels: 1, x: 10, y: 10, z: 1 } as IImageMetadata]);
    expect(visible(unknown)).toEqual([true]);
  });

  it('hides from the fifth channel on, once there are more than DEFAULT_VISIBLE_CHANNELS', () => {
    const store = new VisualizerStore();
    store.setImageMeta(plate(DEFAULT_VISIBLE_CHANNELS + 1));
    expect(visible(store)).toEqual([...Array(DEFAULT_VISIBLE_CHANNELS).fill(true), false]);
  });

  it('shows every channel of a few-channel image whose channelInfo is partial or says nothing', () => {
    const store = new VisualizerStore();
    // A descriptor that names one channel of three, and sends an empty visibility for it.
    const info = [{ name: 'DAPI', color: '#0000ff', visible: null as unknown as boolean }];
    store.setImageMeta(plate(3, info));
    expect(visible(store)).toEqual([true, true, true]);
  });

  it('leaves RGB and RGBA channels visible', () => {
    const rgba = new VisualizerStore();
    rgba.setImageMeta([{ rgbChannels: 4, channelCount: 1, x: 1, y: 1, z: 1 } as IImageMetadata]);
    expect(visible(rgba)).toEqual([true, true, true]);
  });

  it('leaves RGB channels visible', () => {
    const store = new VisualizerStore();
    store.setImageMeta([{ rgbChannels: 3, channelCount: 1, x: 1, y: 1, z: 1 } as IImageMetadata]);
    expect(visible(store)).toEqual([true, true, true]);
  });
});

describe('defaultChannelVisible', () => {
  it('shows the first DEFAULT_VISIBLE_CHANNELS of many, and every channel of few', () => {
    expect(defaultChannelVisible(DEFAULT_VISIBLE_CHANNELS - 1, 22)).toBe(true);
    expect(defaultChannelVisible(DEFAULT_VISIBLE_CHANNELS, 22)).toBe(false);
    expect(defaultChannelVisible(DEFAULT_VISIBLE_CHANNELS - 1, DEFAULT_VISIBLE_CHANNELS)).toBe(true);
  });

  it('an image-specified visibility wins either way', () => {
    expect(defaultChannelVisible(20, 22, true)).toBe(true);
    expect(defaultChannelVisible(0, 2, false)).toBe(false);
  });

  it('shows every channel of up to DEFAULT_VISIBLE_CHANNELS', () => {
    for (let count = 1; count <= DEFAULT_VISIBLE_CHANNELS; count++) {
      for (let i = 0; i < count; i++) expect(defaultChannelVisible(i, count)).toBe(true);
    }
  });

  it('treats an empty (null) visibility as unspecified', () => {
    expect(defaultChannelVisible(1, 3, null)).toBe(true);
    expect(defaultChannelVisible(10, 22, null)).toBe(false);
  });
});

/**
 * Channel names and tints from the tile descriptor: a host's image meta (jit-ui's /metadata)
 * carries none, so the Channels pane showed "Channel 1", "Channel 2"… for an OME-TIFF that
 * names every channel.
 */
describe('VisualizerStore.adoptChannelInfo', () => {
  const meta = (count: number, info?: IImageMetadata['channelInfo']): IImageMetadata[] => [
    { channelCount: count, rgbChannels: 1, x: 10, y: 10, z: 1, channelInfo: info } as IImageMetadata,
  ];
  const named = [
    { name: 'Mitochondria', color: '#00ffff' },
    { name: 'Cell-Membrane', color: '#00ff00' },
    { name: 'Nucleus', color: '#0000ff' },
  ];

  it("names the channels from the descriptor when the host's meta has none", () => {
    const store = new VisualizerStore();
    store.setImageMeta(meta(3), 'plate.ome.tif');
    expect(store.currentChannelStates().map((c) => c.name)).toEqual(['Channel 1', 'Channel 2', 'Channel 3']);
    store.adoptChannelInfo(named);
    expect(store.currentChannelStates().map((c) => c.name)).toEqual(['Mitochondria', 'Cell-Membrane', 'Nucleus']);
    expect(store.currentChannelStates().map((c) => c.color)).toEqual(['#00ffff', '#00ff00', '#0000ff']);
  });

  it("keeps the host's own names, and a name or tint edited in the pane", () => {
    const store = new VisualizerStore();
    store.setImageMeta(meta(3, [{ name: 'DAPI', color: '#ffffff' }] as IImageMetadata['channelInfo']), 'img');
    store.setChannelState(1, { color: '#ff8800' });
    store.adoptChannelInfo(named);
    const s = store.currentChannelStates();
    expect(s.map((c) => c.name)).toEqual(['DAPI', 'Cell-Membrane', 'Nucleus']);
    expect(s[0].color).toBe('#ffffff');
    expect(s[1].color).toBe('#ff8800');
  });

  it('leaves the visibility alone', () => {
    const store = new VisualizerStore();
    store.setImageMeta(meta(6), 'plate');
    const before = store.currentChannelStates().map((c) => c.visible);
    store.adoptChannelInfo(Array.from({ length: 6 }, (_, i) => ({ name: `c${i}`, color: '#ffffff' })));
    expect(store.currentChannelStates().map((c) => c.visible)).toEqual(before);
  });

  it('takes the groups the descriptor puts the channels in, even for a channel the pane edited', () => {
    const store = new VisualizerStore();
    store.setImageMeta(meta(3), 'plate');
    store.setChannelState(0, { color: '#ff8800' });
    store.adoptChannelInfo([
      { ...named[0], group: ['Cell Paint'] },
      { ...named[1], group: ['Cell Paint'] },
      { ...named[2], group: null },
    ]);
    const s = store.currentChannelStates();
    expect(s.map((c) => c.group)).toEqual([['Cell Paint'], ['Cell Paint'], undefined]);
    expect(s[0].color).toBe('#ff8800');
  });

  it("replaces or clears an earlier descriptor's groups, names and tints with a later one's", () => {
    const store = new VisualizerStore();
    store.setImageMeta(meta(2), 'plate');
    store.adoptChannelInfo([
      { name: 'A', color: '#ff0000', group: ['Old panel'] },
      { name: 'B', color: '#ff0000', group: ['Old panel'] },
    ]);
    store.adoptChannelInfo([
      { name: 'A2', color: '#00ff00', group: ['New panel'] },
      { name: 'B2', color: '#00ff00', group: null },
    ]);
    const s = store.currentChannelStates();
    expect(s.map((c) => c.group)).toEqual([['New panel'], undefined]);
    expect(s.map((c) => c.name)).toEqual(['A2', 'B2']);
    expect(s.map((c) => c.color)).toEqual(['#00ff00', '#00ff00']);
    let info: IImageMetadata['channelInfo'];
    store.getImageMeta().subscribe((m) => (info = m[0].channelInfo));
    expect(info?.map((c) => c.group)).toEqual([['New panel'], null]);
  });

  it("keeps the host's own group over every descriptor's", () => {
    const store = new VisualizerStore();
    store.setImageMeta(
      meta(2, [{ name: 'A', color: '#ffffff', group: ['Host'] }] as IImageMetadata['channelInfo']),
      'img',
    );
    store.adoptChannelInfo([
      { name: 'A', group: ['Old panel'] },
      { name: 'B', group: ['Old panel'] },
    ]);
    store.adoptChannelInfo([
      { name: 'A', group: ['New panel'] },
      { name: 'B', group: ['New panel'] },
    ]);
    expect(store.currentChannelStates().map((c) => c.group)).toEqual([['Host'], ['New panel']]);
  });

  it("derives the groups from the host's own channel info", () => {
    const store = new VisualizerStore();
    store.setImageMeta(
      meta(2, [
        { name: 'A', color: '#ffffff', group: ['Protein IF', 'Cell Signaling'] },
        { name: 'B', color: '#ffffff' },
      ] as IImageMetadata['channelInfo']),
      'img',
    );
    expect(store.currentChannelStates().map((c) => c.group)).toEqual([
      ['Protein IF', 'Cell Signaling'],
      undefined,
    ]);
  });

  it('ignores a descriptor of another channel count, and an RGB image', () => {
    const store = new VisualizerStore();
    store.setImageMeta(meta(2), 'two');
    store.adoptChannelInfo(named);
    expect(store.currentChannelStates().map((c) => c.name)).toEqual(['Channel 1', 'Channel 2']);
    const rgb = new VisualizerStore();
    rgb.setImageMeta([{ rgbChannels: 3, channelCount: 1, x: 1, y: 1, z: 1 } as IImageMetadata]);
    rgb.adoptChannelInfo(named);
    expect(rgb.currentChannelStates().map((c) => c.name)).toEqual(['Red', 'Green', 'Blue']);
  });
});
