import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  COMPACT_EVAL_FIXTURE_FILENAME,
  parseArgs,
  runCompactEvaluationInProcess,
  type CompactEvalFixture,
} from './compact-eval.js';

async function main(): Promise<void> {
  const fixturePath = join(process.cwd(), COMPACT_EVAL_FIXTURE_FILENAME);
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as CompactEvalFixture;
  await rm(fixturePath);
  const bundle = await runCompactEvaluationInProcess(parseArgs(process.argv.slice(2)), fixture);
  process.stdout.write(`${JSON.stringify(bundle)}\n`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
