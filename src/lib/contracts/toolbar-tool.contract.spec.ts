import {
  ToolbarToolContribution,
  sortToolContributions,
  visibleToolContributions,
} from './toolbar-tool.contract';

/** Minimal contribution; override the bits a test cares about. */
function tool(id: string, over: Partial<ToolbarToolContribution> = {}): ToolbarToolContribution {
  return {
    id,
    label: id,
    icon: { pi: 'pi-cog' },
    runTooltip: `run ${id}`,
    models: () => [{ id: `${id}-a`, label: 'A' }],
    defaultModelId: () => `${id}-a`,
    params: [],
    defaultParams: () => ({}),
    progress: { status$: null as never, busy$: null as never, progress$: null as never },
    run: async () => 0,
    ...over,
  };
}

describe('visibleToolContributions', () => {
  it('hides a tool whose model list is empty', () => {
    // This is the switch a deployment uses for "the weights are not configured
    // here" — it must not require unregistering the provider, because the
    // provider is what supplies the help text and the params too.
    const tools = [tool('yolo'), tool('retinal', { models: () => [] })];

    expect(visibleToolContributions(tools).map((t) => t.id)).toEqual(['yolo']);
  });

  it('treats an unregistered token as no tools rather than throwing', () => {
    // TOOLBAR_TOOLS has no factory on purpose: an open build registers nothing,
    // and injecting it {optional: true} yields null.
    expect(visibleToolContributions(null)).toEqual([]);
    expect(visibleToolContributions(undefined)).toEqual([]);
  });
});

describe('sortToolContributions', () => {
  it('orders by `order`, lowest first', () => {
    const tools = [tool('c', { order: 300 }), tool('a', { order: 100 }), tool('b', { order: 200 })];

    expect(sortToolContributions(tools).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps registration order for ties, so provider order breaks them', () => {
    // Without this a host has to invent distinct numbers to get a predictable
    // toolbar; with it, listing the providers in the wanted order is enough.
    const tools = [tool('first', { order: 100 }), tool('second', { order: 100 })];

    expect(sortToolContributions(tools).map((t) => t.id)).toEqual(['first', 'second']);
  });

  it('defaults a tool with no `order` to 100, after the built-in prompted tools', () => {
    const tools = [tool('unordered'), tool('early', { order: 50 }), tool('late', { order: 150 })];

    expect(sortToolContributions(tools).map((t) => t.id)).toEqual(['early', 'unordered', 'late']);
  });

  it('does not mutate the input array', () => {
    // It arrives straight from DI as a multi-provider array; sorting in place
    // would reorder it for every other injector of the same token.
    const tools = [tool('b', { order: 200 }), tool('a', { order: 100 })];
    const before = tools.map((t) => t.id);

    sortToolContributions(tools);

    expect(tools.map((t) => t.id)).toEqual(before);
  });
});
