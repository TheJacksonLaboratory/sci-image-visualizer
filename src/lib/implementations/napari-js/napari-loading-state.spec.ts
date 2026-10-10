import { LoadingBadgeState } from './napari-loading-state';

describe('LoadingBadgeState', () => {
  let state: LoadingBadgeState;

  beforeEach(() => {
    state = new LoadingBadgeState();
    state.attach(document.createElement('div'));
  });

  it("names every source still loading, the service's own first", () => {
    const image = state.begin('Image');
    state.setTileLayers(['Transcripts']);
    const obs = state.begin('Observations');
    expect(state.text).toBe('Image, observations and transcripts reloading…');
    image();
    obs();
    state.setTileLayers([]);
    expect(state.text).toBe('');
  });

  it('counts overlapping loads of one source, and ends each once', () => {
    const a = state.begin('Image');
    const b = state.begin('Image');
    a();
    a();
    expect(state.text).toBe('Image reloading…');
    b();
    expect(state.text).toBe('');
  });

  it("a load that settles after a reset leaves the new scene's count alone", () => {
    // Regression: the observation counter was zeroed by a re-plot and then decremented by the
    // old scene's colouring as it settled, so the new scene's next load counted from -1 and its
    // "Observations reloading…" never showed.
    const stale = state.begin('Observations');
    state.reset();
    state.attach(document.createElement('div'));
    stale();
    const fresh = state.begin('Observations');
    expect(state.text).toBe('Observations reloading…');
    fresh();
    expect(state.text).toBe('');
  });
});
