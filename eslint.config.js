import js from '@eslint/js';
import globals from 'globals';
import unicorn from 'eslint-plugin-unicorn';

export default [
  { ignores: ['node_modules', 'dist', 'coverage', '.aws-sam'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { unicorn },
    rules: {
      // --- naming & structure conventions --------------------------------------------------
      // Files are kebab-case, with a role suffix such as .service / .repository / .middleware.
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
      // `node:fs`, never `fs`: makes built-ins unmistakable and avoids shadowing by npm packages.
      'unicorn/prefer-node-protocol': 'error',

      // --- correctness & clarity -----------------------------------------------------------
      // `const { omitted, ...rest } = obj` is the idiomatic way to drop a key.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      curly: ['error', 'multi-line'],
      'no-console': 'error',
      'no-throw-literal': 'error',
      'prefer-template': 'error',
      'object-shorthand': 'error',
    },
  },
  {
    // Command-line tools and tests may print and use looser naming.
    files: ['scripts/**', 'tests/**'],
    rules: { 'no-console': 'off' },
  },
];
