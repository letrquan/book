import {
  clampConfidence,
  isReviewCategory,
  isReviewSeverity,
  type ReviewFinding,
  type ReviewReport,
} from './types.js';
import { parseJsonObject } from './json.js';

/**
 * Tolerant JSON parsing for model-produced reviews.
 *
 * The prompt asks for a single JSON object. Models still wrap it in prose or
 * code fences, and occasionally emit trailing commas or partial objects. We
 * recover the most useful case (a complete object) and fall back to a
 * prose-only report when parsing fails so a bad shape never loses the review.
 */

interface JsonFinding {
  severity?: unknown;
  category?: unknown;
  file?: unknown;
  line?: unknown;
  summary?: unknown;
  evidence?: unknown;
  failure?: unknown;
  suggestedFix?: unknown;
  confidence?: unknown;
}

interface JsonReport {
  verdict?: unknown;
  findings?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseJson(text: string): JsonReport | undefined {
  return parseJsonObject(text);
}

/** Whether model output satisfies the complete top-level review contract. */
export function isStructuredReviewReport(text: string): boolean {
  const json = parseJson(text);
  return Boolean(
    json &&
    Array.isArray(json.findings) &&
    (json.verdict === 'blocking' ||
      json.verdict === 'recommend' ||
      json.verdict === 'clean' ||
      json.verdict === 'inconclusive'),
  );
}

function coerceFinding(raw: unknown, index: number): ReviewFinding | undefined {
  if (!isRecord(raw)) return undefined;
  const value = raw as JsonFinding;
  if (typeof value.summary !== 'string' || value.summary.trim() === '') return undefined;
  if (typeof value.file !== 'string' || value.file.trim() === '') return undefined;
  if (typeof value.evidence !== 'string' || value.evidence.trim() === '') return undefined;
  if (typeof value.failure !== 'string' || value.failure.trim() === '') return undefined;
  if (typeof value.suggestedFix !== 'string' || value.suggestedFix.trim() === '') return undefined;
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)) return undefined;

  const severity = isReviewSeverity(value.severity) ? value.severity : 'minor';
  const category = isReviewCategory(value.category) ? value.category : 'correctness';
  const line = typeof value.line === 'number' && value.line > 0 ? value.line : undefined;

  return {
    id: `finding-${index + 1}`,
    severity,
    category,
    file: value.file.trim(),
    line,
    summary: value.summary.trim(),
    evidence: value.evidence.trim(),
    failure: value.failure.trim(),
    suggestedFix: value.suggestedFix.trim(),
    confidence: clampConfidence(value.confidence),
  };
}

export interface ParsedReviewReport {
  report: ReviewReport;
  /**
   * Entries in the model's `findings` array that failed the per-finding
   * contract and were discarded. Callers must surface this: a report whose
   * findings were all dropped is otherwise indistinguishable from a clean one.
   */
  droppedFindings: number;
}

export function parseReviewReportDetailed(text: string): ParsedReviewReport {
  const json = parseJson(text);
  if (json) {
    const rawFindings = Array.isArray(json.findings) ? json.findings : [];
    const findings = rawFindings
      .map((raw, index) => coerceFinding(raw, index))
      .filter((finding): finding is ReviewFinding => finding !== undefined);

    const verdict =
      json.verdict === 'blocking' ||
      json.verdict === 'recommend' ||
      json.verdict === 'clean' ||
      json.verdict === 'inconclusive'
        ? json.verdict
        : findings.length > 0
          ? 'recommend'
          : 'inconclusive';

    return { report: { verdict, findings }, droppedFindings: rawFindings.length - findings.length };
  }

  // No structured block: preserve the prose without inventing findings.
  return { report: { verdict: 'inconclusive', findings: [] }, droppedFindings: 0 };
}

export function parseReviewReport(text: string): ReviewReport {
  return parseReviewReportDetailed(text).report;
}

export function formatFinding(finding: ReviewFinding): string {
  const line = finding.line ? `:${finding.line}` : '';
  const confidence = `${finding.confidence}%`;
  const fix = finding.suggestedFix ? `\n  Fix: ${finding.suggestedFix}` : '';
  const evidence = finding.evidence ? `\n  Evidence: ${finding.evidence}` : '';
  const failure = finding.failure ? `\n  Failure: ${finding.failure}` : '';
  return [
    `[${finding.severity}] ${finding.category} — ${finding.file}${line} (${confidence})`,
    `  ${finding.summary}${evidence}${failure}${fix}`,
  ].join('\n');
}

export function renderReviewReport(report: ReviewReport): string {
  if (report.findings.length === 0) {
    return 'Review: no structured findings were returned (see raw review text).';
  }
  return [`Verdict: ${report.verdict}`, '', ...report.findings.map(formatFinding)].join('\n');
}
