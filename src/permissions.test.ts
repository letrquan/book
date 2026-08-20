import { describe, it, expect } from 'vitest';
import {
  evaluatePermission,
  evaluatePermissionDetail,
  parseRule,
  permissionRuleForToolCall,
  permissionRuleMatchesCall,
  primaryArgForRule,
} from './permissions.js';
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

describe('remembered permission rules', () => {
  it('scopes WebFetch to an origin and WebSearch to the configured tool', () => {
    const fetchCall = {
      id: 'fetch',
      name: 'WebFetch',
      arguments: { url: 'https://docs.example.com/guide' },
    };
    const sameOrigin = {
      ...fetchCall,
      id: 'same',
      arguments: { url: 'https://docs.example.com/reference/api' },
    };
    const originRoot = {
      ...fetchCall,
      id: 'root',
      arguments: { url: 'https://docs.example.com' },
    };
    const queryOnly = {
      ...fetchCall,
      id: 'query',
      arguments: { url: 'https://docs.example.com?tab=api' },
    };
    const otherOrigin = {
      ...fetchCall,
      id: 'other',
      arguments: { url: 'https://status.example.com/' },
    };
    const rule = permissionRuleForToolCall(fetchCall);

    expect(rule).toBe('WebFetch(https://docs.example.com/**)');
    expect(permissionRuleMatchesCall(rule, sameOrigin)).toBe(true);
    expect(permissionRuleMatchesCall(rule, originRoot)).toBe(true);
    expect(permissionRuleMatchesCall(rule, queryOnly)).toBe(true);
    expect(permissionRuleMatchesCall(rule, otherOrigin)).toBe(false);
    expect(
      permissionRuleForToolCall({
        id: 'search',
        name: 'WebSearch',
        arguments: { query: 'release notes' },
      }),
    ).toBe('WebSearch');
  });

  it('matches a bare MCP server namespace without widening to other servers', () => {
    const search = { id: '1', name: 'mcp__github__search', arguments: { query: 'book' } };
    const create = { id: '2', name: 'mcp__github__create_issue', arguments: { title: 'Bug' } };
    const other = { id: '3', name: 'mcp__git__search', arguments: { query: 'book' } };

    expect(permissionRuleMatchesCall('mcp__github', search)).toBe(true);
    expect(permissionRuleMatchesCall('mcp__github', create)).toBe(true);
    expect(permissionRuleMatchesCall('mcp__github', other)).toBe(false);
    expect(permissionRuleMatchesCall('mcp__github__search', create)).toBe(false);
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

  it('matches persisted WebFetch origin rules for root and query-only URLs', () => {
    const s = settings({ allow: ['WebFetch(https://docs.example.com/**)'] });

    expect(evaluatePermission('WebFetch', { url: 'https://docs.example.com' }, s)).toBe('allow');
    expect(evaluatePermission('WebFetch', { url: 'https://docs.example.com?tab=api' }, s)).toBe(
      'allow',
    );
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

  it('applies deny, ask, and allow precedence to MCP server namespaces', () => {
    const args = { title: 'Release issue' };
    const s = settings({
      deny: ['mcp__github__delete_issue'],
      ask: ['mcp__github__create_issue'],
      allow: ['mcp__github'],
    });

    expect(evaluatePermission('mcp__github__search', {}, s)).toBe('allow');
    expect(evaluatePermission('mcp__github__create_issue', args, s)).toBe('ask');
    expect(evaluatePermission('mcp__github__delete_issue', args, s)).toBe('deny');
    expect(evaluatePermission('mcp__gitlab__search', {}, s)).toBe('ask');
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

describe('sandbox.autoAllowBashIfSandboxed', () => {
  const sandboxAvailable = { sandboxBackendAvailable: () => true };
  const sandboxMissing = { sandboxBackendAvailable: () => false };

  function withSandbox(overrides: Partial<ResolvedSettings['sandbox']> = {}): ResolvedSettings {
    const base = structuredClone(DEFAULT_SETTINGS);
    return { ...base, sandbox: { ...base.sandbox, enabled: true, ...overrides } };
  }

  it('auto-allows a Bash command that genuinely runs inside the sandbox', () => {
    const verdict = evaluatePermissionDetail(
      'Bash',
      { command: 'rm -rf build' },
      withSandbox(),
      sandboxAvailable,
    );
    expect(verdict).toEqual({ decision: 'allow', source: 'sandbox' });
  });

  // The single most important property here: a deny rule outranks the sandbox.
  it('never overrides a permissions.deny rule', () => {
    const settings = withSandbox();
    settings.permissions.deny = ['Bash(rm *)'];
    const verdict = evaluatePermissionDetail(
      'Bash',
      { command: 'rm -rf /' },
      settings,
      sandboxAvailable,
    );
    expect(verdict.decision).toBe('deny');
    expect(verdict.matchedRule).toBe('Bash(rm *)');
    expect(verdict.source).toBe('deny');
  });

  it('never overrides a bare Bash deny rule', () => {
    const settings = withSandbox();
    settings.permissions.deny = ['Bash'];
    expect(evaluatePermission('Bash', { command: 'ls' }, settings, sandboxAvailable)).toBe('deny');
  });

  it('does not override an explicit permissions.ask rule', () => {
    const settings = withSandbox();
    settings.permissions.ask = ['Bash(git push*)'];
    const verdict = evaluatePermissionDetail(
      'Bash',
      { command: 'git push --force' },
      settings,
      sandboxAvailable,
    );
    expect(verdict.decision).toBe('ask');
    expect(verdict.source).toBe('ask');
  });

  it('does not auto-allow when sandboxing is disabled', () => {
    const settings = withSandbox({ enabled: false });
    expect(evaluatePermission('Bash', { command: 'ls' }, settings, sandboxAvailable)).toBe('ask');
  });

  it('does not auto-allow when the bubblewrap backend is unavailable', () => {
    expect(evaluatePermission('Bash', { command: 'ls' }, withSandbox(), sandboxMissing)).toBe(
      'ask',
    );
  });

  it('does not auto-allow a command excluded from the sandbox', () => {
    const settings = withSandbox({ excludedCommands: ['docker *'] });
    expect(
      evaluatePermission('Bash', { command: 'docker run x' }, settings, sandboxAvailable),
    ).toBe('ask');
    // A non-excluded command in the same configuration still auto-allows.
    expect(evaluatePermission('Bash', { command: 'ls' }, settings, sandboxAvailable)).toBe('allow');
  });

  it('judges the whole command, not the first line, against excludedCommands', () => {
    // tools/shell.ts matches the full trimmed command string. If this path
    // matched only the first line it could auto-allow a call that Bash then
    // runs on the host.
    const command = 'echo hi\ndocker run --privileged evil';
    const settings = withSandbox({ excludedCommands: [command] });
    expect(evaluatePermission('Bash', { command }, settings, sandboxAvailable)).toBe('ask');
  });

  it('does not auto-allow when autoAllowBashIfSandboxed is false', () => {
    const settings = withSandbox({ autoAllowBashIfSandboxed: false });
    expect(evaluatePermission('Bash', { command: 'ls' }, settings, sandboxAvailable)).toBe('ask');
  });

  it('applies only to Bash, not to other tools', () => {
    const settings = withSandbox();
    expect(evaluatePermission('Write', { file_path: 'a.txt' }, settings, sandboxAvailable)).toBe(
      'ask',
    );
    expect(
      evaluatePermission('BashOutput', { shell_id: 'shell_1' }, settings, sandboxAvailable),
    ).toBe('ask');
  });

  it('does not auto-allow a Bash call with no command argument', () => {
    expect(evaluatePermission('Bash', {}, withSandbox(), sandboxAvailable)).toBe('ask');
    expect(evaluatePermission('Bash', { command: '   ' }, withSandbox(), sandboxAvailable)).toBe(
      'ask',
    );
  });

  it('is inert under the shipped defaults, where sandbox.enabled is false', () => {
    expect(DEFAULT_SETTINGS.sandbox.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.sandbox.autoAllowBashIfSandboxed).toBe(true);
    expect(evaluatePermission('Bash', { command: 'ls' }, structuredClone(DEFAULT_SETTINGS))).toBe(
      'ask',
    );
  });

  // A deny glob is matched against one line of shell. The default ask is what
  // catches everything the glob does not, so a deny list that exists but did
  // not match must not be answered with "allow, it is sandboxed".
  it('keeps the default ask when a deny rule exists but the command evades its glob', () => {
    const settings = withSandbox();
    settings.permissions.deny = ['Bash(rm *)'];
    const verdict = evaluatePermissionDetail(
      'Bash',
      // README's own example rule; `getPrimaryArg` yields the whole line, which
      // the glob `rm *` does not match.
      { command: 'true && rm -rf .' },
      settings,
      sandboxAvailable,
    );
    expect(verdict.decision).toBe('ask');
    expect(verdict.source).toBe('default');
  });

  it('keeps the default ask when an ask rule exists but the command evades its glob', () => {
    const settings = withSandbox();
    settings.permissions.ask = ['Bash(git push*)'];
    expect(
      evaluatePermission(
        'Bash',
        { command: 'true && git push --force' },
        settings,
        sandboxAvailable,
      ),
    ).toBe('ask');
  });

  // A shell line can perform the action any *other* tool's rule was written to
  // gate, so a rule naming a different tool suppresses the auto-allow as well.
  it('keeps the default ask when a deny rule targets a different tool', () => {
    const settings = withSandbox();
    settings.permissions.deny = ['Read(./.env)'];
    expect(evaluatePermission('Bash', { command: 'cat .env' }, settings, sandboxAvailable)).toBe(
      'ask',
    );
  });

  // `allow` is a widening list, not an adjudication request: it never stood
  // between the model and a command, so it does not suppress the auto-allow.
  it('still auto-allows when only allow rules are configured', () => {
    const settings = withSandbox();
    settings.permissions.allow = ['Read(src/**)'];
    expect(evaluatePermission('Bash', { command: 'ls' }, settings, sandboxAvailable)).toBe('allow');
  });
});
