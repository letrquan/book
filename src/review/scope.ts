import type { ReviewScope } from './types.js';

export const REVIEW_USAGE = [
  'Usage: /review [--base <ref>] [--deep] [--fix] [path | <base>...<head>]',
  '',
  '  (no args)      Review the working-tree diff (plus untracked changes).',
  '  --base <ref>   Review changes relative to a git ref.',
  '  --deep         Run parallel specialized reviewers with independent verification.',
  '  --fix          After a deep review, apply verified findings through the patcher/validator pipeline.',
  '  path           Restrict review to a file or directory.',
  '  <base>...<head>  Review a commit/ref range.',
].join('\n');

/**
 * Parse `/review` arguments into a ReviewScope.
 *
 * `--base <ref>`, `--deep`, and `--fix` are flags; the first remaining token is
 * treated as a path or `base...head` range. Invalid invocations are rejected
 * before any reviewer is started so a typo cannot silently widen the scope.
 */
export function parseReviewScope(rawArguments: string): ReviewScope {
  const scope: ReviewScope = { deep: false, fix: false, help: false };
  const tokens = rawArguments.trim().split(/\s+/).filter(Boolean);
  const targets: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--help' || token === '-h') {
      scope.help = true;
      continue;
    }
    if (token === '--deep') {
      scope.deep = true;
      continue;
    }
    if (token === '--fix') {
      scope.fix = true;
      scope.deep = true;
      continue;
    }
    if (token === '--base') {
      const value = tokens[index + 1];
      if (!value || value.startsWith('--')) {
        scope.error = 'Missing value for --base.';
        continue;
      }
      scope.base = value;
      index++;
      continue;
    }
    if (token.startsWith('--base=')) {
      const value = token.slice('--base='.length);
      if (!value) scope.error = 'Missing value for --base.';
      else scope.base = value;
      continue;
    }
    if (token.startsWith('--')) {
      scope.error ??= `Unknown review option: ${token}`;
      continue;
    }
    targets.push(token);
  }

  if (targets.length > 0) scope.target = targets.join(' ');
  return scope;
}
