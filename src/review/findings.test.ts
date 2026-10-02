import { describe, expect, it } from 'vitest';
import {
  dedupeFindings,
  deriveReviewVerdict,
  filterLowConfidence,
  findingKey,
  locationKey,
  rankFindings,
  summariesDescribeSameFinding,
} from './findings.js';
import type { ReviewCoverage, ReviewCoverageEntry, ReviewFinding } from './types.js';

const completePass: ReviewCoverageEntry = { id: 'correctness', status: 'completed', findings: 0 };
const completeCoverage: ReviewCoverage = { reviewers: [completePass] };

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

  it('ignores wording so differently phrased duplicates share a bucket', () => {
    const a = finding({
      file: 'a.ts',
      category: 'correctness',
      line: 4,
      summary: 'config may be undefined causing a null dereference',
    });
    const b = finding({
      file: 'a.ts',
      category: 'correctness',
      line: 4,
      summary: 'null dereference when config is missing',
    });
    expect(findingKey(a)).toBe(findingKey(b));
  });

  it('separates categories at the same location', () => {
    const correctness = finding({ file: 'a.ts', category: 'correctness', line: 4 });
    const security = finding({ file: 'a.ts', category: 'security', line: 4 });
    expect(findingKey(correctness)).not.toBe(findingKey(security));
  });
});

describe('locationKey', () => {
  it('keeps wording so the evaluation harness can match a specific finding', () => {
    expect(locationKey('a.ts', 4, 'null dereference')).not.toBe(
      locationKey('a.ts', 4, 'off by one'),
    );
  });

  it('normalizes separators and case', () => {
    expect(locationKey('Src\\A.ts', 3, 'Boom!')).toBe(locationKey('src/a.ts', 3, 'boom'));
  });
});

describe('summariesDescribeSameFinding', () => {
  it('matches the same defect described with different wording', () => {
    expect(
      summariesDescribeSameFinding(
        'null dereference when config is missing',
        'config may be undefined causing a null dereference',
      ),
    ).toBe(true);
  });

  it('matches a terse summary against a verbose one', () => {
    expect(
      summariesDescribeSameFinding(
        'null dereference',
        'the config lookup returns undefined here, so this is a null dereference',
      ),
    ).toBe(true);
  });

  it('separates genuinely different defects', () => {
    expect(
      summariesDescribeSameFinding(
        'null dereference when config is missing',
        'off by one error in the loop bound',
      ),
    ).toBe(false);
  });

  it('does not merge on a single shared generic token', () => {
    expect(summariesDescribeSameFinding('first bug', 'second bug')).toBe(false);
    expect(summariesDescribeSameFinding('parser bug', 'formatter bug')).toBe(false);
  });

  it('matches one-word summaries only when that word is shared', () => {
    expect(summariesDescribeSameFinding('deadlock', 'deadlock in the queue drain')).toBe(true);
    expect(summariesDescribeSameFinding('deadlock', 'overflow in the queue drain')).toBe(false);
  });

  it('falls back to exact comparison when nothing significant survives filtering', () => {
    expect(summariesDescribeSameFinding('it is', 'It is!')).toBe(true);
    expect(summariesDescribeSameFinding('it is', 'to be')).toBe(false);
  });
});

