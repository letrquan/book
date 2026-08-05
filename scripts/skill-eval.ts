import { copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluationControlsFromResult,
  runEvaluationProcess,
} from '../src/harness/evaluation/runner.js';
import {
  SKILL_EVALUATION_CATEGORIES,
  writeSkillEvaluationReport,
  type SkillEvaluationReport,
} from '../src/skill-evaluation.js';

const usage = 'Usage: npm run eval:skills -- <observations.json|jsonl> [report.json] [report.md]';
const SKILL_EVAL_WORKER = fileURLToPath(new URL('./skill-eval-worker.ts', import.meta.url));
const TSX_LOADER = import.meta.resolve('tsx');
const SKILL_EVAL_TIMEOUT_MS = 30_000;
const SKILL_EVAL_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

function parseWorkerReport(stdout: string): SkillEvaluationReport {
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error('Skill evaluation worker returned no result.');
  const parsed: unknown = JSON.parse(line);
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const isNumber = (value: unknown): value is number => Number.isFinite(value);
  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
  const hasNumbers = (value: unknown, keys: readonly string[]): boolean =>
    isRecord(value) && keys.every((key) => isNumber(value[key]));
  const observationIsValid = (value: unknown): boolean =>
    isRecord(value) &&
    typeof value.id === 'string' &&
    SKILL_EVALUATION_CATEGORIES.includes(value.category as never) &&
    typeof value.promptHash === 'string' &&
    isStringArray(value.expectedSkills) &&
    isStringArray(value.activatedSkills) &&
    isStringArray(value.blockedCodes) &&
    hasNumbers(value, [
      'promptChars',
      'promptTokens',
      'bodyBytes',
      'bodyTokens',
      'falseActivationBytes',
      'consentRequests',
      'unnecessaryPermissionPrompts',
      'userCorrections',
      'skillToolFailures',
    ]) &&
    Array.isArray(value.activationLatencyMs) &&
    value.activationLatencyMs.every(isNumber) &&
    typeof value.blockingMismatch === 'boolean';
  if (
    !isRecord(parsed) ||
    typeof parsed.generatedAt !== 'string' ||
    !isNumber(parsed.fixtureCount) ||
    !isRecord(parsed.categoryCounts) ||
    !SKILL_EVALUATION_CATEGORIES.every((category) => isNumber(parsed.categoryCounts[category])) ||
    !hasNumbers(parsed, [
      'truePositives',
      'falsePositives',
      'falseNegatives',
      'precision',
      'recall',
      'falseActivationBytes',
      'consentRequests',
      'unnecessaryPermissionPrompts',
      'userCorrections',
      'skillToolFailures',
      'blockingMismatches',
    ]) ||
    !hasNumbers(parsed.promptChars, ['total', 'median']) ||
    !hasNumbers(parsed.promptTokens, ['total', 'median']) ||
    !hasNumbers(parsed.bodyBytes, ['total', 'median']) ||
    !hasNumbers(parsed.bodyTokens, ['total', 'median']) ||
    !hasNumbers(parsed.activationLatencyMs, ['median', 'p95']) ||
    !isRecord(parsed.exposure) ||
    !hasNumbers(parsed.exposure.eager, ['samples', 'activationRate', 'medianActivationTurns']) ||
    !hasNumbers(parsed.exposure.deferred, ['samples', 'activationRate', 'medianActivationTurns']) ||
    !hasNumbers(parsed.thresholds, [
      'minimumPrecision',
      'minimumRecall',
      'maximumFalseActivations',
      'maximumUnnecessaryPermissionPrompts',
      'maximumSkillToolFailures',
    ]) ||
    typeof parsed.rolloutReady !== 'boolean' ||
    !isStringArray(parsed.reasons) ||
    !Array.isArray(parsed.observations) ||
    !parsed.observations.every(observationIsValid)
  ) {
    throw new Error('Skill evaluation worker returned an unsupported report schema.');
  }
  return parsed as unknown as SkillEvaluationReport;
}

export async function runSkillEvaluationIsolated(
  inputPath: string,
): Promise<SkillEvaluationReport> {
  const processResult = await runEvaluationProcess({
    command: process.execPath,
    args: ['--import', TSX_LOADER, SKILL_EVAL_WORKER, 'observations'],
    timeoutMs: SKILL_EVAL_TIMEOUT_MS,
    maxOutputBytes: SKILL_EVAL_OUTPUT_LIMIT_BYTES,
    prepare: async ({ workspace }) => {
      await copyFile(inputPath, join(workspace, 'observations'));
    },
  });
  if (processResult.status !== 'completed') {
    throw new Error(
      processResult.stderr.trim() || `Skill evaluation process ${processResult.status}.`,
    );
  }
  return {
    ...parseWorkerReport(processResult.stdout),
    evaluation: {
      evidenceKind: 'offline-observation',
      providerRunEligibility: 'not-applicable',
      controls: evaluationControlsFromResult(processResult),
    },
  };
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (input === '--help' || input === '-h') {
    console.log(usage);
    return;
  }
  if (!input) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }

  const inputPath = resolve(input);
  const report = await runSkillEvaluationIsolated(inputPath);
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

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
