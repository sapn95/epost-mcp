import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        // Node globals this project actually uses
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        // present inside page.evaluate() bodies, which run in the browser
        document: 'readonly', window: 'readonly', location: 'readonly',
        getComputedStyle: 'readonly', PublicKeyCredential: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-return-await': 'error',
      'require-await': 'error',
    },
  },
];
