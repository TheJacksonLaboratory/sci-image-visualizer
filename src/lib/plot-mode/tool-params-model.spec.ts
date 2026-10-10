import { ToolParamsModel } from './tool-params-model';
import { ToolbarToolContribution } from '../contracts/toolbar-tool.contract';

describe('ToolParamsModel', () => {
  /** A tool whose checkpoint overrides two of the tool's baseline values. */
  function tool(): ToolbarToolContribution {
    return {
      id: 'detect',
      label: 'Detect',
      icon: { pi: 'pi-search' },
      runTooltip: 'run',
      models: () => [
        { id: 'crowded', label: 'Crowded', defaults: { overlapX: 60, confidence: 0.8 } },
        { id: 'sparse', label: 'Sparse', defaults: { overlapX: 0 } },
      ],
      defaultModelId: () => 'crowded',
      params: [
        { id: 'confidence', label: 'Confidence', type: 'number' },
        { id: 'overlapX', label: 'Overlap X', type: 'number' },
        { id: 'minArea', label: 'Min area', type: 'number' },
      ],
      defaultParams: () => ({ confidence: 0.6, overlapX: 0, minArea: 0 }),
      progress: { status$: null as never, busy$: null as never, progress$: null as never },
      run: async () => 0,
    };
  }

  const modelWith = (t: ToolbarToolContribution): ToolParamsModel => new ToolParamsModel([t]);

  it('applies the active checkpoint defaults on the FIRST use, not just after a switch', () => {
    // The bug this pins: the first seed called defaultParams directly and
    // skipped the per-model merge, so a tool's opening run used the tool's
    // baseline tiling and thresholds instead of the checkpoint's — and looked
    // correct the moment the user touched the model picker.
    const c = modelWith(tool());

    const p = c.paramsFor('detect');

    expect(p['overlapX']).toBe(60);
    expect(p['confidence']).toBe(0.8);
    expect(p['minArea']).toBe(0); // tool baseline still applies where the model is silent
  });

  it('re-seeds from the newly picked checkpoint', () => {
    const c = modelWith(tool());
    c.paramsFor('detect');

    c.setModel('detect', 'sparse');

    expect(c.paramsFor('detect')['overlapX']).toBe(0);
    // 'sparse' overrides only overlapX, so confidence falls back to the tool's.
    expect(c.paramsFor('detect')['confidence']).toBe(0.6);
  });

  it('Reset returns to the same values a first use would have produced', () => {
    const c = modelWith(tool());
    const first = { ...c.paramsFor('detect') };
    c.paramsFor('detect')['overlapX'] = 5;

    c.reset('detect');

    expect(c.paramsFor('detect')).toEqual(first);
  });
  it('builds the parameter dialog model once on open, not per change-detection pass (CORE-22)', () => {
    const c = modelWith(tool());
    c.open('detect');
    const open = c.openParams!;
    expect(open.tool.id).toBe('detect');
    expect(open.fields.map((f) => f.spec.id)).toEqual(['confidence', 'overlapX', 'minArea']);
    expect(open.fields[0].number).toBe(open.fields[0].spec); // narrowed once, here
    expect(open.values).toBe(c.paramsFor('detect'));

    // A reset or checkpoint switch while the dialog is open re-binds it to the new values.
    c.reset('detect');
    expect(c.openParams!.values).toBe(c.paramsFor('detect'));
    c.setModel('detect', 'sparse');
    expect(c.openParams!.values['overlapX']).toBe(0);

    c.close();
    expect(c.openParams).toBeNull();
  });
});
