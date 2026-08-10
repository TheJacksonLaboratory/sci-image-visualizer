import {
  RETINAL_MODELS,
  DEFAULT_RETINAL_MODEL_ID,
  getRetinalModel,
  isRetinalModelReady,
  readyRetinalModels,
  setRetinalModelUrls,
  setDefaultRetinalModel,
  getDefaultRetinalModelId,
} from './retinal-model-registry';

describe('retinal model registry', () => {
  const originals = RETINAL_MODELS.map((m) => ({ ...m }));

  afterEach(() => {
    // The registry is module-level mutable state by design (hosts repoint it at
    // app init), so restore it or one test's repoint leaks into the next.
    RETINAL_MODELS.forEach((m, i) => Object.assign(m, originals[i]));
    setDefaultRetinalModel(DEFAULT_RETINAL_MODEL_ID);
  });

  it('ships VNet enabled — the most accurate against the shipped masks', () => {
    expect(isRetinalModelReady('vnet-2d-retinal')).toBe(true);
    expect(getRetinalModel('vnet-2d-retinal')?.miou).toBeGreaterThan(0.9);
  });

  it('ships the 20x and 40x ResUNet-a checkpoints enabled', () => {
    // They are gated on port fidelity (argmax-identical to the Keras models the
    // server runs), not on mIoU — see the registry header.
    for (const id of ['resunet-a-2d-retinal-20x', 'resunet-a-2d-retinal-40x']) {
      expect(isRetinalModelReady(id)).toBe(true);
      expect(getRetinalModel(id)?.unavailableReason).toBeUndefined();
    }
  });

  it('runs the 20x checkpoint at 256, the only size its graph accepts', () => {
    // Not 128: that raises inside a dilated conv, and 128-content resampled to
    // 256 scores 0.19 against 0.31 for plain half-scale.
    expect(getRetinalModel('resunet-a-2d-retinal-20x')?.patchSize).toBe(256);
    expect(getRetinalModel('resunet-a-2d-retinal-40x')?.patchSize).toBe(512);
  });

  it('keeps the superseded base checkpoint listed but disabled', () => {
    // Listed rather than deleted so a host can show it as unavailable instead
    // of pretending the server's choice does not exist.
    expect(getRetinalModel('resunet-a-2d-retinal')).toBeDefined();
    expect(isRetinalModelReady('resunet-a-2d-retinal')).toBe(false);
    expect(getRetinalModel('resunet-a-2d-retinal')?.unavailableReason).toMatch(/superseded/i);
  });

  it('offers only the runnable models to a host', () => {
    expect(readyRetinalModels().map((m) => m.id)).toEqual([
      'vnet-2d-retinal',
      'resunet-a-2d-retinal-40x',
      'resunet-a-2d-retinal-20x',
    ]);
  });

  it('lets a host enable a disabled model by supplying weights', () => {
    setRetinalModelUrls('resunet-a-2d-retinal', { modelUrl: 'https://example.test/model.onnx' });

    expect(isRetinalModelReady('resunet-a-2d-retinal')).toBe(true);
    // Supplying weights answers the question the reason describes, so it must
    // not keep claiming the model is unavailable.
    expect(getRetinalModel('resunet-a-2d-retinal')?.unavailableReason).toBeUndefined();
  });

  it('disables a model again when given an empty url', () => {
    setRetinalModelUrls('vnet-2d-retinal', { modelUrl: '' });
    expect(isRetinalModelReady('vnet-2d-retinal')).toBe(false);
  });

  it('keeps the reason when the supplied url is only whitespace', () => {
    // Whitespace leaves the model just as disabled, so clearing the reason
    // would strip the one explanation the user gets while the model still
    // cannot run.
    setRetinalModelUrls('resunet-a-2d-retinal', { modelUrl: '   ' });

    expect(isRetinalModelReady('resunet-a-2d-retinal')).toBe(false);
    expect(getRetinalModel('resunet-a-2d-retinal')?.unavailableReason).toMatch(/superseded/i);
  });

  it('keeps the reason when only metaUrl is supplied', () => {
    setRetinalModelUrls('resunet-a-2d-retinal', { metaUrl: 'https://example.test/model.json' });

    expect(isRetinalModelReady('resunet-a-2d-retinal')).toBe(false);
    expect(getRetinalModel('resunet-a-2d-retinal')?.unavailableReason).toMatch(/superseded/i);
  });

  it('ignores an unknown id rather than throwing', () => {
    expect(() => setRetinalModelUrls('nope', { modelUrl: 'x' })).not.toThrow();
    expect(getRetinalModel('nope')).toBeUndefined();
  });

  it('only accepts a known id as the default', () => {
    setDefaultRetinalModel('nope');
    expect(getDefaultRetinalModelId()).toBe(DEFAULT_RETINAL_MODEL_ID);

    setDefaultRetinalModel('resunet-a-2d-retinal');
    expect(getDefaultRetinalModelId()).toBe('resunet-a-2d-retinal');
  });
});
