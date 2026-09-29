import {
  ToolbarDialogToolContribution,
  ToolbarToolContribution,
  dialogToolContributions,
  isDialogToolContribution,
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

function dialogTool(id: string, over: Partial<ToolbarDialogToolContribution> = {}): ToolbarDialogToolContribution {
  return {
    kind: 'dialog',
    id,
    label: id,
    icon: { pi: 'pi-pencil' },
    tooltip: `open ${id}`,
    activate: () => ({ deactivate: () => undefined }),
    mount: () => () => undefined,
    ...over,
  };
}

describe('dialog tools on TOOLBAR_TOOLS', () => {
  it('visibleToolContributions leaves dialog tools out, without calling models()', () => {
    const tools = [tool('yolo'), dialogTool('dianne')];
    expect(visibleToolContributions(tools).map((t) => t.id)).toEqual(['yolo']);
  });

  it('dialogToolContributions keeps only dialog tools, in order', () => {
    const tools = [
      dialogTool('b', { order: 200 }),
      tool('yolo'),
      dialogTool('a', { order: 100 }),
      dialogTool('c', { order: 200 }),
    ];
    expect(dialogToolContributions(tools).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a malformed or repeated dialog tool with a warning', () => {
    const log = { warn: jest.fn() };
    const tools = [
      dialogTool('ok'),
      dialogTool('ok'),
      dialogTool('', {}),
      dialogTool('no-mount', { mount: undefined as never }),
      dialogTool('no-activate', { activate: undefined as never }),
    ];
    expect(dialogToolContributions(tools, log).map((t) => t.id)).toEqual(['ok']);
    expect(log.warn).toHaveBeenCalledTimes(4);
  });

  it('treats an unregistered token as no dialog tools', () => {
    expect(dialogToolContributions(null)).toEqual([]);
    expect(dialogToolContributions(undefined)).toEqual([]);
  });

  it('isDialogToolContribution tells the two kinds apart', () => {
    expect(isDialogToolContribution(dialogTool('d'))).toBe(true);
    expect(isDialogToolContribution(tool('r'))).toBe(false);
    expect(isDialogToolContribution(null)).toBe(false);
  });
});
