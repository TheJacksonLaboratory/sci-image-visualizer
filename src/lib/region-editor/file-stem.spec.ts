import { fileStem } from './file-stem';

describe('fileStem', () => {
  it('drops the last extension only', () => {
    expect(fileStem('slide.ome.tif', 'x')).toBe('slide.ome');
    expect(fileStem('image.png', 'x')).toBe('image');
  });

  it('keeps a name without an extension, or a dotfile, whole', () => {
    expect(fileStem('image', 'x')).toBe('image');
    expect(fileStem('.hidden', 'x')).toBe('.hidden');
  });

  it('uses the fallback for a missing name', () => {
    expect(fileStem(undefined, 'rois')).toBe('rois');
    expect(fileStem('', 'rois')).toBe('rois');
  });
});
