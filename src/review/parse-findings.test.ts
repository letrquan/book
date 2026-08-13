import { describe, expect, it } from 'vitest';
import { parseReviewReport, formatFinding, renderReviewReport } from './parse-findings.js';

const validJson = JSON.stringify({
  verdict: 'blocking',
  findings: [
    {
      severity: 'critical',
      category: 'correctness',
      file: 'src/a.ts',
      line: 12,
      summary: 'nil deref',
      evidence: 'x.y',
      failure: 'crashes on null',
      suggestedFix: 'guard y',
      confidence: 95,
    },
  ],
});

describe('parseReviewReport', () => {
  it('parses a clean JSON object', () => {
    const report = parseReviewReport(validJson);
    expect(report.verdict).toBe('blocking');
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ severity: 'critical', file: 'src/a.ts', line: 12 });
  });

  it('parses JSON wrapped in a fenced code block', () => {
    const report = parseReviewReport(`Here is the result:\n\`\`\`json\n${validJson}\n\`\`\``);
    expect(report.findings).toHaveLength(1);
  });

  it('falls back to an empty report for prose-only output', () => {
    const report = parseReviewReport('Everything looks good to me.');
    expect(report).toEqual({ verdict: 'inconclusive', findings: [] });
  });

  it('coerces invalid severity/category and clamps confidence', () => {
    const report = parseReviewReport(
      JSON.stringify({
        findings: [
          { severity: 'warn', category: 'unknown', file: 'x.ts', summary: 's', confidence: 200 },
        ],
      }),
    );
    expect(report.findings[0]).toMatchObject({
      severity: 'minor',
      category: 'correctness',
      confidence: 100,
    });
  });

  it('drops findings missing summary or file', () => {
    const report = parseReviewReport(JSON.stringify({ findings: [{ severity: 'nit' }] }));
    expect(report.findings).toEqual([]);
  });
});

describe('formatFinding', () => {
  it('renders severity, category, location, and fix', () => {
    const finding = parseReviewReport(validJson).findings[0]!;
    expect(formatFinding(finding)).toContain('[critical] correctness');
    expect(formatFinding(finding)).toContain('src/a.ts:12');
    expect(formatFinding(finding)).toContain('Fix: guard y');
  });
});

describe('renderReviewReport', () => {
  it('renders the verdict and findings', () => {
    const report = parseReviewReport(validJson);
    expect(renderReviewReport(report)).toContain('Verdict: blocking');
  });
});
