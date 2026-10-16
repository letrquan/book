import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // mergeConfig concatenates arrays, so this runs after the base config's vitest-setup.ts.
      setupFiles: ['./src/test/vitest-setup-clean-env.ts'],
      include: ['src/**/*.contract.test.{ts,tsx}'],
      maxWorkers: 1,
    },
  }),
);
