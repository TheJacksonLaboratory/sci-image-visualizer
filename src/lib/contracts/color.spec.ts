import { hexToRgb, parseCssColor, rgbToHex } from './color';

describe('contracts/color', () => {
  describe('parseCssColor', () => {
    it.each([
      ['#ff8000', [255, 128, 0]],
      ['#FF8000', [255, 128, 0]],
      ['ff8000', [255, 128, 0]],
      ['#f80', [255, 136, 0]],
      ['f80', [255, 136, 0]],
      ['#ff800080', [255, 128, 0]],
      ['  #00ffff  ', [0, 255, 255]],
      ['rgb(8,29,88)', [8, 29, 88]],
      ['rgb( 8 , 29 , 88 )', [8, 29, 88]],
      ['RGB(8 29 88)', [8, 29, 88]],
      ['rgba(255, 0, 0, 0.5)', [255, 0, 0]],
      ['rgb(1.6, 300, -4)', [2, 255, 0]],
    ])('parses %j', (input, expected) => {
      expect(parseCssColor(input)).toEqual(expected);
    });

    it.each([
      [''],
      ['   '],
      ['red'],
      ['#12'],
      ['#12345'],
      ['#zzzzzz'],
      ['rgb(1,2)'],
      ['rgb(a,b,c)'],
      ['hsl(0, 100%, 50%)'],
      ['#1234567'],
    ])('rejects %j', (input) => {
      expect(parseCssColor(input)).toBeNull();
    });

    it('rejects null and undefined', () => {
      expect(parseCssColor(null)).toBeNull();
      expect(parseCssColor(undefined)).toBeNull();
    });
  });

  describe('rgbToHex', () => {
    it('formats lower-case #rrggbb', () => {
      expect(rgbToHex([255, 0, 0])).toBe('#ff0000');
      expect(rgbToHex([0, 255, 255])).toBe('#00ffff');
      expect(rgbToHex([1, 2, 3])).toBe('#010203');
    });

    it('rounds and clamps out-of-range channels', () => {
      expect(rgbToHex([300, -5, 127.6])).toBe('#ff0080');
    });

    it('round-trips through parseCssColor', () => {
      for (const hex of ['#000000', '#ffffff', '#43bce7', '#0a0b0c']) {
        expect(rgbToHex(parseCssColor(hex)!)).toBe(hex);
      }
    });
  });

  describe('hexToRgb', () => {
    it('parses hex forms only', () => {
      expect(hexToRgb('#00FFFF')).toEqual([0, 255, 255]);
      expect(hexToRgb('abc')).toEqual([170, 187, 204]);
      expect(hexToRgb('rgb(1,2,3)')).toBeNull();
      expect(hexToRgb(undefined)).toBeNull();
    });
  });
});
