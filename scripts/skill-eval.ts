import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateSkillActivation,
  writeSkillEvaluationReport,
  type SkillEvaluationObservation,
} from '../src/skill-evaluation.js';

const input = process.argv[2];
const usage = 'Usage: npm run eval:skills -- <observations.json|jsonl> [report.json] [report.md]';

if (input === '--help' || input === '-h') {
  console.log(usage);
} else if (!input) {
  console.error(usage);
  process.exitCode = 1;
} else {
  const inputPath = resolve(input);
  const raw = readFileSync(inputPath, 'utf8').trim();
  const observations = (
    raw.startsWith('[')
      ? JSON.parse(raw)
      : raw
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
  ) as SkillEvaluationObservation[];
  const report = evaluateSkillActivation(observations);
  const jsonPath = resolve(process.argv[3] ?? `${inputPath}.report.json`);
  const markdownPath = resolve(process.argv[4] ?? `${inputPath}.report.md`);
  writeSkillEvaluationReport(report, jsonPath, markdownPath);
  console.log(
    JSON.stringify({
      rolloutReady: report.rolloutReady,
      precision: report.precision,
      recall: report.recall,
      report: jsonPath,
      markdown: markdownPath,
      reasons: report.reasons,
    }),
  );
  if (!report.rolloutReady) process.exitCode = 2;
}
