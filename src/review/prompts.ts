import { loadReviewConfig, renderReviewConfigInstruction, type ReviewConfig } from './config.js';
import { parseReviewScope } from './scope.js';
import { DEFAULT_CONFIDENCE_THRESHOLD } from './types.js';
import type { ReviewTarget } from './target.js';
import { renderReviewTarget } from './target.js';

/**
 * Review prompt builders.
 *
 * The orchestrated review prompts are precision-biased: hand the reviewer an
 * immutable target, make it segment and localize before it reports, require
 * evidence, and suppress the false-positive classes that erode trust.
 *
 * Orchestrated reviewers never select their own scope. The host resolves the
 * diff once (see `target.ts`) and embeds it here, so `target` is required —
 * that is why the reviewer agent needs no diff tool at all.
 */

const SEVERITY_RUBRIC = [
  'Severity (choose exactly one):',
  '- critical: breaks production, data loss, security boundary, or a crash in a main path.',
  '- major: incorrect behavior or a clear regression in a real path.',
  '- minor: edge-case bug or a worthwhile correctness hardening.',
  '- nit: convention or style only. Suppress these unless project rules require them.',
].join('\n');

const ANTI_NOISE = [
  'Suppress false positives — they erode trust:',
  '- Pre-existing issues not introduced by this change.',
  '- Intentional behavior or design decisions evident from the change and surrounding context.',
  '- Code that looks like a bug but is actually correct.',
  '- Pedantic nitpicks and general style preferences.',
  '- Anything a linter or formatter already catches.',
  '- Findings without a concrete failure scenario.',
].join('\n');

const STRUCTURED_OUTPUT = [
  'Report your final result ONLY as a single JSON object:',
  '{"verdict":"blocking|recommend|clean|inconclusive","findings":[{',
  '"severity":"critical|major|minor|nit",',
  '"category":"correctness|security|simplification|efficiency|conventions|tests",',
  '"file":"relative/path","line":123,',
  '"summary":"one sentence","evidence":"exact code that proves it",',
  '"failure":"concrete failure scenario","suggestedFix":"a concrete, actionable fix",',
  '"confidence":0}}...]}',
  'Each finding MUST include file, severity, summary, evidence, failure, suggestedFix, and a',
  `confidence between 0 and 100. Findings below ${DEFAULT_CONFIDENCE_THRESHOLD} confidence are discarded;`,
  'prefer to omit them yourself.',
].join('\n');

function scopeInstruction(args: string): string {
  const scope = parseReviewScope(args);
  const parts: string[] = [];
  if (scope.base) parts.push(`Compare against base ref "${scope.base}".`);
  if (scope.target) parts.push(`Restrict review to: ${scope.target}.`);
  return parts.join(' ');
}

function reviewSteps(target: ReviewTarget): string {
  return [
    '1. Use the immutable review target below to enumerate the change. If it is empty, say so and stop.',
    '2. Split the change into reviewable units (per file, then per hunk/function).',
    renderReviewTarget(target),
  ].join('\n');
}

function correctnessRubric(target: ReviewTarget): string {
  return [
    'Steps:',
    reviewSteps(target),
    '3. For each unit, Read just enough surrounding context to understand the change. Never review in a vacuum.',
    '4. For each finding, localize it to an exact file:line and cite the exact code (evidence) before',
    '   explaining it. Include a concrete failure scenario and a concrete suggested fix.',
    '5. Rank findings most severe first. Skip a category when it has nothing to say.',
    '6. Do NOT edit files — this is review only.',
    '',
    SEVERITY_RUBRIC,
    '',
    ANTI_NOISE,
    '',
    STRUCTURED_OUTPUT,
  ].join('\n');
}

function configInstruction(config: ReviewConfig): string {
  const rendered = renderReviewConfigInstruction(config);
  return rendered ? `${rendered}\n` : '';
}

/** Structured single-pass prompt used by the host-managed review path. */
export function buildSingleReviewPrompt(workspace: string, target: ReviewTarget): string {
  return [
    'Review the selected change for correctness bugs, security risks, and worthwhile cleanup.',
    configInstruction(loadReviewConfig(workspace)),
    correctnessRubric(target),
  ]
    .filter(Boolean)
    .join('\n');
}

const SECURITY_CLASSES = [
  '   - Command injection / improper shell quoting (especially ExecSync or shell:true).',
  '   - Path traversal (unsanitized join against user/workspace input).',
  '   - Missing or bypassed permission checks (a tool acting without the configured mode).',
  '   - Secret leakage (API keys, tokens, env vars written to logs or files).',
  '   - Unsafe deserialization (JSON.parse on untrusted input) and SSRF in fetches.',
].join('\n');

export function buildSecurityReviewPrompt(args: string, workspace?: string): string {
  const config = workspace ? loadReviewConfig(workspace) : {};
  const scoped = scopeInstruction(args);
  return [
    'Perform a security review of the current working-tree changes.',
    configInstruction(config),
    'Steps:',
    '1. Run `git status` and `git diff` to enumerate the changes. If there is no diff, say so and stop.',
    '2. Split the change into reviewable units and Read each in context. Audit for:',
    SECURITY_CLASSES,
    '3. Verify each candidate finding is real (not a false positive) by reading the code path before reporting it.',
    '4. Report only confirmed findings, most severe first.',
    '',
    SEVERITY_RUBRIC,
    '',
    ANTI_NOISE,
    '',
    'Return a concise human-readable security review, most severe finding first, then a one-line verdict.',
    scoped,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Specialized lenses used by the deep-review orchestrator. */
export const REVIEW_LENSES = [
  {
    id: 'correctness',
    title: 'correctness and regressions',
    focus:
      'logic errors, wrong output, crashes, race conditions, broken edge cases, and subtle regressions introduced by this change.',
  },
  {
    id: 'security',
    title: 'security',
    focus: SECURITY_CLASSES.replace(/\n\s+/g, '\n').replace(/\s+\(/g, ' ('),
  },
  {
    id: 'simplification',
    title: 'simplification and reuse',
    focus: 'duplicate logic, missed shared helpers, and over-complicated new code.',
  },
  {
    id: 'efficiency',
    title: 'efficiency and conventions',
    focus: 'obvious hot-path waste and clear violations of project conventions.',
  },
] as const;

export function buildReviewerPrompt(
  lens: (typeof REVIEW_LENSES)[number],
  workspace: string,
  target: ReviewTarget,
): string {
  return [
    `You are the ${lens.title} reviewer. Review ONLY for: ${lens.focus}`,
    configInstruction(loadReviewConfig(workspace)),
    'Steps:',
    reviewSteps(target),
    '3. For each unit, Read just enough surrounding context to understand the change.',
    '4. For each finding, localize it to an exact file:line and cite the exact code (evidence).',
    '   Include a concrete failure scenario and a concrete suggested fix.',
    '5. Do NOT edit files and do NOT review other categories.',
    '',
    SEVERITY_RUBRIC,
    '',
    ANTI_NOISE,
    '',
    STRUCTURED_OUTPUT,
  ]
    .filter(Boolean)
    .join('\n');
}
