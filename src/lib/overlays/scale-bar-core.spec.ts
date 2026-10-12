import { formatUm } from './scale-bar-core';

describe('scale-bar-core', () => {
  it('formats µm lengths in the unit that suits them', () => {
    expect(formatUm(0.01)).toBe('10 nm');
    expect(formatUm(2.5)).toBe('2.5 µm');
    expect(formatUm(500)).toBe('500 µm');
    expect(formatUm(2000)).toBe('2 mm');
    expect(formatUm(2e4)).toBe('2 cm');
    expect(formatUm(3e6)).toBe('3 m');
  });
});
