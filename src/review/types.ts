/**
 * Review domain types.
 *
 * Findings are machine-readable so they can be deduplicated, ranked, verified,
 * and (later) applied without re-parsing prose. Keep this module dependency-free
 * so the architecture check cannot find a cycle through it.
 */

export const REVIEW_SEVERITIES = ['critical', 'major', 'minor', 'nit'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export const REVIEW_CATEGORIES = [
  'correctness',
  'security',
  'simplification',
  'efficiency',
  'conventions',
  'tests',
] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export type ReviewVerdict = 'blocking' | 'recommend' | 'clean' | 'inconclusive';

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  file: string;
  line?: number;
  summary: string;
  /** Exact code/behavior that proves the issue exists. */
  evidence: string;
  /** Concrete failure scenario the issue causes. */
  failure: string;
  /** Concrete, actionable fix. */
  suggestedFix?: string;
  /** Model self-assessed confidence in the 0-100 range. */
  confidence: number;
  /** Set by the verification pass; absent before verification. */
  verification?: ReviewVerificationState;
  verificationReason?: string;
}

export interface ReviewReport {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  /** Operational coverage metadata for deep reviews. */
  coverage?: ReviewCoverage;
}

export interface ReviewCoverageEntry {
  id: string;
  status: 'completed' | 'failed' | 'timed_out' | 'unstructured';
  findings: number;
  error?: string;
}

export interface ReviewCoverage {
  reviewers: ReviewCoverageEntry[];
  verifier?: ReviewCoverageEntry;
}

export type ReviewVerificationState = 'confirmed' | 'rejected' | 'inconclusive';

export interface VerificationVerdict {
  findingId: string;
  state: ReviewVerificationState;
  reason: string;
}

/** Parsed `/review` invocation target. */
export interface ReviewScope {
  base?: string;
  target?: string;
  deep: boolean;
  fix: boolean;
  help: boolean;
  /** User-facing parse error. Absent for a valid invocation. */
  error?: string;
}

export const DEFAULT_CONFIDENCE_THRESHOLD = 70;

export function isReviewSeverity(value: unknown): value is ReviewSeverity {
  return typeof value === 'string' && (REVIEW_SEVERITIES as readonly string[]).includes(value);
}

export function isReviewCategory(value: unknown): value is ReviewCategory {
  return typeof value === 'string' && (REVIEW_CATEGORIES as readonly string[]).includes(value);
}

export function clampConfidence(value: unknown): number {
  // Missing or malformed confidence must fail closed. Returning the threshold
  // itself would let an otherwise invalid finding pass a >= threshold filter.
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
