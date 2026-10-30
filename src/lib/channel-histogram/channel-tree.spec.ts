import { IChannelState } from '../contracts/channel-histogram-api.contract';
import { channelTreeRows, hasChannelGroups } from './channel-tree';

const ch = (index: number, name: string, group?: string[], visible = true): IChannelState => ({
  index,
  name,
  color: '#ffffff',
  min: 0,
  max: 255,
  gamma: 1,
  visible,
  ...(group ? { group } : {}),
});

/** Channels as a Cytos plate groups them: cell paint, then proteins by panel. */
const PLATE = [
  ch(0, 'Mitochondria', ['Cell Paint']),
  ch(1, 'Nucleus', ['Cell Paint'], false),
  ch(2, 'Mouse_IgG', ['Protein IF']),
  ch(3, 'GM130', ['Protein IF', 'Expanded Morphology']),
  ch(4, 'ERp57', ['Protein IF', 'Expanded Morphology'], false),
  ch(5, 'Histone', ['Protein IF', 'Alternative Morphology']),
  ch(6, 'Bkg_GRN_CP01', ['Cell Paint', 'Bkg']),
  ch(7, 'Loose'),
];

describe('channelTreeRows', () => {
  it('lists each group where its first channel is, with what is in it below', () => {
    const rows = channelTreeRows(PLATE);
    expect(
      rows.map((r) =>
        r.kind === 'group' ? `${'  '.repeat(r.depth)}[${r.label}]` : `${'  '.repeat(r.depth)}${r.channel.name}`,
      ),
    ).toEqual([
      '[Cell Paint]',
      '  Mitochondria',
      '  Nucleus',
      '  [Bkg]',
      '    Bkg_GRN_CP01',
      '[Protein IF]',
      '  Mouse_IgG',
      '  [Expanded Morphology]',
      '    GM130',
      '    ERp57',
      '  [Alternative Morphology]',
      '    Histone',
      'Loose',
    ]);
  });

  it('counts the channels of a group at any depth, and those shown', () => {
    const rows = channelTreeRows(PLATE);
    const protein = rows.find((r) => r.kind === 'group' && r.label === 'Protein IF');
    expect(protein).toMatchObject({ channels: [2, 3, 4, 5], shown: 3, expanded: true });
    const cell = rows.find((r) => r.kind === 'group' && r.label === 'Cell Paint');
    expect(cell).toMatchObject({ channels: [0, 1, 6], shown: 2 });
  });

  it('hides what a folded group holds, by its key', () => {
    const key = channelTreeRows(PLATE).find((r) => r.kind === 'group' && r.label === 'Protein IF')!.key;
    const rows = channelTreeRows(PLATE, new Set([key]));
    expect(rows.some((r) => r.kind === 'channel' && r.channel.name === 'GM130')).toBe(false);
    expect(rows.find((r) => r.key === key)).toMatchObject({
      kind: 'group',
      expanded: false,
      channels: [2, 3, 4, 5],
    });
    expect(rows.some((r) => r.kind === 'channel' && r.channel.name === 'Loose')).toBe(true);
  });

  it('is the flat list of channels when none is in a group', () => {
    const flat = [ch(0, 'DAPI'), ch(1, 'GFP')];
    expect(hasChannelGroups(flat)).toBe(false);
    expect(hasChannelGroups(PLATE)).toBe(true);
    expect(channelTreeRows(flat).map((r) => r.kind)).toEqual(['channel', 'channel']);
  });
});
