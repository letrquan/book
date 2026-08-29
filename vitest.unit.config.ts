import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.claude/**',
        '**/*.contract.test.{ts,tsx}',
        'src/agents/git-isolation.test.ts',
        'src/agents/manager.test.ts',
        // Binds a real loopback listener, so it shares process-level port state.
        'src/auth/loopback.test.ts',
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
