import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Tells vitest-setup.ts which tier this is: it keeps the provider variables the TUI
      // streaming tests pass to their PTY child (#358) and clears every other BOOK_* variable.
      env: { VITEST_BOOK_TIER: 'integration' },
      include: [
        'src/agents/git-isolation.test.ts',
        'src/agents/manager.test.ts',
        'src/jobs/shell-manager.test.ts',
        'src/messaging/inbox-transport.test.ts',
        'src/rewind/snapshot-store.test.ts',
        'src/settings-cli.test.ts',
        'src/tools/shell.test.ts',
        'src/tools/shell-redacted-command.test.ts',
        'src/tui/tui-integration.test.ts',
      ],
      maxWorkers: 1,
    },
  }),
);
