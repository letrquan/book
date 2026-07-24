import { describe, it, expect } from 'vitest';
import { parseRule, evaluatePermission, primaryArgForRule } from './permissions.js';
import { DEFAULT_SETTINGS, type ResolvedSettings } from './settings.js';

describe('parseRule', () => {
  it('parses bare tool name', () => {
    expect(parseRule('Bash')).toEqual({ toolName: 'Bash', pattern: null });
  });

  it('parses tool with specifier', () => {
    expect(parseRule('Bash(git *)')).toEqual({ toolName: 'Bash', pattern: 'git *' });
  });

  it('parses tool with path specifier', () => {
    expect(parseRule('Read(./.env)')).toEqual({ toolName: 'Read', pattern: './.env' });
  });

  it('parses tool with globstar', () => {
    expect(parseRule('Read(./secrets/**)')).toEqual({
      toolName: 'Read',
      pattern: './secrets/**',
    });
  });

  it('parses tool with empty parens as match-all', () => {
    expect(parseRule('Bash()')).toEqual({ toolName: 'Bash', pattern: null });
  });

  it('trims whitespace', () => {
    expect(parseRule('  Bash ( git * )  ')).toEqual({
      toolName: 'Bash',
      pattern: 'git *',
    });
  });

  it('handles malformed parens gracefully', () => {
    expect(parseRule('Bash(git *')).toEqual({ toolName: 'Bash', pattern: null });
  });
});

describe('primaryArgForRule', () => {
  it('extracts command from bash', () => {
    expect(primaryArgForRule('Bash', { command: 'git diff\nmore' })).toBe('git diff');
  });

  it('extracts filePath', () => {
    expect(primaryArgForRule('Read', { filePath: './.env' })).toBe('./.env');
  });

  it('extracts pattern from grep', () => {
    expect(primaryArgForRule('Grep', { pattern: 'TODO' })).toBe('TODO');
  });

  it('prefers taskId before mutable fields', () => {
    expect(primaryArgForRule('TaskUpdate', { status: 'completed', taskId: '1' })).toBe('1');
    expect(primaryArgForRule('TaskUpdate', { task_id: '2', subject: 'Rename' })).toBe('2');
  });

  it('extracts url from WebFetch', () => {
    expect(primaryArgForRule('WebFetch', { url: 'https://example.com' })).toBe(
      'https://example.com',
    );
  });

  it('falls back to first string arg', () => {
    expect(primaryArgForRule('Unknown', { foo: 'bar' })).toBe('bar');
  });

  it('returns empty string for no args', () => {
    expect(primaryArgForRule('git_status', {})).toBe('');
  });
});

