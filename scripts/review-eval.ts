import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateReview,
  renderReviewEvaluation,
  type ReviewGroundTruth,
} from '../src/review/evaluation.js';

const usage = 'Usage: npm run eval:review -- <fixtures.json>';
const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error(usage);
  process.exit(1);
}

function parseFixtures(raw: string): ReviewGroundTruth[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Fixtures file must be a JSON array.');
  return parsed.map((fixture, index) => {
    if (!fixture || typeof fixture !== 'object')
      throw new Error(`Fixture ${index} is not an object.`);
    const record = fixture as Record<string, unknown>;
    const strings = (value: unknown): string[] =>
      Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
    const id = typeof record.id === 'string' ? record.id : `fixture-${index}`;
    return { id, expected: strings(record.expected), actual: strings(record.actual) };
  });
}

try {
  const fixtures = parseFixtures(readFileSync(resolve(fixturePath), 'utf-8'));
  process.stdout.write(`${renderReviewEvaluation(evaluateReview(fixtures))}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
