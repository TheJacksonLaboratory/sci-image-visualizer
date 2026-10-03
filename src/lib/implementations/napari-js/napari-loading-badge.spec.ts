import { NapariLoadingBadge, SHOW_AFTER_MS } from './napari-loading-badge';

describe('NapariLoadingBadge', () => {
  let host: HTMLElement;
  let badge: NapariLoadingBadge;
  const el = () => host.querySelector('.napari-loading-badge') as HTMLElement;

  beforeEach(() => {
    jest.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    badge = new NapariLoadingBadge(host);
  });
  afterEach(() => {
    badge.destroy();
    host.remove();
    jest.useRealTimers();
  });

  it('names every layer loading, after a short delay so cached redraws do not flash it', () => {
    badge.set(['Transcripts']);
    expect(el().style.display).toBe('none');
    jest.advanceTimersByTime(SHOW_AFTER_MS);
    expect(el().style.display).toBe('block');
    expect(el().textContent).toBe('Transcripts reloading…');
    badge.set(['Observations', 'Cells', 'Transcripts']);
    expect(el().textContent).toBe('Observations, cells and transcripts reloading…');
  });

  it('hides when nothing is loading, and never shows for a load faster than the delay', () => {
    badge.set(['Cells']);
    badge.set([]);
    jest.advanceTimersByTime(SHOW_AFTER_MS * 2);
    expect(el().style.display).toBe('none');
    expect(badge.text).toBe('');
  });

  it('sits at the bottom of the canvas, over it, and lets the pointer through', () => {
    expect(el().style.position).toBe('absolute');
    expect(el().style.bottom).toBe('12px');
    expect(el().style.pointerEvents).toBe('none');
    expect(el().getAttribute('role')).toBe('status');
  });
});
