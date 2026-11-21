import { setupZoneTestEnv } from 'jest-preset-angular/setup-env/zone';
import 'jest-canvas-mock';
import { TextEncoder, TextDecoder as UtilTextDecoder } from 'util';

setupZoneTestEnv();

// jsdom has no matchMedia; PrimeNG's ContextMenu (and others) listen to one on init.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (typeof window.URL.createObjectURL === 'undefined') {
  window.URL.createObjectURL = jest.fn();
}
if (typeof window.URL.revokeObjectURL === 'undefined') {
  window.URL.revokeObjectURL = jest.fn();
}

global.TextEncoder = TextEncoder;
global.TextDecoder = UtilTextDecoder as unknown as typeof global.TextDecoder;
