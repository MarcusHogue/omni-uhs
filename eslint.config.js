// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/dev-dist/**',
      '**/test/fixtures/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    /**
     * Spec §2, the load-bearing constraint: the parser is re-implemented in
     * Swift later, so it must operate on plain bytes and strings with no DOM,
     * React or Node surface at all. This rule is the enforcement.
     */
    files: ['web/src/parser/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'The parser must not depend on Node.' },
            { group: ['react', 'react-*'], message: 'The parser must not depend on React.' },
            { group: ['fflate', 'idb'], message: 'The parser must stay dependency-free.' },
            { group: ['../ui/*', '../storage/*', '../api/*'], message: 'The parser must not reach into the app.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'The parser must not touch the DOM.' },
        { name: 'document', message: 'The parser must not touch the DOM.' },
        { name: 'process', message: 'The parser must not depend on Node.' },
        { name: 'Buffer', message: 'The parser must not depend on Node.' },
        { name: 'TextDecoder', message: 'Use cp437Decode: TextDecoder("latin1") is windows-1252.' },
        { name: 'TextEncoder', message: 'Use cp437Encode instead.' },
      ],
    },
  },
);
