const fromPretrained = jest.fn();
jest.mock(
  'cellpose-js',
  () => ({
    Cellpose: { fromPretrained: (...args: unknown[]) => fromPretrained(...args) },
    configureOrt: jest.fn(),
  }),
  { virtual: true },
); // the ESM-only package doesn't resolve under jest's CommonJS resolver

import { ModelResidency } from './model-residency';
import { CellposeSegmenterService } from '../toolbar/segmentation/cellpose-segmenter.service';
import { SamSessionService } from '../toolbar/segmentation/sam-session.service';
import { setSamModelUrls } from '../toolbar/segmentation/sam-model-registry';
import { ISamSession, SamEmbedding } from '../contracts/sam.contract';

/** A large model owned by some other package (e.g. jit-extensions' retinal VNet). */
function otherLargeModel(r: ModelResidency) {
  const release = jest.fn();
  r.register({ id: 'retinal:vnet', loadedSizeMb: 6000, release });
  return release;
}

function fakeCellpose() {
  return {
    dispose: jest.fn(async () => undefined),
    segment: jest.fn(async () => ({ masks: new Uint32Array(4), width: 2, height: 2, count: 1 })),
  };
}

function fakeSam(): ISamSession {
  return {
    loadModel: jest.fn(async () => undefined),
    isLoaded: () => true,
    dispose: jest.fn(),
    embed: jest.fn(
      async (): Promise<SamEmbedding> => ({
        data: new Float32Array(1),
        dims: [1],
        scale: 1,
        imageWidth: 2,
        imageHeight: 2,
      }),
    ),
    decode: jest.fn(),
  };
}

const image = { data: new Uint8ClampedArray(16), width: 2, height: 2 };

describe('Cellpose under the model-residency rule', () => {
  let r: ModelResidency;
  let svc: CellposeSegmenterService;

  beforeEach(() => {
    fromPretrained.mockReset();
    r = new ModelResidency();
    svc = new CellposeSegmenterService(r);
  });

  it('releases another large model before loading, then registers itself', async () => {
    const releaseVnet = otherLargeModel(r);
    fromPretrained.mockResolvedValue(fakeCellpose());

    await svc.segmentCells(image);

    expect(releaseVnet).toHaveBeenCalled();
    expect(r.residentModels()).toEqual([{ id: svc.residencyId(), loadedSizeMb: expect.any(Number) }]);
    expect(r.residentModels()[0].loadedSizeMb).toBeGreaterThanOrEqual(r.getThresholdMb());
  });

  it('stays warm across repeated runs', async () => {
    fromPretrained.mockResolvedValue(fakeCellpose());
    await svc.segmentCells(image);
    await svc.segmentCells(image);
    expect(fromPretrained).toHaveBeenCalledTimes(1);
  });

  it('is released when another model is used, and rebuilt on its next run', async () => {
    const first = fakeCellpose();
    const second = fakeCellpose();
    fromPretrained.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await svc.segmentCells(image);

    await r.use('yolo:opticnerve', async () => undefined);
    expect(first.dispose).toHaveBeenCalled();
    expect(svc.isLoaded()).toBe(false);

    await svc.segmentCells(image);
    expect(fromPretrained).toHaveBeenCalledTimes(2);
    expect(second.segment).toHaveBeenCalled();
  });

  it('a switch waits for a Cellpose run in progress instead of disposing under it', async () => {
    let finishRun!: () => void;
    const cp = fakeCellpose();
    cp.segment.mockImplementation(
      () =>
        new Promise((res) => {
          finishRun = () => res({ masks: new Uint32Array(4), width: 2, height: 2, count: 1 });
        }),
    );
    fromPretrained.mockResolvedValue(cp);

    const run = svc.segmentCells(image);
    await new Promise((res) => setTimeout(res, 0));
    const switching = r.use('yolo:opticnerve', async () => undefined);
    await new Promise((res) => setTimeout(res, 0));
    expect(cp.dispose).not.toHaveBeenCalled();

    finishRun();
    await Promise.all([run, switching]);
    expect(cp.dispose).toHaveBeenCalled();
  });

  it('forgets the registration when the model URL changes', async () => {
    fromPretrained.mockResolvedValue(fakeCellpose());
    await svc.getModel();
    const oldId = svc.residencyId();

    svc.setModelUrl('https://example.org/other.onnx');

    expect(r.isResident(oldId)).toBe(false);
  });
});

describe('SAM under the model-residency rule', () => {
  let r: ModelResidency;
  let svc: SamSessionService;

  beforeEach(() => {
    setSamModelUrls('microsam-vit-b-lm', 'enc-b', 'dec-b');
    r = new ModelResidency();
    svc = new SamSessionService(r);
    svc.setModel('microsam-vit-b-lm');
    svc.useSessionFactory(async () => fakeSam());
  });

  it('releases another large model before loading, and stays warm below the threshold', async () => {
    const releaseVnet = otherLargeModel(r);

    await svc.ensureSession();

    expect(releaseVnet).toHaveBeenCalled();
    const [sam] = r.residentModels();
    expect(sam.id).toBe('sam:microsam-vit-b-lm');
    expect(sam.loadedSizeMb).toBeLessThan(r.getThresholdMb());

    // Below the threshold: using another model leaves SAM loaded.
    await r.use('yolo:opticnerve', async () => undefined);
    expect(svc.hasSession()).toBe(true);
  });

  it('is released (and rebuilt next time) when it is above the threshold', async () => {
    r.setThresholdMb(100);
    const session = await svc.ensureSession();

    await r.use('retinal:vnet', async () => undefined);

    expect(session.dispose).toHaveBeenCalled();
    expect(svc.hasSession()).toBe(false);
  });

  it('forgets the registration on a model switch', async () => {
    await svc.ensureSession();
    setSamModelUrls('microsam-vit-t-lm', 'enc-t', 'dec-t');

    svc.setModel('microsam-vit-t-lm');

    expect(r.isResident('sam:microsam-vit-b-lm')).toBe(false);
  });
});
