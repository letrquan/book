import { DEFAULT_CONFIDENCE_THRESHOLD, type ReviewFinding, type ReviewSeverity } from './types.js';

const SEVERITY_WEIGHT: Record<ReviewSeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  nit: 1,
};

/** Deterministic key used to collapse duplicate findings across review passes. */
export function findingKey(finding: ReviewFinding): string {
  const file = finding.file.replace(/\\/g, '/').toLowerCase();
  const line = finding.line ?? 0;
  return `${finding.category}:${file}:${line}`;
}

export function dedupeFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const seen = new Map<string, ReviewFinding>();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = seen.get(key);
    // Keep the higher-confidence instance when reviewers collide on a location.
    if (!existing || finding.confidence > existing.confidence) {
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
