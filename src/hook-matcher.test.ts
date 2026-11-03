import { describe, expect, it } from 'vitest';
import { hookMatcherAlternatives, hookMatcherTargetsTool } from './hook-matcher.js';

describe('hookMatcherAlternatives (#656)', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['only separators', ' | '],
  ])('reads a %s matcher as every tool call', (_name, matcher) => {
    expect(hookMatcherAlternatives(matcher)).toBeUndefined();
  });

  it('reads `*`, trimmed, as an alternative for every tool', () => {
    expect(hookMatcherAlternatives('*')).toEqual([{ tool: '*', pattern: null }]);
    expect(hookMatcherAlternatives(' * ')).toEqual([{ tool: '*', pattern: null }]);
  });

  it("splits Claude Code's alternation into tools, trimming each and dropping empty ones", () => {
    expect(hookMatcherAlternatives('Edit|Write')).toEqual([
      { tool: 'Edit', pattern: null },
      { tool: 'Write', pattern: null },
    ]);
    expect(hookMatcherAlternatives(' Edit | Write |')).toEqual([
      { tool: 'Edit', pattern: null },
      { tool: 'Write', pattern: null },
    ]);
  });

  it('splits on a `|` outside parentheses only', () => {
    expect(hookMatcherAlternatives('Bash(echo a|b)|Read')).toEqual([
      { tool: 'Bash', pattern: 'echo a|b' },
      { tool: 'Read', pattern: null },
    ]);
    expect(hookMatcherAlternatives('Bash(ls *)|Edit(src/**)')).toEqual([
      { tool: 'Bash', pattern: 'ls *' },
      { tool: 'Edit', pattern: 'src/**' },
    ]);
  });

  it('reads each alternative as a permission rule does: the pattern runs to its last `)`', () => {
    expect(hookMatcherAlternatives('Bash(echo (a))')).toEqual([
      { tool: 'Bash', pattern: 'echo (a)' },
    ]);
    expect(hookMatcherAlternatives('Bash()')).toEqual([{ tool: 'Bash', pattern: null }]);
    // An unclosed pattern leaves the tool name alone, as before: every call of the tool.
    expect(hookMatcherAlternatives('Bash(ls *')).toEqual([{ tool: 'Bash', pattern: null }]);
    expect(hookMatcherAlternatives('Bash(ls *|Read')).toEqual([{ tool: 'Bash', pattern: null }]);
  });

  it('keeps a pattern written after `*`', () => {
    expect(hookMatcherAlternatives('*(src/**)')).toEqual([{ tool: '*', pattern: 'src/**' }]);
  });
});

describe('hookMatcherTargetsTool (#656)', () => {
  it.each([
    'ToolSearch',
    ' ToolSearch ',
    'ToolSearch(select:*)',
    'ToolSearch|WebFetch',
    'WebFetch|ToolSearch(select:*)',
    // Named is named, whatever else the alternation also matches.
    'ToolSearch|*',
    // A pattern on every tool reads ToolSearch's query too, and only some calls match it.
    '*(select:*)',
    'Edit|*(src/**)',
  ])('finds ToolSearch targeted by %s', (matcher) => {
    expect(hookMatcherTargetsTool(matcher, 'ToolSearch')).toBe(true);
  });

  it.each([undefined, '', '*', ' * ', '*|Edit', 'Edit|Write', 'Bash(ToolSearch)', 'toolsearch'])(
    'does not find it targeted by %s',
    (matcher) => {
      expect(hookMatcherTargetsTool(matcher, 'ToolSearch')).toBe(false);
    },
  );
});
