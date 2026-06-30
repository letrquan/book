import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/sdk.ts'],
  format: ['esm'],
  outDir: 'dist',
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  target: 'es2022',
});
