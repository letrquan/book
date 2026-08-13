import { describe, expect, it } from 'vitest';
import { dedupeFindings, filterLowConfidence, findingKey, rankFindings } from './findings.js';
import type { ReviewFinding } from './types.js';

function finding(
  overrides: Partial<ReviewFinding> & { file: string; category: ReviewFinding['category'] },
): ReviewFinding {
  return {
    id: 'f1',
    severity: 'minor',
    summary: 's',
    evidence: '',
    failure: '',
    confidence: 80,
    ...overrides,
  };
}

describe('findingKey', () => {
  it('normalizes separators and case', () => {
    expect(findingKey(finding({ file: 'Src\\A.ts', category: 'correctness', line: 3 }))).toBe(
      findingKey(finding({ file: 'src/a.ts', category: 'correctness', line: 3 })),
    );
  });
});

describe('dedupeFindings', () => {
  it('keeps the higher-confidence duplicate', () => {
    const low = finding({ file: 'a.ts', category: 'correctness', line: 1, confidence: 50 });
    const high = finding({ file: 'a.ts', category: 'correctness', line: 1, confidence: 90 });
    expect(dedupeFindings([low, high])).toHaveLength(1);
    expect(dedupeFindings([low, high])[0]!.confidence).toBe(90);
  });
});

describe('rankFindings', () => {
  it('sorts severity before confidence', () => {
    const minor = finding({
      file: 'a.ts',
      category: 'correctness',
      severity: 'minor',
      confidence: 100,
    });
    const critical = finding({
      file: 'b.ts',
      category: 'correctness',
      severity: 'critical',
      confidence: 1,
    });
    expect(rankFindings([minor, critical])[0]!.severity).toBe('critical');
  });
});

describe('filterLowConfidence', () => {
  it('drops findings below the threshold', () => {
    const low = finding({ file: 'a.ts', category: 'correctness', confidence: 60 });
    const high = finding({ file: 'b.ts', category: 'correctness', confidence: 90 });
    expect(filterLowConfidence([low, high])).toEqual([high]);
  });
});
