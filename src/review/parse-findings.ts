import {
  clampConfidence,
  isReviewCategory,
  isReviewSeverity,
  type ReviewFinding,
  type ReviewReport,
} from './types.js';

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

function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.indexOf('{');
  if (start === -1) return undefined;

  // Walk to the matching closing brace, respecting nested objects/strings.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function parseJson(text: string): JsonReport | undefined {
  const candidate = extractJsonObject(text);
  if (!candidate) return undefined;
  try {
    const value: unknown = JSON.parse(candidate);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function coerceFinding(raw: unknown, index: number): ReviewFinding | undefined {
  if (!isRecord(raw)) return undefined;
  const value = raw as JsonFinding;
  if (typeof value.summary !== 'string' || value.summary.trim() === '') return undefined;
  if (typeof value.file !== 'string' || value.file.trim() === '') return undefined;

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
    evidence: typeof value.evidence === 'string' ? value.evidence.trim() : '',
    failure: typeof value.failure === 'string' ? value.failure.trim() : '',
    suggestedFix:
      typeof value.suggestedFix === 'string' && value.suggestedFix.trim()
        ? value.suggestedFix.trim()
        : undefined,
    confidence: clampConfidence(value.confidence),
  };
}

export function parseReviewReport(text: string): ReviewReport {
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

    return { verdict, findings };
  }

  // No structured block: preserve the prose without inventing findings.
  return { verdict: 'inconclusive', findings: [] };
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
