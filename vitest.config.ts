import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/test/vitest-setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/test/**'],
    },
  },
});
