// Flat ESLint config for the whole monorepo.
//
// Type-aware rules are enabled: the point of using strict TypeScript here is to
// catch real mistakes (unhandled promises, unsafe narrowing) rather than to
// enforce style, which Prettier already handles.

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.wrangler/**',
      'e2e/test-results/**',
      'e2e/playwright-report/**',
      'e2e/screenshots/**',
      'coverage/**',
      // Type-aware linting needs a TS project; this config file is plain JS and
      // belongs to none of them.
      'eslint.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Explicit project list rather than `projectService`, so every workspace
        // (including the ones with a separate tsconfig for tests) is type-aware.
        project: [
          './shared/tsconfig.json',
          './worker/tsconfig.json',
          './worker/tsconfig.test.json',
          './frontend/tsconfig.json',
          './frontend/tsconfig.node.json',
          './e2e/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused arguments named with a leading underscore are intentional.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `any` is banned outright; the codebase has no legitimate use for it.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Untrusted payloads are typed as index signatures and read by key on
      // purpose; dot access on those reads no better.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['frontend/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['worker/src/**/*.ts'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ['worker/test/**/*.ts', 'e2e/**/*.ts', '**/*.config.ts', 'shared/test/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // `qr.ts` is a verbatim port of the owner's SuperTaki encoder. It is left
    // byte-identical apart from the added renderer, because hand-editing bit
    // manipulation for a style rule is a good way to introduce a subtle bug.
    files: ['frontend/src/ui/qr.ts'],
    rules: {
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
    },
  },
  {
    // Tests assert on shapes the type system already knows; the noise is not useful.
    files: ['**/test/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
