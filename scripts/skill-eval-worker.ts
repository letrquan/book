import { readFile } from 'node:fs/promises';
import {
  evaluateSkillActivation,
  type SkillEvaluationObservation,
} from '../src/skill-evaluation.js';

function parseObservations(raw: string): SkillEvaluationObservation[] {
  const trimmed = raw.trim();
  return (
    trimmed.startsWith('[')
      ? JSON.parse(trimmed)
      : trimmed
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
  ) as SkillEvaluationObservation[];
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) throw new Error('Skill evaluation worker requires an observations file.');
  const report = evaluateSkillActivation(parseObservations(await readFile(input, 'utf8')));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
