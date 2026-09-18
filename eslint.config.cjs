/**
 * ESLint 配置（扁平配置，ESLint 8.57 支持）。
 *
 * 背景：仓库原先**没有**任何 eslint 配置，但 package.json 里定义了 `npm run lint`，
 * 一跑就退出码 2 报 "ESLint couldn't find a configuration file"，等于 lint 从未生效。
 * 这里用最小可用配置，重点放在"能抓出真问题"的规则上（未使用变量、不可达代码、重复键、
 * React hooks 规则），刻意不开格式化类规则以免产生大量噪音。
 */
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist_electron/**',
      'web-dist/**',
      'hotline-dist/**',
      'scripts/**',
      '*.config.js',
      '*.config.cjs'
    ]
  },
  // 通用 TS 规则
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none'
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['warn', { checkLoops: false }]
    }
  },
  // React 规则只作用于渲染进程。
  // 注意：主进程里 baileys 的 useMultiFileAuthState() 会被 rules-of-hooks 误判成
  // "Hook 用在了非组件里"，所以绝不能把这条规则开到 src/main。
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off' // 本项目大量刻意的依赖省略，开了噪音太大
    }
  }
];
