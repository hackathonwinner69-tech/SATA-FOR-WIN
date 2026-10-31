import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['sandbox/', 'node_modules/', '.chorecade/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }] },
  },
  { files: ['public/**'], languageOptions: { globals: { ...globals.browser } } },
];