describe('evaluatePermission', () => {
  function settings(overrides: Partial<ResolvedSettings['permissions']> = {}): ResolvedSettings {
    return {
      ...DEFAULT_SETTINGS,
      permissions: { ...DEFAULT_SETTINGS.permissions, ...overrides },
    };
  }

  it('returns ask when no rules match', () => {
    expect(evaluatePermission('Bash', { command: 'ls' }, settings())).toBe('ask');
  });

  it('allow rule matches exact command', () => {
    const s = settings({ allow: ['Bash(git *)'] });
    expect(evaluatePermission('Bash', { command: 'git diff' }, s)).toBe('allow');
  });

  it('allow rule does not match different command', () => {
    const s = settings({ allow: ['Bash(git *)'] });
    expect(evaluatePermission('Bash', { command: 'rm -rf /' }, s)).toBe('ask');
  });

  it('deny beats allow', () => {
    const s = settings({
      deny: ['Bash(rm *)'],
      allow: ['Bash(rm *)'],
    });
    expect(evaluatePermission('Bash', { command: 'rm -rf /' }, s)).toBe('deny');
  });

  it('ask beats allow', () => {
    const s = settings({
      ask: ['Bash(git push *)'],
      allow: ['Bash(git *)'],
    });
    expect(evaluatePermission('Bash', { command: 'git push origin' }, s)).toBe('ask');
  });

  it('deny beats ask', () => {
    const s = settings({
      deny: ['Bash(rm *)'],
      ask: ['Bash(rm *)'],
    });
    expect(evaluatePermission('Bash', { command: 'rm -rf /' }, s)).toBe('deny');
  });

  it('bare tool name matches any argument', () => {
    const s = settings({ deny: ['WebFetch'] });
    expect(evaluatePermission('WebFetch', { url: 'https://evil.com' }, s)).toBe('deny');
    expect(evaluatePermission('WebFetch', { url: 'https://safe.com' }, s)).toBe('deny');
  });

  it('globstar matches across path separators', () => {
    const s = settings({ deny: ['Read(./secrets/**)'] });
    expect(evaluatePermission('Read', { filePath: './secrets/db/passwords.txt' }, s)).toBe('deny');
    expect(evaluatePermission('Read', { filePath: './src/main.ts' }, s)).toBe('ask');
  });

  it('glob matches everything including path separators in permission context', () => {
    // In permission-rules, * matches any chars (not just single segment).
    const s = settings({ deny: ['Read(./*.env)'] });
    expect(evaluatePermission('Read', { filePath: './.env' }, s)).toBe('deny');
    expect(evaluatePermission('Read', { filePath: './subdir/.env' }, s)).toBe('deny');
  });

  it('path normalization: ./ prefix stripped so Read(./.env) matches .env', () => {
    const s = settings({ deny: ['Read(./.env)'] });
    expect(evaluatePermission('Read', { filePath: '.env' }, s)).toBe('deny');
    expect(evaluatePermission('Read', { filePath: './.env' }, s)).toBe('deny');
  });

  it('multiple rules in same category all evaluated', () => {
    const s = settings({
      allow: ['Bash(ls *)', 'Bash(pwd)'],
    });
    expect(evaluatePermission('Bash', { command: 'ls -la' }, s)).toBe('allow');
    expect(evaluatePermission('Bash', { command: 'pwd' }, s)).toBe('allow');
    expect(evaluatePermission('Bash', { command: 'cat /etc/passwd' }, s)).toBe('ask');
  });

  it('applies legacy Edit and Write rules to ApplyPatch targets', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch';
    expect(evaluatePermission('ApplyPatch', { patch }, settings({ allow: ['Edit(src/**)'] }))).toBe(
      'allow',
    );
    expect(
      evaluatePermission('ApplyPatch', { patch }, settings({ deny: ['Write(src/a.ts)'] })),
    ).toBe('deny');
  });

  it('limits legacy ApplyPatch compatibility to the granted mutation capability', () => {
    const update = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch';
    const add = '*** Begin Patch\n*** Add File: src/a.ts\n+new\n*** End Patch';
    const del = '*** Begin Patch\n*** Delete File: src/a.ts\n*** End Patch';

    expect(
      evaluatePermission('ApplyPatch', { patch: update }, settings({ allow: ['Edit(src/**)'] })),
    ).toBe('allow');
    expect(
      evaluatePermission('ApplyPatch', { patch: add }, settings({ allow: ['Edit(src/**)'] })),
    ).toBe('ask');
    expect(
      evaluatePermission('ApplyPatch', { patch: del }, settings({ allow: ['Edit(src/**)'] })),
    ).toBe('ask');
    expect(
      evaluatePermission('ApplyPatch', { patch: update }, settings({ allow: ['Write(src/**)'] })),
    ).toBe('allow');
    expect(
      evaluatePermission('ApplyPatch', { patch: add }, settings({ allow: ['Write(src/**)'] })),
    ).toBe('allow');
    expect(
      evaluatePermission('ApplyPatch', { patch: del }, settings({ allow: ['Write(src/**)'] })),
    ).toBe('ask');
    expect(
      evaluatePermission('ApplyPatch', { patch: del }, settings({ allow: ['ApplyPatch(src/**)'] })),
    ).toBe('allow');
  });

  it('does not apply legacy deny rules to unsupported patch operations', () => {
    const add = '*** Begin Patch\n*** Add File: src/a.ts\n+new\n*** End Patch';
    const del = '*** Begin Patch\n*** Delete File: src/a.ts\n*** End Patch';
    const s = settings({
      deny: ['Edit(src/**)', 'Write(src/**)'],
      allow: ['ApplyPatch(src/**)'],
    });

    expect(evaluatePermission('ApplyPatch', { patch: add }, s)).toBe('deny');
    expect(
      evaluatePermission(
        'ApplyPatch',
        { patch: del },
        settings({ deny: ['Write(src/**)'], allow: ['ApplyPatch(src/**)'] }),
      ),
    ).toBe('allow');
  });

  it('applies a direct match-all ApplyPatch deny before patch validation', () => {
    expect(evaluatePermission('ApplyPatch', {}, settings({ deny: ['ApplyPatch'] }))).toBe('deny');
  });

  it('requires every ApplyPatch target to be covered by a path allow rule', () => {
    const patch =
      '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Update File: docs/a.md\n@@\n-old\n+new\n*** End Patch';
    expect(evaluatePermission('ApplyPatch', { patch }, settings({ allow: ['Edit(src/**)'] }))).toBe(
      'ask',
    );
  });
});
