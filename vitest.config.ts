import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vitest 4 走 oxc transform（不再是 esbuild）；JSX 要转成 preact 的自动运行时
  oxc: {
    jsx: {
      runtime: 'automatic',
      importSource: 'preact'
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['node_modules/**', 'dist/**', 'src/**'],
    coverage: {
      provider: 'v8',
      include: ['app/**/*.ts', 'app/**/*.tsx'],
      exclude: ['app/client/**', 'app/**/*.d.ts']
    }
  }
});
