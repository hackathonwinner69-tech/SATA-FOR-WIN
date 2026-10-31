import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['sandbox/', 'node_modules/', '.chorecade/', '.vercel/', 'coverage/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
    },
  },
  { files: ['public/**'], languageOptions: { globals: { ...globals.browser } } },
];
