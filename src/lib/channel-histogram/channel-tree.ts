import { IChannelState } from '../contracts/channel-histogram-api.contract';

/** A group of channels in the Channels pane: its label, how many channels it holds, how many show. */
export interface ChannelGroupRow {
  kind: 'group';
  /** The group's path, its labels joined: stable across emissions, so it keys the row and its folding. */
  key: string;
  label: string;
  depth: number;
  /** The channels below it, at any depth, by index. */
  channels: number[];
  /** How many of them are visible. */
  shown: number;
  expanded: boolean;
}

/** A channel in the Channels pane, below its groups. */
export interface ChannelRow {
  kind: 'channel';
  key: string;
  depth: number;
  channel: IChannelState;
}

export type ChannelTreeRow = ChannelGroupRow | ChannelRow;

/** Joins a group path's labels into its key. */
const SEP = '\u0001';

/** Whether any channel says which group it is in. */
export function hasChannelGroups(channels: readonly IChannelState[]): boolean {
  return channels.some((c) => !!c.group?.length);
}

interface Node {
  label: string;
  key: string;
  /** Groups and channels, in the order their first channel comes. */
  items: (Node | IChannelState)[];
}

/**
 * The Channels pane's rows: each group (as the image's metadata groups its channels, outermost
 * first) followed by what is in it, in channel order — a group where its first channel is — and
 * the channels in no group where they are. A group in `collapsed` (by key) hides what is in it.
 */
export function channelTreeRows(
  channels: readonly IChannelState[],
  collapsed: ReadonlySet<string> = new Set(),
): ChannelTreeRow[] {
  const root: Node = { label: '', key: '', items: [] };
  const groups = new Map<string, Node>();
  for (const ch of channels) {
    let parent = root;
    for (const label of ch.group ?? []) {
      const key = parent.key ? parent.key + SEP + label : label;
      let node = groups.get(key);
      if (!node) {
        node = { label, key, items: [] };
        groups.set(key, node);
        parent.items.push(node);
      }
      parent = node;
    }
    parent.items.push(ch);
  }
  const rows: ChannelTreeRow[] = [];
  const visit = (node: Node, depth: number): void => {
    for (const item of node.items) {
      if ('items' in item) {
        const members = channelsIn(item);
        rows.push({
          kind: 'group',
          key: item.key,
          label: item.label,
          depth,
          channels: members.map((c) => c.index),
          shown: members.filter((c) => c.visible).length,
          expanded: !collapsed.has(item.key),
        });
        if (!collapsed.has(item.key)) visit(item, depth + 1);
      } else {
        rows.push({ kind: 'channel', key: `channel${SEP}${item.index}`, depth, channel: item });
      }
    }
  };
  visit(root, 0);
  return rows;
}

/** Every channel below a group, at any depth. */
function channelsIn(node: Node): IChannelState[] {
  const out: IChannelState[] = [];
  for (const item of node.items) {
    if ('items' in item) out.push(...channelsIn(item));
    else out.push(item);
  }
  return out;
}
