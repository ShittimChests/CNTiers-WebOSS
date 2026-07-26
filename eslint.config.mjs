import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: [
      // src/ views/ public/ 是待退役的旧站代码，不参与新代码的质量门禁
      'src/**',
      'views/**',
      'public/**',
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'tests/golden/**'
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // 用专用 tsconfig 而非 projectService：脚本、测试与配置文件都不在
        // 编译产物的 tsconfig 里，projectService 会因找不到它们而报解析错误。
        project: './tsconfig.eslint.json',
        tsconfigRootDir: rootDir
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // 未 await 的 Promise 在 Express handler 里会静默丢错，必须拦住
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message: '禁止 dangerouslySetInnerHTML —— 所有输出必须走 JSX 自动转义。'
        }
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }]
    }
  },

  {
    // 视图层是 CSP 纪律的执行点：零内联样式、零内联事件、零裸 HTML
    files: ['app/web/views/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message: '禁止 dangerouslySetInnerHTML —— 所有输出必须走 JSX 自动转义。'
        },
        {
          selector: 'JSXAttribute[name.name="style"]',
          message: 'CSP 不含 style-src unsafe-inline —— 请改用组件 class 或布局原语。'
        },
        {
          selector: 'JSXAttribute[name.name=/^on[A-Z]/]',
          message: 'CSP 不含 script-src unsafe-inline —— 请改用 data-enhance 增强器。'
        }
      ]
    }
  },

  {
    // env 装载是唯一允许直接读 process.env 的地方
    files: ['app/**/*.ts', 'app/**/*.tsx'],
    ignores: ['app/config/env.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: '请从 app/config/env.ts 读取配置，不要直接访问 process.env。'
        }
      ]
    }
  },

  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      'no-console': 'off'
    }
  },

  {
    // PM2 配置必须留在 CommonJS（根 package.json 已是 ESM）
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'writable',
        exports: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
        process: 'readonly'
      }
    }
  },

  prettier
);