describe('dedupeFindings', () => {
  it('keeps the higher-confidence duplicate', () => {
    const low = finding({ file: 'a.ts', category: 'correctness', line: 1, confidence: 50 });
    const high = finding({ file: 'a.ts', category: 'correctness', line: 1, confidence: 90 });
    expect(dedupeFindings([low, high])).toHaveLength(1);
    expect(dedupeFindings([low, high])[0]!.confidence).toBe(90);
  });

  it('collapses the same defect reported by two reviewers in different words', () => {
    const first = finding({
      file: 'a.ts',
      category: 'correctness',
      line: 4,
      summary: 'null dereference when config is missing',
      confidence: 75,
    });
    const second = finding({
      file: 'a.ts',
      category: 'correctness',
      line: 4,
      summary: 'config may be undefined causing a null dereference',
      confidence: 90,
    });
    const deduped = dedupeFindings([first, second]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.confidence).toBe(90);
  });

  it('keeps two genuinely different defects on the same line', () => {
    const nullDeref = finding({
      file: 'a.ts',
      category: 'correctness',
      line: 4,
      summary: 'null dereference when config is missing',
    });
    const offByOne = finding({
      file: 'a.ts',
      category: 'correctness',
      line: 4,
      summary: 'off by one error in the loop bound',
    });
    expect(dedupeFindings([nullDeref, offByOne])).toHaveLength(2);
  });

  it('prefers severity over confidence when collapsing a restatement', () => {
    const critical = finding({
      file: 'a.ts',
      category: 'correctness',
      line: 4,
      severity: 'critical',
      summary: 'unchecked user input reaches the query builder',
      confidence: 70,
    });
    const nit = finding({
      file: 'a.ts',
      category: 'correctness',
      line: 4,
      severity: 'nit',
      summary: 'unchecked user input reaches the query builder',
      confidence: 99,
    });
    expect(dedupeFindings([critical, nit])[0]!.severity).toBe('critical');
    expect(dedupeFindings([nit, critical])[0]!.severity).toBe('critical');
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

describe('deriveReviewVerdict', () => {
  function standing(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
    return finding({ file: 'a.ts', category: 'correctness', ...overrides });
  }

  it('is inconclusive when a required pass did not complete', () => {
    expect(
      deriveReviewVerdict({
        findings: [],
        coverage: { reviewers: [completePass, { id: 'security', status: 'partial', findings: 0 }] },
      }),
    ).toBe('inconclusive');
  });

  it('is inconclusive when the verifier did not complete', () => {
    expect(
      deriveReviewVerdict({
        findings: [],
        coverage: {
          reviewers: [completePass],
          verifier: { id: 'verification', status: 'unstructured', findings: 0 },
        },
      }),
    ).toBe('inconclusive');
  });

  it('treats a reviewer that reported its own review as inconclusive as incomplete coverage', () => {
    expect(
      deriveReviewVerdict({
        findings: [],
        coverage: completeCoverage,
        reviewerVerdicts: ['clean', 'inconclusive'],
      }),
    ).toBe('inconclusive');
    // Its own findings are not what decides the verdict, and none are needed.
    expect(
      deriveReviewVerdict({
        findings: [standing({ severity: 'critical' })],
        coverage: completeCoverage,
        reviewerVerdicts: ['inconclusive'],
      }),
    ).toBe('inconclusive');
  });

  it('is blocking when a standing critical finding survives', () => {
    expect(
      deriveReviewVerdict({
        findings: [standing({ severity: 'major' }), standing({ severity: 'critical' })],
        coverage: completeCoverage,
      }),
    ).toBe('blocking');
  });

  it('is recommend for any other standing finding', () => {
    expect(
      deriveReviewVerdict({
        findings: [standing({ severity: 'nit' })],
        coverage: completeCoverage,
      }),
    ).toBe('recommend');
  });

  it('ignores a reviewer verdict that disagrees with the findings that survived', () => {
    const critical = standing({ severity: 'critical' });
    expect(
      deriveReviewVerdict({
        findings: [critical],
        coverage: completeCoverage,
        reviewerVerdicts: ['clean'],
      }),
    ).toBe('blocking');
    expect(
      deriveReviewVerdict({
        findings: [],
        coverage: completeCoverage,
        reviewerVerdicts: ['blocking'],
      }),
    ).toBe('clean');
  });

  it('is inconclusive when findings remain but the verifier stood none of them up', () => {
    const coverage: ReviewCoverage = {
      reviewers: [completePass],
      verifier: { id: 'verification', status: 'completed', findings: 1 },
    };
    expect(
      deriveReviewVerdict({
        findings: [standing({ verification: 'rejected' })],
        coverage,
      }),
    ).toBe('inconclusive');
    expect(
      deriveReviewVerdict({
        findings: [standing({ verification: 'inconclusive' })],
        coverage,
      }),
    ).toBe('inconclusive');
  });

  it('counts a confirmed finding as standing and a rejected one as not', () => {
    const coverage: ReviewCoverage = {
      reviewers: [completePass],
      verifier: { id: 'verification', status: 'completed', findings: 2 },
    };
    expect(
      deriveReviewVerdict({
        findings: [standing({ verification: 'rejected', severity: 'critical' })],
        coverage,
      }),
    ).toBe('inconclusive');
    expect(
      deriveReviewVerdict({
        findings: [
          standing({ verification: 'confirmed', severity: 'critical' }),
          standing({ verification: 'rejected', severity: 'critical' }),
        ],
        coverage,
      }),
    ).toBe('blocking');
  });

  it('is clean only when nothing is left and coverage was complete', () => {
    expect(deriveReviewVerdict({ findings: [], coverage: completeCoverage })).toBe('clean');
  });
});
