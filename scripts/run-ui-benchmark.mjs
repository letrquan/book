import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const environment = { ...process.env };
for (const name of ['BOOK_DEBUG', 'BOOK_DEBUG_RENDER', 'BOOK_DEBUG_FLOW', 'BOOK_DEBUG_UI']) {
  delete environment[name];
}
// The CLI entry defaults NODE_ENV to production (src/runtime-env.ts), so the
// benchmark must measure production React too. Dev-mode React is 2-3x slower.
if (!environment.NODE_ENV) environment.NODE_ENV = 'production';

const result = spawnSync(
  process.execPath,
  [require.resolve('tsx/cli'), 'src/tui/__benchmarks__/ui.bench.tsx'],
  { env: environment, stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
