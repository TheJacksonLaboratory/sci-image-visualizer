import {
  SAM_MODELS, DEFAULT_SAM_MODEL_ID, getSamModel, isSamModelReady, setSamModelUrls,
  getDefaultSamModelId, setDefaultSamModel,
} from './sam-model-registry';

describe('sam-model-registry', () => {
  it('exposes at least one micro-sam model and a default id', () => {
    expect(SAM_MODELS.length).toBeGreaterThan(0);
    expect(getSamModel(DEFAULT_SAM_MODEL_ID).id).toBe(DEFAULT_SAM_MODEL_ID);
  });

  it('getSamModel falls back to the default for unknown/absent ids', () => {
    expect(getSamModel('nope').id).toBe(SAM_MODELS[0].id);
    expect(getSamModel().id).toBe(SAM_MODELS[0].id);
  });

  it('models are not "ready" until both ONNX URLs are configured', () => {
    const id = SAM_MODELS[0].id;
    expect(isSamModelReady(getSamModel(id))).toBe(false);
    setSamModelUrls(id, 'https://x/encoder.onnx', 'https://x/decoder.onnx');
    expect(isSamModelReady(getSamModel(id))).toBe(true);
    // reset so other suites see the unconfigured default
    setSamModelUrls(id, '', '');
    expect(isSamModelReady(getSamModel(id))).toBe(false);
  });

  it('configuring a model makes it the active default (so getSamModel() returns it)', () => {
    expect(getDefaultSamModelId()).toBe(SAM_MODELS[0].id);
    const second = SAM_MODELS[Math.min(1, SAM_MODELS.length - 1)].id;
    setSamModelUrls(second, 'https://x/encoder.onnx', 'https://x/decoder.onnx');
    expect(getDefaultSamModelId()).toBe(second);
    expect(getSamModel().id).toBe(second);
    // reset
    setSamModelUrls(second, '', '');
    setDefaultSamModel(SAM_MODELS[0].id);
  });
});
