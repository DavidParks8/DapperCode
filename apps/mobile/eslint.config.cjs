const tsPlugin = require('@typescript-eslint/eslint-plugin');
const globals = require('globals');
const jest = require('eslint-plugin-jest');
const prettierRecommended = require('eslint-plugin-prettier/recommended');
const reactHooks = require('eslint-plugin-react-hooks');

const jestFiles = [
  '**/*.{test,spec}.{ts,tsx}',
  'src/shared/testing/**/*.{ts,tsx}',
];

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', '.expo/**'],
  },
  ...tsPlugin.configs['flat/recommended-type-checked'],
  {
    ...tsPlugin.configs['flat/disable-type-checked'],
    files: ['**/*.{js,cjs,mjs}'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        projectService: true,
        tsconfigRootDir: __dirname,
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'max-lines': [
        'error',
        {
          max: 550,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/purity': 'error',
      'react-hooks/rules-of-hooks': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-enum-comparison': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowAny: false,
          allowBoolean: false,
          allowNullish: false,
          allowNumber: true,
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
    },
  },
  {
    // Flat-config overrides cannot target individual callbacks; this exact adapter file and the two
    // rules affected by react-native-markdown-display's `any` styles argument are the narrowest scope.
    files: ['src/features/chat/message/markdownRules.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    files: jestFiles,
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    plugins: {
      jest,
    },
    rules: {
      'jest/no-focused-tests': 'error',
      'jest/no-identical-title': 'error',
      'jest/valid-expect': 'error',
    },
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx}'],
    rules: {
      'max-lines': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  prettierRecommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      curly: ['error', 'all'],
    },
  },
];
