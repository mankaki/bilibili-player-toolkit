export default [
  {
    ignores: [
      '**/*.log',
      '**/*.{png,jpg,jpeg,gif,webp,svg,ico}'
    ]
  },
  {
    files: ['**/*.user.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        requestAnimationFrame: 'readonly',
        MutationObserver: 'readonly',
        localStorage: 'readonly',
        Element: 'readonly',
        ShadowRoot: 'readonly',
        NodeFilter: 'readonly',
        prompt: 'readonly'
      }
    }
  },
  {
    files: ['tests/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        __dirname: 'readonly'
      }
    }
  },
  {
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error'
    }
  }
];
