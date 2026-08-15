'use strict';

module.exports = [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'artifacts/**', '**/.wrangler/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: {
      'no-console': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'prefer-const': 'error'
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        sessionStorage: 'readonly'
      }
    },
    rules: {
      'no-console': 'off'
    }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        Headers: 'readonly',
        FormData: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        navigator: 'readonly',
        sessionStorage: 'readonly',
        window: 'readonly'
      }
    }
  }
];
