import { defaultPresetSet, PresetSet } from '../models/class-preset';
import { Region } from '../models/region';
import {
  applyPresetColors, colorForLabel, fallbackColorFor, findPreset, hashString, hslToHex, normalizeLabel, presetKey,
} from './class-color.util';

describe('class-color.util (jit-ui#70 colour engine)', () => {
  const baseSet = (): PresetSet => ({
    classes: [
      { name: 'Tumor', color: '#FF4444' },
      { name: 'Stroma', color: '#44AAFF' },
    ],
    fallbackPalette: ['#111111', '#222222', '#333333'],
    autoPromote: false,
    matchMode: 'exact',
  });

  describe('normalizeLabel', () => {
    it('trims and lowercases; tolerates null/undefined', () => {
      expect(normalizeLabel('  Tumor ')).toBe('tumor');
      expect(normalizeLabel(undefined as unknown as string)).toBe('');
    });
  });

  describe('hashString', () => {
    it('is deterministic and non-negative', () => {
      expect(hashString('Mitosis')).toBe(hashString('Mitosis'));
      expect(hashString('Mitosis')).toBeGreaterThanOrEqual(0);
      expect(hashString('a')).not.toBe(hashString('b'));
    });
  });

  describe('findPreset', () => {
    it('matches exactly by default (case-sensitive)', () => {
      const set = baseSet();
      expect(findPreset('Tumor', set)?.color).toBe('#FF4444');
      expect(findPreset('tumor', set)).toBeUndefined();
      expect(findPreset('Unknown', set)).toBeUndefined();
    });
    it('matches case-insensitively when matchMode is normalized', () => {
      const set: PresetSet = { ...baseSet(), matchMode: 'normalized' };
      expect(findPreset('  tUMoR ', set)?.color).toBe('#FF4444');
    });
  });

  describe('fallbackColorFor', () => {
    it('is deterministic for a given name (same colour every call)', () => {
      const palette = baseSet().fallbackPalette;
      expect(fallbackColorFor('Necrosis', palette)).toBe(fallbackColorFor('Necrosis', palette));
    });
    it('indexes into the palette when one is provided', () => {
      const palette = ['#111111', '#222222', '#333333'];
      expect(palette).toContain(fallbackColorFor('anything', palette));
    });
    it('generates a valid hex colour when the palette is empty', () => {
      expect(fallbackColorFor('x', [])).toMatch(/^#[0-9A-F]{6}$/);
    });
    it('normalizes the key so case/whitespace do not change the colour', () => {
      const palette = ['#111111', '#222222', '#333333'];
      expect(fallbackColorFor(' Necrosis ', palette)).toBe(fallbackColorFor('necrosis', palette));
    });
  });

  describe('colorForLabel', () => {
    it('prefers a matching preset, else a stable fallback', () => {
      const set = baseSet();
      expect(colorForLabel('Tumor', set)).toBe('#FF4444');
      const unknown = colorForLabel('Mitosis', set);
      expect(set.fallbackPalette).toContain(unknown);
      expect(colorForLabel('Mitosis', set)).toBe(unknown); // stable across calls
    });
  });

  describe('defaultPresetSet', () => {
    it('seeds flat classes with exact matching and promotion off', () => {
      const set = defaultPresetSet();
      expect(set.matchMode).toBe('exact');
      expect(set.autoPromote).toBe(false);
      expect(set.classes.find((c) => c.name === 'Tumor')?.color).toBe('#FF4444');
      expect(set.fallbackPalette.length).toBeGreaterThan(0);
    });
  });
});

describe('presetKey / hslToHex', () => {
  it('compares names exactly or normalized per the match mode', () => {
    expect(presetKey({ matchMode: 'exact' }, ' Tumor ')).toBe(' Tumor ');
    expect(presetKey({ matchMode: 'normalized' }, ' Tumor ')).toBe('tumor');
  });

  it('converts HSL to upper-case hex', () => {
    expect(hslToHex(0, 100, 50)).toBe('#FF0000');
    expect(hslToHex(120, 100, 25)).toBe('#008000');
    expect(hslToHex(0, 0, 100)).toBe('#FFFFFF');
  });
});

describe('applyPresetColors', () => {
  const set = (over: Partial<PresetSet> = {}): PresetSet => ({
    classes: [{ name: 'Tumor', color: '#FF4444' }],
    fallbackPalette: ['#111111'],
    autoPromote: false,
    matchMode: 'exact',
    ...over,
  });
  const reg = (label?: string, color?: string, colorOverridden?: boolean): Region =>
    Object.assign(new Region(), { id: 1, label, color, colorOverridden });

  it('overrides a stale colour with the preset colour, copying the region', () => {
    const r = reg('Tumor', '#000000');
    const [out] = applyPresetColors([r], set());
    expect(out).not.toBe(r);
    expect(out.color).toBe('#FF4444');
    expect(r.color).toBe('#000000');
  });

  it('sets the colour in place for a region the caller owns', () => {
    const r = reg('Tumor');
    const [out] = applyPresetColors([r], set(), { inPlace: () => true });
    expect(out).toBe(r);
    expect(r.color).toBe('#FF4444');
  });

  it('keeps unlabelled, user-recoloured and already-right regions as the same instances', () => {
    const regions = [reg(undefined, '#000000'), reg('Tumor', '#000000', true), reg('Tumor', '#FF4444')];
    const out = applyPresetColors(regions, set());
    expect(out).not.toBe(regions);
    out.forEach((r, i) => expect(r).toBe(regions[i]));
  });

  it('gives an unknown class its fallback colour and promotes it once only with autoPromote', () => {
    const onPromote = jest.fn();
    applyPresetColors([reg('Stroma')], set(), { onPromote });
    expect(onPromote).not.toHaveBeenCalled();

    const out = applyPresetColors([reg(' Stroma '), reg('stroma')], set({ autoPromote: true, matchMode: 'normalized' }),
      { onPromote });
    expect(out[0].color).toBe('#111111');
    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(onPromote).toHaveBeenCalledWith({ name: 'Stroma', color: '#111111', source: 'auto' });
  });
});
