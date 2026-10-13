// ESLint 9 flat config (v1.0.7, PX-28). Type-checking stays in `npm run typecheck`;
// this catches the things tsc doesn't: hook rules, unsafe patterns, and the
// labs boundary (R-14). Formatting is Prettier's job (eslint-config-prettier
// turns off every stylistic rule that would fight it).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/** Experimental modules (src/labs/README.md) must not be imported by the app. */
const LABS_IMPORT_RULE = [
  'error',
  {
    patterns: [
      {
        group: ['@/labs', '@/labs/*', '**/labs', '**/labs/*'],
        message:
          'src/labs holds experimental modules with known-unsafe advice (see src/labs/README.md). Fix the module and move it back to src/services before using it.',
      },
    ],
  },
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'release/**',
      'coverage/**',
      'node_modules/**',
      'api/**',
      'playwright-report/**',
      'test-results/**',
      'public/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Match tsc's noUnusedParameters convention: a leading underscore marks
      // an intentionally unused binding (callback signatures, placeholders).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },

  // App (browser) sources.
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-imports': LABS_IMPORT_RULE,
    },
  },

  // The labs themselves (and their tests) may import each other.
  {
    files: ['src/labs/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Tests: Node + vitest globals; test doubles legitimately use `any`.
  {
    files: ['src/**/__tests__/**/*.{ts,tsx}', 'src/**/*.test.{ts,tsx}', 'e2e/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.vitest },
    },
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  // Electron main/preload, build configs and scripts run in Node.
  {
    files: [
      'electron/**/*.ts',
      'scripts/**/*.{js,mjs,cjs}',
      '*.config.{ts,js,mjs,cjs}',
      'vite.chunks.ts',
      'electron-builder.store.cjs',
      'e2e/**/*.ts',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-imports': LABS_IMPORT_RULE,
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  prettier,
);
