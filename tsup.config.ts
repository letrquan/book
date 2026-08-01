import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

export default defineConfig({
  entry: ['src/index.ts', 'src/sdk.ts', 'src/job-runner.ts'],
  format: ['esm'],
  outDir: 'dist',
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  target: 'es2022',
  define: {
    __BOOK_VERSION__: JSON.stringify(packageJson.version),
  },
});
