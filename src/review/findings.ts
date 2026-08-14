import { DEFAULT_CONFIDENCE_THRESHOLD, type ReviewFinding, type ReviewSeverity } from './types.js';

const SEVERITY_WEIGHT: Record<ReviewSeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  nit: 1,
};

function normalizeFile(file: string): string {
  return file.replace(/\\/g, '/').toLowerCase();
}

function normalizeSummary(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Identity key for a single finding, including its exact wording.
 *
 * This is a *matching* key, not a dedup key: the evaluation harness uses it to
 * line golden expectations up with produced findings, so two findings that
 * differ only in phrasing must key differently. Production dedup deliberately
 * uses the coarser {@link findingKey} plus a similarity check — see
 * {@link dedupeFindings}.
 */
export function locationKey(file: string, line: number | undefined, summary: string): string {
  return `${normalizeFile(file)}:${line ?? 'unknown'}:${normalizeSummary(summary)}`;
}

/**
 * Bucket key used to collapse duplicate findings across review passes.
 *
 * Deliberately excludes the summary. Independent reviewers describe the same
 * defect in different words, so a wording-sensitive key would never collapse
 * the cross-reviewer duplicates that dedup exists to remove. Two genuinely
 * different defects can share a bucket, which is why bucket members are
 * additionally compared by {@link summariesDescribeSameFinding}.
 */
export function findingKey(finding: ReviewFinding): string {
  return `${finding.category}:${normalizeFile(finding.file)}:${finding.line ?? 'unknown'}`;
}

/**
 * Words carrying no signal about *which* defect a summary describes. Removing
 * them keeps the overlap measure from being dominated by sentence scaffolding.
 */
const SUMMARY_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'but',
  'by',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'in',
  'into',
  'is',
  'it',
  'its',
  'may',
  'might',
  'not',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'this',
  'to',
  'when',
  'which',
  'will',
  'with',
  'would',
]);

function significantTokens(summary: string): Set<string> {
  return new Set(
    normalizeSummary(summary)
      .split(' ')
      .filter((token) => token.length > 2 && !SUMMARY_STOPWORDS.has(token)),
  );
}

/**
 * Fraction of the shorter summary's significant tokens that the longer one also
 * uses. Two reviewers must agree on at least this much of the smaller summary
 * before their findings are treated as the same defect.
 */
const SUMMARY_OVERLAP_THRESHOLD = 0.5;

/**
 * Shared tokens required before the ratio is trusted. One token in common is
 * usually a generic noun ("bug", "error", "check") that two *different* defects
 * on the same line would also share.
 */
const MIN_SHARED_TOKENS = 2;

/**
 * Whether two summaries for the same file/line/category describe one defect.
 *
 * Uses the overlap coefficient rather than Jaccard so that a terse summary and
 * a verbose one describing the same defect still match — verbosity differences
 * between reviewers are common and are not evidence of a different finding.
 */
export function summariesDescribeSameFinding(left: string, right: string): boolean {
  const leftTokens = significantTokens(left);
  const rightTokens = significantTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return normalizeSummary(left) === normalizeSummary(right);
  }
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared++;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  // A one-word summary can only ever share one token; require all of it instead.
  return (
    shared >= Math.min(MIN_SHARED_TOKENS, smaller) && shared / smaller >= SUMMARY_OVERLAP_THRESHOLD
  );
}

/** Keep the finding that better represents a collapsed group. */
function preferred(left: ReviewFinding, right: ReviewFinding): ReviewFinding {
  // Severity first: a high-confidence low-severity restatement must not erase a
  // material finding at the same location.
  const severity = SEVERITY_WEIGHT[right.severity] - SEVERITY_WEIGHT[left.severity];
  if (severity !== 0) return severity > 0 ? right : left;
  return right.confidence > left.confidence ? right : left;
}

/**
 * Collapse duplicate findings reported by independent review passes.
 *
 * Findings are bucketed by category/file/line, then each bucket is clustered by
 * summary similarity so that the same defect described two ways collapses while
 * two distinct defects on one line stay separate. Clustering walks the input in
 * order and joins the first matching cluster, so the result is deterministic for
 * a given input order (reviewer results are concatenated in lens order).
 */
export function dedupeFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const buckets = new Map<string, ReviewFinding[]>();
  for (const finding of findings) {
    const bucket = buckets.get(findingKey(finding));
    if (!bucket) {
      buckets.set(findingKey(finding), [finding]);
      continue;
    }
    const match = bucket.findIndex((candidate) =>
      summariesDescribeSameFinding(candidate.summary, finding.summary),
    );
    if (match === -1) bucket.push(finding);
    else bucket[match] = preferred(bucket[match]!, finding);
  }
  return [...buckets.values()].flat();
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
    // Total order: findingKey alone ties for distinct findings sharing a bucket.
    return locationKey(left.file, left.line, left.summary).localeCompare(
      locationKey(right.file, right.line, right.summary),
    );
  });
}

export function filterLowConfidence(
  findings: readonly ReviewFinding[],
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): ReviewFinding[] {
  return findings.filter((finding) => finding.confidence >= threshold);
}
