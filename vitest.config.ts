import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'development',
    },
    setupFiles: ['./src/test/vitest-setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // Vitest's 5s default is calibrated for a quiet local machine; contended
    // CI runners (cold NTFS + antivirus on windows-latest especially) push
    // ordinary FS-heavy tests past it. This is a latency ceiling, not a wait:
    // green-path duration is unchanged, and per-test budgets still override.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/test/**'],
    },
  },
});
