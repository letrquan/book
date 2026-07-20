import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateSuccess, runPairedEvaluation } from './evaluation.js';

let root = '';

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('paired agent evaluation', () => {
  it('runs off/adaptive pairs and stores metrics without raw prompts', async () => {
    root = mkdtempSync(join(tmpdir(), 'book-eval-'));
    const output = join(root, 'metrics.jsonl');
    const metrics = await runPairedEvaluation(
      [{ id: 'fixture', cohort: 'decomposable', prompt: 'secret fixture prompt' }],
      async (_fixture, mode) => ({
        passed: true,
        wallTimeMs: mode === 'adaptive' ? 80 : 100,
        totalTokens: mode === 'adaptive' ? 150 : 100,
      }),
      output,
    );

    expect(metrics.map((metric) => metric.mode)).toEqual(['off', 'adaptive']);
    expect(readFileSync(output, 'utf8')).not.toContain('secret fixture prompt');
    expect(evaluateSuccess(metrics).successful).toBe(true);
  });
});
