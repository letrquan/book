# Review Quality Rubric v1

The authoritative artifact is `review-quality-v1.json` (`1.0.0`). It is calibration-only. This
Markdown file is a readable summary and cannot be used as a decision-bearing substitute.

Five equal-weight 0-4 dimensions cover authorization correctness, severity calibration, exact code
evidence, actionable remediation, and finding integrity. The pass threshold is 3.0. Fabricated code
evidence or protected-data disclosure is a hard failure.

Decision-bearing use requires the complete Phase 0 human protocol: a pinned blind evidence packet,
two authenticated calibrated independent human primaries, per-dimension evidence, current pool and
production reliability, and a blind third reviewer only for bounded adjudication. Calibration uses
at least 30 artifacts, ordinal Krippendorff alpha at least 0.80 with a 95% lower bound at least 0.67,
at least 90% anchor agreement, 100% seeded hard-failure detection, and at least 10% blind
duplicates. Missing or failed requirements yield `unknown`. Model assistance is advisory only.
