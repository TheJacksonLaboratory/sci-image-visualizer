// ESLint 9 flat config (angular-eslint 21 needs ESLint 9). The same rules as the former
// .eslintrc.json, built from the angular-eslint plugins directly: their `angular-eslint`
// meta package needs the Angular CLI, which this ng-packagr library does not use.
import js from '@eslint/js';
import angular from '@angular-eslint/eslint-plugin';
import angularTemplate from '@angular-eslint/eslint-plugin-template';
import templateParser from '@angular-eslint/template-parser';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const style = {
  'object-curly-spacing': ['error', 'always'],
  quotes: ['error', 'single', { avoidEscape: true }],
  'max-len': [
    'error',
    {
      code: 115,
      ignoreUrls: true,
      ignoreStrings: true,
      ignoreTemplateLiterals: true,
      ignoreRegExpLiterals: true,
    },
  ],
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', '**/node_modules/**', '*.config.ts', 'examples/browser-image/**'],
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: { '@angular-eslint': angular },
    // Lint the templates inside @Component({ template }) too, with the *.html rules below.
    processor: angularTemplate.processors['extract-inline-html'],
    rules: {
      ...angular.configs.recommended.rules,
      // No common prefix (visualizer, region-editor, ...); angular-eslint 21 would default to 'app'.
      '@angular-eslint/directive-selector': ['error', { type: 'attribute', style: 'camelCase', prefix: '' }],
      '@angular-eslint/component-selector': ['error', { type: 'element', style: 'kebab-case', prefix: '' }],
      // Constructor injection stays: many specs build classes with `new X(mock, ...)`, which
      // Angular's inject() migration would leave without their constructor arguments.
      '@angular-eslint/prefer-inject': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      ...style,
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/lib/contracts/**/*.ts'],
    ignores: ['**/*.spec.ts', 'src/lib/contracts/cell-segmenter.contract.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/implementations/**',
                '**/spatial/**',
                '**/spatial-controls/**',
                '**/toolbar/**',
                '**/store/**',
                '**/region-editor/**',
                '**/channel-histogram/**',
                '**/plot-mode/**',
                '**/*.component',
                '**/*.service',
              ],
              message:
                'contracts/ is the backend-neutral layer: depend on contracts/ and models/ only. ' +
                '(cell-segmenter.contract.ts is exempt for its default factory.)',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.html'],
    languageOptions: { parser: templateParser },
    plugins: { '@angular-eslint/template': angularTemplate },
    rules: { ...angularTemplate.configs.recommended.rules },
  },
  {
    files: ['examples/tile-server/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { ...style },
  },
);
