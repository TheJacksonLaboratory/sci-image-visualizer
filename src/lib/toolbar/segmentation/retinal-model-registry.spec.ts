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

  it('ships VNet enabled — it is the only checkpoint that matches its masks', () => {
    // mIoU 0.9061 vs 0.27-0.31 for the ResUNet-a variants.
    expect(isRetinalModelReady('vnet-2d-retinal')).toBe(true);
    expect(getRetinalModel('vnet-2d-retinal')?.miou).toBeGreaterThan(0.9);
  });

  it('keeps the ResUNet-a checkpoints listed but disabled', () => {
    // Listed rather than deleted so a host can show them as unavailable instead
    // of pretending the server's choice does not exist.
    for (const id of ['resunet-a-2d-retinal', 'resunet-a-2d-retinal-20x', 'resunet-a-2d-retinal-40x']) {
      expect(getRetinalModel(id)).toBeDefined();
      expect(isRetinalModelReady(id)).toBe(false);
      expect(getRetinalModel(id)?.unavailableReason).toMatch(/mIoU/);
    }
  });

  it('offers only the runnable models to a host', () => {
    expect(readyRetinalModels().map((m) => m.id)).toEqual(['vnet-2d-retinal']);
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
