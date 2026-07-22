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
        'src/agents/git-isolation.test.ts',
        'src/agents/manager.test.ts',
        'src/rewind/snapshot-store.test.ts',
        'src/settings-cli.test.ts',
        'src/tools/shell.test.ts',
        'src/tui/tui-integration.test.ts',
      ],
      maxWorkers: 1,
      coverage: {
        exclude: ['src/test/**', 'src/tui/__benchmarks__/**'],
        thresholds: {
          statements: 68,
          branches: 62,
          functions: 68,
          lines: 70,
          'src/{config,settings-loader,settings-repository}.ts': {
            statements: 80,
            branches: 75,
            functions: 85,
            lines: 82,
          },
          'src/stream-json.ts': {
            statements: 84,
            branches: 76,
            functions: 84,
            lines: 88,
          },
          'src/mcp.ts': {
            statements: 84,
            branches: 65,
            functions: 85,
            lines: 90,
          },
          'src/sdk.ts': {
            statements: 72,
            branches: 55,
            functions: 65,
            lines: 82,
          },
          'src/commands/{builtins,filter,loader,registry,resolve}.ts': {
            statements: 80,
            branches: 72,
            functions: 75,
            lines: 82,
          },
          'src/provider/{port,reliability}.ts': {
            statements: 86,
            branches: 75,
            functions: 85,
            lines: 90,
          },
          'src/session/{agent-events,agent-interactions,agent-session,runtime}.ts': {
            statements: 88,
            branches: 78,
            functions: 85,
            lines: 90,
          },
        },
      },
    },
  }),
);
