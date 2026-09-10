import js from '@eslint/js'
import globals from 'globals'

// uploads/ holds the files people put in rooms. It is data, not source:
// the generation tests apply change sets there, and an applied file saying
// only 'a' is a fixture, not a bug in this codebase.
export default [
  { ignores: ['node_modules', 'coverage', '.vite', 'test-results', 'uploads'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
]
