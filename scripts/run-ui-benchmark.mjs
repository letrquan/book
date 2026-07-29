import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const environment = { ...process.env };
for (const name of ['BOOK_DEBUG', 'BOOK_DEBUG_RENDER', 'BOOK_DEBUG_FLOW', 'BOOK_DEBUG_UI']) {
  delete environment[name];
}

const result = spawnSync(
  process.execPath,
  [require.resolve('tsx/cli'), 'src/tui/__benchmarks__/ui.bench.tsx'],
  { env: environment, stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
