import { defaultPresetSet, PresetSet } from '../models/class-preset';
import { colorForLabel, fallbackColorFor, findPreset, hashString, normalizeLabel } from './class-color.util';

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
