import { SegmentationToolsComponent } from './segmentation-tools.component';
import { ToolbarToolContribution } from '../../contracts/toolbar-tool.contract';

/** A contributed tool with two checkpoints, enough to exercise the menu. */
function contributedTool(): ToolbarToolContribution {
  return {
    id: 'detect',
    label: 'Detect',
    icon: { pi: 'pi-search' },
    runTooltip: 'Detect things',
    models: () => [
      { id: 'model-a', label: 'A', info: 'the first one' },
      { id: 'model-b', label: 'B', info: 'the second one' },
    ],
    defaultModelId: () => 'model-a',
    params: [],
    defaultParams: () => ({}),
    progress: { status$: null as never, busy$: null as never, progress$: null as never },
    run: async () => 0,
  };
}

describe('SegmentationToolsComponent — model menus', () => {
  let tools: SegmentationToolsComponent;
  beforeEach(() => { tools = new SegmentationToolsComponent(); });

  it('carries each SAM model description on its menu item as `tooltip`', () => {
    tools.samModels = [{ id: 'microsam-vit-t-lm', label: 'micro-sam ViT-T' }];
    tools.samModelId = 'microsam-vit-t-lm';
    tools.ngOnChanges({ samModels: {} as never });

    // The item template turns `tooltip` into the hover info icon, so an empty
    // one would silently drop the icon rather than fail.
    expect(tools.samMenuItems[0].tooltip).toContain('TinyViT');
    // Active model still marked, and selecting still emits.
    expect(tools.samMenuItems[0].icon).toBe('pi pi-check');
  });

  it('builds a contributed tool\'s menu from the tool\'s own model info', () => {
    // Contributed tools describe their own checkpoints: this library ships no
    // copy for models it does not know about, so the description must come off
    // the contribution rather than out of MODEL_INFO.
    tools.contributedTools = [contributedTool()];
    tools.toolModelIds = { detect: 'model-b' };
    tools.ngOnChanges({ contributedTools: {} as never });

    const items = tools.toolMenuItems['detect']!;
    expect(items[0].tooltip).toContain('the first one');
    expect(items[1].icon).toBe('pi pi-check');
    expect(items[0].icon).toBe('pi pi-fw');
  });

  it('emits the tool id alongside the model when a contributed model is picked', () => {
    // Without the id the host cannot tell which tool's parameters to re-seed.
    tools.contributedTools = [contributedTool()];
    tools.ngOnChanges({ contributedTools: {} as never });
    const picked: { toolId: string; modelId: string }[] = [];
    tools.toolModelChange.subscribe((e) => picked.push(e));

    tools.toolMenuItems['detect']![1].command!({} as never);

    expect(picked).toEqual([{ toolId: 'detect', modelId: 'model-b' }]);
  });

  it('leaves `tooltip` undefined for a model with no description', () => {
    tools.samModels = [{ id: 'some-unregistered-model', label: 'Unknown' }];
    tools.ngOnChanges({ samModels: {} as never });
    expect(tools.samMenuItems[0].tooltip).toBeUndefined();
  });
});

describe('SegmentationToolsComponent — model info accessibility', () => {
  it('strips markup so a screen reader does not announce tags', () => {
    // The copy is written for a visual tooltip rendered with [escape]="false",
    // so it carries <b> and <br>. Passed to aria-label verbatim those get read
    // out literally.
    const c = new SegmentationToolsComponent();

    const out = c.plainText('<b>VNet 2D</b><br>~590&nbsp;MB download &amp; 6&times; slower.');

    expect(out).toBe('VNet 2D. ~590 MB download & 6x slower.');
    expect(out).not.toMatch(/[<>]/);
  });

  it('survives an empty or missing description', () => {
    const c = new SegmentationToolsComponent();
    expect(c.plainText('')).toBe('');
    expect(c.plainText(undefined as never)).toBe('');
  });
});
