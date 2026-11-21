import { setupZoneTestEnv } from 'jest-preset-angular/setup-env/zone';
import 'jest-canvas-mock';
import { TextEncoder, TextDecoder as UtilTextDecoder } from 'util';

setupZoneTestEnv();

if (typeof window.URL.createObjectURL === 'undefined') {
  window.URL.createObjectURL = jest.fn();
}
if (typeof window.URL.revokeObjectURL === 'undefined') {
  window.URL.revokeObjectURL = jest.fn();
}

global.TextEncoder = TextEncoder;
global.TextDecoder = UtilTextDecoder as unknown as typeof global.TextDecoder;
