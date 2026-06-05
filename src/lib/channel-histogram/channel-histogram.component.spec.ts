import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { of } from 'rxjs';

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
});
