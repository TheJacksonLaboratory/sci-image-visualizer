import 'jest-preset-angular/setup-jest';
import 'jest-canvas-mock';
import { TextEncoder, TextDecoder as UtilTextDecoder } from 'util';

if (typeof window.URL.createObjectURL === 'undefined') {
  window.URL.createObjectURL = jest.fn();
}

global.TextEncoder = TextEncoder;
global.TextDecoder = UtilTextDecoder as unknown as typeof global.TextDecoder;
