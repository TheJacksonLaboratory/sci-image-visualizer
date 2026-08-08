import {
  YOLO_MODELS,
  DEFAULT_YOLO_MODEL_ID,
  getYoloModel,
  isYoloModelReady,
  setYoloModelUrls,
  setDefaultYoloModel,
  getDefaultYoloModelId,
} from './yolo-model-registry';

describe('yolo-model-registry', () => {
  // The registry is module-level mutable state (by design — a host repoints it
  // once at init), so each test restores what it changed.
  const original = YOLO_MODELS.map((m) => ({ ...m, defaults: { ...m.defaults } }));

  afterEach(() => {
    YOLO_MODELS.forEach((m, i) => {
      m.modelUrl = original[i].modelUrl;
      m.metaUrl = original[i].metaUrl;
    });
    setDefaultYoloModel(DEFAULT_YOLO_MODEL_ID);
  });

  it('registers the four published checkpoints', () => {
    expect(YOLO_MODELS.map((m) => m.id)).toEqual([
      'yolov8x-seg-opticnerve',
      'yolov8x-seg-retina',
      'yolov8x-seg-embryo-m2',
      'yolov8x-seg-embryo-m3',
    ]);
  });

  it('points at the fp16w weights, never the true-fp16 variant', () => {
    // fp16w is fp16 storage with fp32 compute. True fp16 accumulates in half
    // precision on WebGPU and produces wrong boxes at this model scale.
    for (const m of YOLO_MODELS) {
      expect(m.modelUrl).toContain('model.fp16w.onnx');
      expect(m.modelUrl).not.toContain('/model.fp16.onnx');
    }
  });

  it('gives the embryo models their heavier overlap and looser merge defaults', () => {
    const optic = getYoloModel('yolov8x-seg-opticnerve')!;
    const embryo = getYoloModel('yolov8x-seg-embryo-m2')!;

    expect(optic.defaults).toEqual({
      confidence: 0.6,
      iouThreshold: 0.5,
      mergeThreshold: 0.3,
      overlapX: 0,
      overlapY: 0,
    });
    expect(embryo.defaults).toEqual({
      confidence: 0.6,
      iouThreshold: 0.8,
      mergeThreshold: 0.8,
      overlapX: 60,
      overlapY: 60,
    });
  });

  it('does not share a defaults object between models', () => {
    const m2 = getYoloModel('yolov8x-seg-embryo-m2')!;
    const m3 = getYoloModel('yolov8x-seg-embryo-m3')!;
    expect(m2.defaults).not.toBe(m3.defaults);
  });

  it('returns undefined for an unknown id', () => {
    expect(getYoloModel('nope')).toBeUndefined();
  });

  it('repoints a model at different hosting', () => {
    setYoloModelUrls('yolov8x-seg-retina', {
      modelUrl: 'https://example.org/retina.onnx',
      metaUrl: 'https://example.org/retina.json',
    });
    const m = getYoloModel('yolov8x-seg-retina')!;
    expect(m.modelUrl).toBe('https://example.org/retina.onnx');
    expect(m.metaUrl).toBe('https://example.org/retina.json');
  });

  it('treats an empty url as disabling the model', () => {
    expect(isYoloModelReady('yolov8x-seg-retina')).toBe(true);
    setYoloModelUrls('yolov8x-seg-retina', { modelUrl: '' });
    expect(isYoloModelReady('yolov8x-seg-retina')).toBe(false);
  });

  it('ignores repointing an unknown id rather than throwing', () => {
    expect(() => setYoloModelUrls('nope', { modelUrl: 'x' })).not.toThrow();
  });

  it('changes the default model, ignoring unknown ids', () => {
    expect(getDefaultYoloModelId()).toBe(DEFAULT_YOLO_MODEL_ID);

    setDefaultYoloModel('yolov8x-seg-embryo-m3');
    expect(getDefaultYoloModelId()).toBe('yolov8x-seg-embryo-m3');

    setDefaultYoloModel('nope');
    expect(getDefaultYoloModelId()).toBe('yolov8x-seg-embryo-m3');
  });
});
