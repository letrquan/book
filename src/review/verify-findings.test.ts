import { describe, expect, it } from 'vitest';
import {
  applyVerification,
  buildVerificationPrompt,
  parseVerificationVerdicts,
} from './verify-findings.js';
import type { ReviewFinding } from './types.js';

const finding: ReviewFinding = {
  id: 'f1',
  severity: 'major',
  category: 'correctness',
  file: 'src/a.ts',
  line: 4,
  summary: 'bad',
  evidence: 'x',
  failure: 'fails',
  confidence: 90,
};

describe('buildVerificationPrompt', () => {
  it('instructs falsification and includes findings', () => {
    const prompt = buildVerificationPrompt([finding]);
    expect(prompt).toContain('DISPROVE');
    expect(prompt).toContain('src/a.ts:4');
  });
});

describe('parseVerificationVerdicts', () => {
  it('parses a fenced verdicts object', () => {
    const text =
      '```json\n{"verdicts":[{"findingId":"f1","state":"confirmed","reason":"real"}]}\n```';
    expect(parseVerificationVerdicts(text)).toEqual([
      { findingId: 'f1', state: 'confirmed', reason: 'real' },
    ]);
  });

  it('ignores invalid states', () => {
    expect(parseVerificationVerdicts('{"verdicts":[{"findingId":"f1","state":"maybe"}]}')).toEqual(
      [],
    );
  });
});

describe('applyVerification', () => {
  it('drops rejected findings and keeps confirmed/inconclusive', () => {
    const result = applyVerification(
      [finding],
      [{ findingId: 'f1', state: 'rejected', reason: 'not real' }],
    );
    expect(result).toEqual([]);
  });

  it('treats missing verdicts as inconclusive', () => {
    const result = applyVerification([finding], []);
    expect(result[0]).toMatchObject({ verification: 'inconclusive' });
  });
});
