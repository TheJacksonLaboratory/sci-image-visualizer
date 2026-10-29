import { DEFAULT_SPATIAL_VIEW } from '../../../contracts/display-types';
import { colorViewFor } from './transcript-layers';

describe('colorViewFor', () => {
  const by = (transcriptColorBy: 'cellType' | 'gene' | 'cluster') => ({
    ...DEFAULT_SPATIAL_VIEW,
    transcriptColorBy,
  });

  it('colours all-gene bins by cell type, whatever is chosen: they mix genes', () => {
    expect(colorViewFor(by('gene'), 'bins', false, true).transcriptColorBy).toBe('cellType');
    expect(colorViewFor(by('cluster'), 'bins', false, false).transcriptColorBy).toBe('cellType');
  });

  it('colours density-grid markers by cluster, having no cells', () => {
    expect(colorViewFor(by('cellType'), 'genes', true, true).transcriptColorBy).toBe('cluster');
  });

  it('colours by gene when asked for cell types the dataset does not have', () => {
    expect(colorViewFor(by('cellType'), 'individual', false, false).transcriptColorBy).toBe('gene');
    expect(colorViewFor(by('cellType'), 'genes', false, false).transcriptColorBy).toBe('gene');
    expect(colorViewFor(by('cellType'), 'individual', false, true).transcriptColorBy).toBe('cellType');
  });
});
