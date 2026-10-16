import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // mergeConfig concatenates arrays, so this runs after the base config's vitest-setup.ts.
      // The integration tier deliberately does not list it (see vitest-setup-clean-env.ts).
      setupFiles: ['./src/test/vitest-setup-clean-env.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.claude/**',
        '**/*.contract.test.{ts,tsx}',
        'src/agents/git-isolation.test.ts',
        'src/agents/manager.test.ts',
        'src/jobs/shell-manager.test.ts',
        'src/rewind/snapshot-store.test.ts',
        'src/settings-cli.test.ts',
        'src/tools/shell.test.ts',
        'src/tui/tui-integration.test.ts',
      ],
      // Ink and process-lifecycle tests share host-level stdin/listener state.
      maxWorkers: 1,
    },
  }),
);
