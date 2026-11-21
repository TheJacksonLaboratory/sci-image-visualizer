import { definePreset } from '@primeuix/themes';
import Lara from '@primeuix/themes/lara';

/**
 * The example's PrimeNG theme: Lara with a blue primary, light only — the closest
 * PrimeNG 21 preset to the saga-blue theme file it used before PrimeNG 18.
 */
export const ExamplePreset = definePreset(Lara, {
  semantic: {
    primary: {
      50: '{blue.50}',
      100: '{blue.100}',
      200: '{blue.200}',
      300: '{blue.300}',
      400: '{blue.400}',
      500: '{blue.500}',
      600: '{blue.600}',
      700: '{blue.700}',
      800: '{blue.800}',
      900: '{blue.900}',
      950: '{blue.950}',
    },
  },
});
