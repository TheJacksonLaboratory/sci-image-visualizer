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

  it('ships hosted ONNX URLs by default, and a model is "ready" only with both URLs', () => {
    const id = SAM_MODELS[0].id;
    // Snapshot the baked-in URLs as strings (setSamModelUrls mutates the entry).
    const enc = getSamModel(id).encoderUrl;
    const dec = getSamModel(id).decoderUrl;
    // URLs are baked in, so models are ready out of the box.
    expect(isSamModelReady(getSamModel(id))).toBe(true);
    expect(enc).toMatch(/^https?:\/\//);
    expect(dec).toMatch(/^https?:\/\//);
    // Clearing a URL (host opting out) marks it not ready…
    setSamModelUrls(id, '', '');
    expect(isSamModelReady(getSamModel(id))).toBe(false);
    // …and re-pointing it makes it ready again.
    setSamModelUrls(id, enc, dec);
    expect(isSamModelReady(getSamModel(id))).toBe(true);
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
