import { describe, expect, it } from 'vitest';
import { renderAdvisoryReport, summarizeAudit, type AuditReport } from './report-advisories.js';

function auditReport(vulnerabilities: NonNullable<AuditReport['vulnerabilities']>): AuditReport {
  return { vulnerabilities };
}

describe('summarizeAudit', () => {
  it('keeps only advisories at or above the threshold', () => {
    const summary = summarizeAudit(
      auditReport({
        postcss: { name: 'postcss', severity: 'high', isDirect: false, range: '<8.5.26' },
        tar: { name: 'tar', severity: 'moderate', isDirect: true, range: '<7' },
        lodash: { name: 'lodash', severity: 'low', isDirect: true, range: '<4' },
      }),
      'high',
    );

    expect(summary.total).toBe(1);
    expect(summary.advisories[0]?.package).toBe('postcss');
    expect(summary.bySeverity).toMatchObject({ low: 1, moderate: 1, high: 1, critical: 0 });
  });

  it('sorts most severe first and breaks ties by package name', () => {
    const summary = summarizeAudit(
      auditReport({
        zod: { name: 'zod', severity: 'high' },
        ansi: { name: 'ansi', severity: 'high' },
        boom: { name: 'boom', severity: 'critical' },
      }),
      'high',
    );

    expect(summary.advisories.map((advisory) => advisory.package)).toEqual(['boom', 'ansi', 'zod']);
  });

  it('collects advisory titles and urls from object `via` entries and ignores string ones', () => {
    const summary = summarizeAudit(
      auditReport({
        postcss: {
          name: 'postcss',
          severity: 'critical',
          via: [
            'some-transitive-parent',
            { title: 'Line return parsing error', url: 'https://example.test/GHSA-1' },
            { title: 'Line return parsing error', url: 'https://example.test/GHSA-1' },
          ],
        },
      }),
      'high',
    );

    expect(summary.advisories[0]?.titles).toEqual(['Line return parsing error']);
    expect(summary.advisories[0]?.urls).toEqual(['https://example.test/GHSA-1']);
  });

  it('classifies the available fix', () => {
    const summary = summarizeAudit(
      auditReport({
        a: { name: 'a', severity: 'high', fixAvailable: true },
        b: { name: 'b', severity: 'high', fixAvailable: false },
        c: { name: 'c', severity: 'high', fixAvailable: { name: 'c', isSemVerMajor: true } },
      }),
      'high',
    );

    expect(Object.fromEntries(summary.advisories.map((a) => [a.package, a.fix]))).toEqual({
      a: 'patch',
      b: 'none',
      c: 'major',
    });
  });

  it('treats an unknown or missing severity as info so it never trips a high threshold', () => {
    const summary = summarizeAudit(
      auditReport({ mystery: { name: 'mystery' }, weird: { name: 'weird', severity: 'bogus' } }),
      'high',
    );

    expect(summary.total).toBe(0);
    expect(summary.bySeverity.info).toBe(2);
  });

  it('tolerates a report with no vulnerabilities key', () => {
    expect(summarizeAudit({}, 'high').total).toBe(0);
  });
});

describe('renderAdvisoryReport', () => {
  const scannedAt = '2026-08-15T01:00:00.000Z';

  it('renders a clean report when nothing meets the threshold', () => {
    const body = renderAdvisoryReport(summarizeAudit({}, 'high'), { threshold: 'high', scannedAt });

    expect(body).toContain('No advisories at or above `high`.');
    expect(body).toContain('<!-- book:advisory-report -->');
  });

  it('renders a row and a detail section per advisory', () => {
    const summary = summarizeAudit(
      auditReport({
        postcss: {
          name: 'postcss',
          severity: 'high',
          isDirect: false,
          range: '<8.5.26',
          fixAvailable: true,
          via: [{ title: 'Parsing error', url: 'https://example.test/GHSA-1' }],
        },
      }),
      'high',
    );
    const body = renderAdvisoryReport(summary, {
      threshold: 'high',
      scannedAt,
      runUrl: 'https://example.test/run/1',
    });

    expect(body).toContain('| `postcss` | high | transitive | `<8.5.26` | fix available |');
    expect(body).toContain('### `postcss` (high)');
    expect(body).toContain('https://example.test/GHSA-1');
    expect(body).toContain('[this workflow run](https://example.test/run/1)');
  });

  it('notes when npm reported no advisory metadata', () => {
    const summary = summarizeAudit(
      auditReport({ ghost: { name: 'ghost', severity: 'critical' } }),
      'high',
    );
    const body = renderAdvisoryReport(summary, { threshold: 'high', scannedAt });

    expect(body).toContain('No advisory metadata reported by npm.');
  });
});
