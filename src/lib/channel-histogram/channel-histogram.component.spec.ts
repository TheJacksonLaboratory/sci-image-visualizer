import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { of } from 'rxjs';

import * as Plotly from 'plotly.js-dist-min';
import { ChannelHistogramComponent } from './channel-histogram.component';
import {
  CHANNEL_HISTOGRAM_API, IChannelHistogramApi, IChannelState,
} from '../contracts/channel-histogram-api.contract';

jest.mock('plotly.js-dist-min', () => ({ react: jest.fn(), relayout: jest.fn(), purge: jest.fn() }));

describe('ChannelHistogramComponent', () => {
  let component: ChannelHistogramComponent;
  let fixture: ComponentFixture<ChannelHistogramComponent>;
  let api: jest.Mocked<IChannelHistogramApi>;

  const channels: IChannelState[] = [
    { index: 0, name: 'Intensity', color: '#ffffff', min: 0, max: 255, gamma: 1, visible: true },
  ];

  beforeEach(async () => {
    api = {
      getChannels$: jest.fn(() => of(channels)),
      setChannelState: jest.fn(),
      autoContrast: jest.fn(),
      resetContrast: jest.fn(),
      getHistogram: jest.fn(() => ({ bins: [0, 1], counts: [3, 7], max: 7 })),
      getHistogram$: jest.fn(() => of({ bins: [0, 1], counts: [3, 7], max: 7 })),
      getColormap: jest.fn(() => of({ label: 'Greys Inv' })),
      setColormap: jest.fn(),
      getColormapOptions: jest.fn(() => []),
      getReverseScale: jest.fn(() => of(false)),
      setReverseScale: jest.fn(),
      getGrayscale$: jest.fn(() => of(false)),
      setGrayscale: jest.fn(),
      getInvert$: jest.fn(() => of(false)),
      setInvert: jest.fn(),
      getImageMeta: jest.fn(() => of([])),
      exportComposite: jest.fn(),
      exportData: jest.fn(),
    } as unknown as jest.Mocked<IChannelHistogramApi>;

    await TestBed.configureTestingModule({
      declarations: [ChannelHistogramComponent],
      imports: [FormsModule],
      providers: [{ provide: CHANNEL_HISTOGRAM_API, useValue: api }],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(ChannelHistogramComponent);
    component = fixture.componentInstance;
    component.ngOnInit();
  });

  it('should create and seed channels from the API', () => {
    expect(component).toBeTruthy();
    expect(component.channels.length).toBe(1);
    expect(component.selected?.name).toBe('Intensity');
  });

  it('should route a min/max edit through the API (clamped, ordered)', () => {
    component.onMinChange(300); // clamps to 255, then max stays ≥ min
    expect(api.setChannelState).toHaveBeenCalledWith(0, { min: 255, max: 255 });
  });

  it('should route gamma + auto + reset through the API', () => {
    component.onGammaChange(2.2);
    expect(api.setChannelState).toHaveBeenCalledWith(0, { gamma: 2.2 });
    component.auto();
    expect(api.autoContrast).toHaveBeenCalledWith([0], 0.001);
    component.reset();
    expect(api.resetContrast).toHaveBeenCalledWith([0]);
  });

  it('should toggle invert through the API', () => {
    component.onInvert(true);
    expect(api.setInvert).toHaveBeenCalledWith(true);
  });

  it('should assign a preset LUT colour and export through the API', () => {
    component.setPreset(channels[0], '#00ffff');
    expect(api.setChannelState).toHaveBeenCalledWith(0, { color: '#00ffff' });
    component.exportComposite();
    expect(api.exportComposite).toHaveBeenCalled();
  });

  it('should route a 16-bit data export through the API', () => {
    component.exportData();
    expect(api.exportData).toHaveBeenCalled();
  });

  it('maps an 8-bit window edit identically (native==display for 8-bit)', () => {
    // No native histogram → obsRange is 0..255, so native units == display units.
    component.onMaxChange(128);
    expect(api.setChannelState).toHaveBeenCalledWith(0, { min: 0, max: 128 });
  });

  it('onColormap applies a leaf node but ignores a parent', () => {
    component.onColormap({ label: 'Viridis' } as any);
    expect(api.setColormap).toHaveBeenCalledTimes(1);
    component.onColormap({ label: 'group', children: [] } as any);
    expect(api.setColormap).toHaveBeenCalledTimes(1);
  });

  it('onVisibleToggle writes channel visibility', () => {
    component.onVisibleToggle(channels[0], false);
    expect(api.setChannelState).toHaveBeenCalledWith(0, { visible: false });
  });

  it('onVisibleChange(false) emits and is reflected in state', () => {
    const emit = jest.spyOn(component.visibleChange, 'emit');
    component.onVisibleChange(false);
    expect(component.visible).toBe(false);
    expect(emit).toHaveBeenCalledWith(false);
  });

  it('multichannel is false for a single channel', () => {
    expect(component.multichannel).toBe(false);
  });

  describe('histogram rendering (with the plot div present)', () => {
    beforeEach(() => { document.body.innerHTML = `<div id="channel-histogram-plot"></div>`; });
    afterEach(() => { document.body.innerHTML = ''; });

    it('selectChannel loads and renders the histogram via Plotly', () => {
      component.selectChannel(channels[0]);
      expect(api.getHistogram$).toHaveBeenCalledWith(0, 256);
      expect(component.hist).toEqual({ bins: [0, 1], counts: [3, 7], max: 7 });
      expect(Plotly.react).toHaveBeenCalled();
    });

    it('purges the plot when no histogram is available (and not retrying)', () => {
      (api.getHistogram$ as jest.Mock).mockReturnValue(of(null));
      component.selectChannel(channels[0]); // visible=false → no retry loop → purge
      expect(component.hist).toBeNull();
      expect(Plotly.purge).toHaveBeenCalled();
    });

    it('toggleLog re-renders the histogram', () => {
      component.selectChannel(channels[0]);
      (Plotly.react as jest.Mock).mockClear();
      component.toggleLog(true);
      expect(component.logScale).toBe(true);
      expect(Plotly.react).toHaveBeenCalled();
    });

    it('onColorChange on the selected channel updates the colour and re-renders', () => {
      component.selectChannel(channels[0]);
      (Plotly.react as jest.Mock).mockClear();
      component.onColorChange(channels[0], '#ff0000');
      expect(api.setChannelState).toHaveBeenCalledWith(0, { color: '#ff0000' });
      expect(component.selected!.color).toBe('#ff0000');
      expect(Plotly.react).toHaveBeenCalled();
    });

    it('a min edit moves the marker lines (relayout) once a histogram is drawn', () => {
      component.selectChannel(channels[0]);
      (Plotly.relayout as jest.Mock).mockClear();
      component.onMinChange(50);
      expect(Plotly.relayout).toHaveBeenCalled();
    });
  });

  describe('16-bit native window mapping', () => {
    beforeEach(() => {
      component.hist = {
        bins: [100, 300, 500, 700, 900], counts: [0, 5, 20, 5, 0], max: 20,
        bitDepth: 16, observedMin: 100, observedMax: 900,
      } as any;
    });

    it('reports 16-bit and an observed slider range', () => {
      expect(component.is16bit).toBe(true);
      expect(component.sliderMin).toBe(100);
      expect(component.sliderMax).toBe(900);
      expect(component.sliderStep).toBeGreaterThanOrEqual(1);
    });

    it('maps the 0..255 display window onto native units for the sliders', () => {
      expect(component.minNative).toBe(100); // toNative(0)
      expect(component.maxNative).toBe(900); // toNative(255)
    });

    it('auto() saturates the native distribution and writes a display window (not autoContrast)', () => {
      component.auto();
      expect(api.setChannelState).toHaveBeenCalled();
      expect(api.autoContrast).not.toHaveBeenCalled();
    });

    it('a min edit maps native→display via the observed range', () => {
      component.onMinChange(500); // mid of 100..900 → ~128/255
      const lastCall = (api.setChannelState as jest.Mock).mock.calls.pop();
      expect(lastCall[1].min).toBeGreaterThan(120);
      expect(lastCall[1].min).toBeLessThan(135);
    });
  });
});
