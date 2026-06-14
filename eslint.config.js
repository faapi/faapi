import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  // 全局忽略
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.cache/**',
      '**/fixtures/**',
      '**/*.config.ts',
      '**/*.config.js',
      '.changeset/**',
    ],
  },
  // 基础推荐规则
  js.configs.recommended,
  // TypeScript 推荐规则（非 type-aware，避免慢）
  ...tseslint.configs.recommended,
  // 项目通用配置
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // 禁用基础规则，改用 TS 版本
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-empty-object-type': 'error',
      'preserve-caught-error': 'error',
      'no-useless-catch': 'error',
      // 允许未使用表达式（如 koa 风格的 await next()）
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  // 测试文件：mock 构造需要灵活的类型断言，允许 any
  {
    files: ['**/*.test.ts', '**/*.e2e.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
];
