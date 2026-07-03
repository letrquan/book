/**
 * Prompt builders for action-style built-in slash commands.
 *
 * These mirror /init (src/commands/init-prompt.ts): each produces a crafted,
 * tool-restricted prompt that is sent through the existing agent loop, rather
 * than delegating a vague "do X" to the model. app.tsx pairs each builder with
 * an allowedTools list so the loop cannot escape the task.
 */

/**
 * /review — review the current working-tree diff for correctness and cleanup.
 *
 * Restricted to read/search/git tools; the agent reports findings, it does not
 * apply them. Sensing: read the diff first, walk into referenced source, then
 * surface concrete findings ranked by severity. Args optionally scope to a
 * path or branch (--base <ref>).
 */
export function buildReviewPrompt(args: string): string {
  const scope = args.trim();
  const focus = scope ? `\n\nFocus area: ${scope}` : '';
  return [
    'Review the current working-tree changes for correctness bugs and reuse/simplification/efficiency cleanups.',
    '',
    'Steps:',
    '1. Run `git diff` (and `git status`) to see exactly what changed. If there is no diff, say so and stop.',
    '2. For each changed file, Read enough surrounding context to understand the change — do not review in a vacuum.',
    '3. Report findings as a ranked list, most severe first:',
    '   - Correctness (logic errors, wrong output, crashes, race conditions)',
    '   - Simplification / reuse (duplicate logic, missed shared helper)',
    '   - Efficiency (obvious hot-path waste)',
    '4. For each finding give: file:line, one-sentence summary, a concrete failure scenario, and a suggested fix. Skip a category if it has nothing.',
    '5. Do NOT edit files — this is review only. End with a one-line verdict.',
    focus,
  ].join('\n');
}

/**
 * /security-review — security audit of the pending changes.
 *
 * Hunts for the OWASP-shaped defect classes that matter in a CLI agent: command
 * injection, path traversal, missing permission checks, secret leakage, unsafe
 * deserialization, SSRF. Reads-only; reports findings.
 */
export function buildSecurityReviewPrompt(args: string): string {
  const scope = args.trim();
  const focus = scope ? `\n\nFocus area: ${scope}` : '';
  return [
    'Perform a security review of the current working-tree changes.',
    '',
    'Steps:',
    '1. Run `git diff` to enumerate the changes. If there is no diff, say so and stop.',
    '2. Read changed files in context, then audit each change for:',
    '   - Command injection / improper shell quoting (especially where ExecSync or shell:true is used)',
    '   - Path traversal (unsanitized join() against user/workspace input)',
    '   - Missing or bypassed permission checks (a tool acting without the configured mode)',
    '   - Secret leakage (API keys, tokens, env vars written to logs or files)',
    '   - Unsafe deserialization (JSON.parse on untrusted input) and SSRF in fetches',
    '3. Verify each candidate finding is real (not a false positive) by reading the code path before reporting it.',
    '4. Report only confirmed findings, most severe first: severity, file:line, the untrusted input → exploit scenario, and a recommended fix.',
    '5. If nothing exploitable is found, say so explicitly — do not pad with stylistic notes.',
    focus,
  ].join('\n');
}

/** Tools an agent may use during a /review (read-only + git). */
export const REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'GitStatus', 'GitDiff'] as const;

/** Tools an agent may use during a /security-review (read-only + git). */
export const SECURITY_REVIEW_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'GitStatus',
  'GitDiff',
  'WebSearch',
] as const;
