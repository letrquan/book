import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateReview,
  groundTruthFromFixture,
  renderReviewEvaluation,
  type ReviewExpectation,
  type ReviewGroundTruth,
} from '../src/review/evaluation.js';
import { parseReviewReport } from '../src/review/parse-findings.js';

/**
 * Score review pipeline output against a golden fixture set.
 *
 * Each fixture pairs hand-authored expectations with a ReviewReport captured
 * from a real `/review` run. See evals/review/fixtures.example.json.
 */

const DEFAULT_FIXTURES = 'evals/review/fixtures.json';
const usage = [
  `Usage: npm run eval:review -- [fixtures.json]   (default: ${DEFAULT_FIXTURES})`,
  '',
  'Fixture format — an array of:',
  '  {',
  '    "id": "missing-null-guard",',
  '    "expected": [{ "file": "src/user.ts", "line": 42, "summary": "..." }],',
  '    "report": { "verdict": "recommend", "findings": [ ... ] }',
  '  }',
  '',
  'See evals/review/fixtures.example.json for a worked example.',
].join('\n');

function fail(message: string): never {
  console.error(`${message}\n\n${usage}`);
  process.exit(1);
}

function expectations(value: unknown, fixtureId: string): ReviewExpectation[] {
  if (!Array.isArray(value)) fail(`Fixture ${fixtureId}: "expected" must be an array.`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      fail(`Fixture ${fixtureId}: expectation ${index} is not an object.`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.file !== 'string' || typeof record.summary !== 'string') {
      fail(`Fixture ${fixtureId}: expectation ${index} needs string "file" and "summary".`);
    }
    return {
      file: record.file,
      summary: record.summary,
      line: typeof record.line === 'number' ? record.line : undefined,
    };
  });
}

function parseFixtures(raw: string): ReviewGroundTruth[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`Fixtures file is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(parsed)) fail('Fixtures file must be a JSON array.');

  return parsed.map((fixture, index) => {
    if (!fixture || typeof fixture !== 'object') fail(`Fixture ${index} is not an object.`);
    const record = fixture as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : `fixture-${index}`;
    if (record.report === undefined) {
      fail(`Fixture ${id}: missing "report" (the ReviewReport the pipeline produced).`);
    }
    // Route the report through the same tolerant parser the live pipeline uses,
    // so a fixture cannot claim findings the real contract would have rejected.
    const report = parseReviewReport(JSON.stringify(record.report));
    return groundTruthFromFixture({ id, expected: expectations(record.expected, id), report });
  });
}

const fixturePath = resolve(process.argv[2] ?? DEFAULT_FIXTURES);
if (!existsSync(fixturePath)) {
  fail(`Fixtures file not found: ${fixturePath}`);
}

process.stdout.write(
  `${renderReviewEvaluation(evaluateReview(parseFixtures(readFileSync(fixturePath, 'utf-8'))))}\n`,
);
