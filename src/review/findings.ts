import { DEFAULT_CONFIDENCE_THRESHOLD, type ReviewFinding, type ReviewSeverity } from './types.js';

const SEVERITY_WEIGHT: Record<ReviewSeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  nit: 1,
};

/**
 * Deterministic key for a finding location. Shared with the evaluation harness
 * so golden expectations and produced findings are keyed identically.
 */
export function locationKey(file: string, line: number | undefined, summary: string): string {
  const normalizedFile = file.replace(/\\/g, '/').toLowerCase();
  const normalizedSummary = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${normalizedFile}:${line ?? 'unknown'}:${normalizedSummary}`;
}

/** Deterministic key used to collapse duplicate findings across review passes. */
export function findingKey(finding: ReviewFinding): string {
  return locationKey(finding.file, finding.line, finding.summary);
}

export function dedupeFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const seen = new Map<string, ReviewFinding>();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = seen.get(key);
    // Prefer severity first: a high-confidence low-severity restatement must not
    // erase a material finding at the same location.
    if (
      !existing ||
      SEVERITY_WEIGHT[finding.severity] > SEVERITY_WEIGHT[existing.severity] ||
      (finding.severity === existing.severity && finding.confidence > existing.confidence)
    ) {
      seen.set(key, finding);
    }
  }
  return [...seen.values()];
}

/**
 * Rank by severity first, then confidence, then location. Most severe first.
 * This mirrors the "rank findings by severity" decision in peer reviewers.
 */
export function rankFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((left, right) => {
    const severity = SEVERITY_WEIGHT[right.severity] - SEVERITY_WEIGHT[left.severity];
    if (severity !== 0) return severity;
    const confidence = right.confidence - left.confidence;
    if (confidence !== 0) return confidence;
    return findingKey(left).localeCompare(findingKey(right));
  });
}

export function filterLowConfidence(
  findings: readonly ReviewFinding[],
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): ReviewFinding[] {
  return findings.filter((finding) => finding.confidence >= threshold);
}
