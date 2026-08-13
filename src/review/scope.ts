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
 * treated as a path or `base...head` range. Unknown flags are treated as a
 * target rather than silently dropped, so a typo is still visible to the agent.
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
      if (!value) {
        scope.target = '--base';
        continue;
      }
      scope.base = value;
      index++;
      continue;
    }
    if (token.startsWith('--base=')) {
      scope.base = token.slice('--base='.length);
      continue;
    }
    if (token.startsWith('--')) {
      // Unknown flag: keep it visible to the agent rather than ignoring it.
      targets.push(token);
      continue;
    }
    targets.push(token);
  }

  if (targets.length > 0) scope.target = targets.join(' ');
  return scope;
}
