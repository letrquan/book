import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
        'src/agents/git-isolation.test.ts',
        'src/agents/manager.test.ts',
        'src/jobs/shell-manager.test.ts',
        'src/rewind/snapshot-store.test.ts',
        'src/settings-cli.test.ts',
        'src/tools/shell.test.ts',
        'src/tui/tui-integration.test.ts',
      ],
      maxWorkers: 1,
    },
  }),
);
