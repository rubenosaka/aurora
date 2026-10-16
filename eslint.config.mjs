import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'coverage/**', 'pnpm-lock.yaml']
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.{ts,mts,vue}']
  })),
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.{ts,mts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              name: ['describe', 'it', 'suite', 'test'],
              package: 'node:test'
            }
          ]
        }
      ],
      '@typescript-eslint/require-await': 'off'
    }
  },
  {
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off'
    }
  },
  {
    files: ['src/renderer/public/theme-init.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        localStorage: 'readonly',
        window: 'readonly'
      }
    }
  },
  {
    files: ['src/shared/app-info.ts'],
    rules: {
      'no-control-regex': 'off'
    }
  },
  {
    files: ['src/renderer/src/main.ts', 'src/renderer/src/app/router.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off'
    }
  },
  {
    files: ['src/renderer/src/App.vue'],
    rules: {
      'vue/multi-word-component-names': 'off'
    }
  },
  prettier
);
