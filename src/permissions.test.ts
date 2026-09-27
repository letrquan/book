import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as pathUtils from './tools/path-utils.js';
import {
  permissionReasonOf,
  permissionRuleLadder,
  permissionResultOf,
  permissionRuleOf,
} from './permissions.js';
import {
  evaluatePermission,
  evaluatePermissionDetail,
  parseRule,
  permissionRuleForToolCall,
  permissionRuleMatchesCall,
  primaryArgForRule,
  type WorkspaceScope,
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
    const rule = 'WebFetch(https://docs.example.com/**)';

    expect(permissionRuleForToolCall(fetchCall)).toBe(rule);
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

  it('auto-allows ALWAYS_ALLOWED_TOOLS like MemorySave by default but respects explicit deny', () => {
    const defaultS = settings({});
    expect(evaluatePermission('MemorySave', { action: 'save' }, defaultS)).toBe('allow');

    const denyS = settings({ deny: ['MemorySave'] });
    expect(evaluatePermission('MemorySave', { action: 'save' }, denyS)).toBe('deny');
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

describe('permissionRuleLadder', () => {
  const bash = (command: string) => ({ id: 'c', name: 'Bash', arguments: { command } });

  it('offers progressively broader prefixes for a shell command', () => {
    // The exact rule matches that byte sequence and nothing else, which is why
    // "Always allow" never stopped the prompts it exists to stop.
    expect(permissionRuleLadder(bash('npm run check'))).toEqual([
      'Bash(npm run check)',
      'Bash(npm run *)',
      'Bash(npm *)',
    ]);
    expect(permissionRuleLadder(bash('echo one'))).toEqual(['Bash(echo one)', 'Bash(echo *)']);
  });

  it('offers only the exact rule for a single-token command', () => {
    expect(permissionRuleLadder(bash('pwd'))).toEqual(['Bash(pwd)']);
  });

  it('offers no rule at all for a call whose primary argument is empty', () => {
    // `{command: ""}` passes the schema, and a command whose first line is empty has
    // no primary argument either. The bare `Bash` rule the ladder used to offer in
    // their place allows every Bash call afterwards, which is not what "Always allow"
    // on a call that ran nothing ever meant.
    for (const command of ['', '\nrm -rf x']) {
      expect(permissionRuleForToolCall(bash(command))).toBeUndefined();
      expect(permissionRuleLadder(bash(command))).toEqual([]);
    }
  });

  it('refuses to widen a command that already chains or redirects', () => {
    // `*` crosses anything, so a prefix learned from `npm i && curl x | sh`
    // would keep matching whatever came after the operator.
    for (const command of ['npm i && curl x', 'ls | wc -l', 'cat a > b', 'echo `id`', 'ls $HOME']) {
      expect(permissionRuleLadder(bash(command))).toHaveLength(1);
    }
  });

  it('leaves non-shell tools with their single rule', () => {
    expect(
      permissionRuleLadder({ id: 'c', name: 'Read', arguments: { file_path: 'a/b.ts' } }),
    ).toEqual(['Read(a/b.ts)']);
    expect(
      permissionRuleLadder({ id: 'c', name: 'WebFetch', arguments: { url: 'https://x.dev/a' } }),
    ).toEqual(['WebFetch(https://x.dev/**)']);
  });

  it('widened rules actually match later commands, which the exact rule does not', () => {
    const later = bash('npm run build');
    expect(permissionRuleMatchesCall('Bash(npm run check)', later)).toBe(false);
    expect(permissionRuleMatchesCall('Bash(npm run *)', later)).toBe(true);
  });
});

describe('permission decision accessors', () => {
  it('reads both the bare result and the rule-carrying form', () => {
    expect(permissionResultOf('always')).toBe('always');
    expect(permissionRuleOf('always')).toBeUndefined();
    expect(permissionResultOf({ result: 'always', rule: 'Bash(npm *)' })).toBe('always');
    expect(permissionRuleOf({ result: 'always', rule: 'Bash(npm *)' })).toBe('Bash(npm *)');
  });

  it('reads why an approver refused', () => {
    expect(permissionReasonOf('deny')).toBeUndefined();
    expect(permissionReasonOf({ result: 'deny', reason: 'no_approver' })).toBe('no_approver');
  });
});

describe('workspace reads need no prompt (#264)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function settings(overrides: Partial<ResolvedSettings['permissions']> = {}): ResolvedSettings {
    return {
      ...DEFAULT_SETTINGS,
      permissions: { ...DEFAULT_SETTINGS.permissions, ...overrides },
    };
  }

  function scope(root: string, extra: Partial<WorkspaceScope> = {}): { workspace: WorkspaceScope } {
    return { workspace: { root, judgeReads: true, autoAllowReads: true, ...extra } };
  }

  function setup() {
    const workspace = tempDir('book-perm-ws-');
    const outside = tempDir('book-perm-out-');
    writeFileSync(join(workspace, 'notes.txt'), 'notes\n');
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'a.ts'), 'a\n');
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    return { workspace, outside };
  }

  it('allows Read, Glob and Grep inside the workspace', () => {
    const { workspace } = setup();
    const s = settings();
    expect(
      evaluatePermissionDetail('Read', { filePath: 'notes.txt' }, s, scope(workspace)),
    ).toEqual({ decision: 'allow', source: 'workspace' });
    expect(
      evaluatePermission(
        'Read',
        { file_path: join(workspace, 'src', 'a.ts') },
        s,
        scope(workspace),
      ),
    ).toBe('allow');
    expect(evaluatePermission('Glob', { pattern: 'src/**/*.ts' }, s, scope(workspace))).toBe(
      'allow',
    );
    expect(evaluatePermission('Grep', { pattern: 'notes' }, s, scope(workspace))).toBe('allow');
    expect(evaluatePermission('Grep', { pattern: 'a', path: 'src' }, s, scope(workspace))).toBe(
      'allow',
    );
    expect(evaluatePermission('Grep', { pattern: 'a', path: '.' }, s, scope(workspace))).toBe(
      'allow',
    );
  });

  it('still asks where reads are not auto-allowed, and for every other tool', () => {
    const { workspace } = setup();
    const s = settings();
    expect(evaluatePermission('Read', { filePath: 'notes.txt' }, s)).toBe('ask');
    expect(
      evaluatePermission(
        'Read',
        { filePath: 'notes.txt' },
        s,
        scope(workspace, { autoAllowReads: false }),
      ),
    ).toBe('ask');
    // The four read-only Git tools run without a prompt (#305 item 6)...
    expect(evaluatePermission('GitStatus', {}, s, scope(workspace))).toBe('allow');
    expect(evaluatePermission('GitDiff', {}, s, scope(workspace))).toBe('allow');
    expect(evaluatePermission('GitLog', {}, s, scope(workspace))).toBe('allow');
    expect(evaluatePermission('GitBranch', {}, s, scope(workspace))).toBe('allow');
    // ...but nowhere that does not judge calls: the same rule a read is judged by.
    expect(
      evaluatePermission('GitStatus', {}, s, scope(workspace, { autoAllowReads: false })),
    ).toBe('ask');
    // A mutation is a mutation, and a shell command is a shell command.
    expect(evaluatePermission('GitCommit', { message: 'x' }, s, scope(workspace))).toBe('ask');
    expect(evaluatePermission('Bash', { command: 'cat notes.txt' }, s, scope(workspace))).toBe(
      'ask',
    );
    expect(
      evaluatePermission('Write', { filePath: 'notes.txt', content: 'x' }, s, scope(workspace)),
    ).toBe('ask');
  });

  it('refuses a target outside the workspace, however it is spelled, and says it is outside', () => {
    const { workspace, outside } = setup();
    const s = settings();
    const outsideFile = join(outside, 'secret.txt');
    expect(
      evaluatePermissionDetail('Read', { filePath: outsideFile }, s, scope(workspace)),
    ).toEqual({ decision: 'refuse', source: 'default', outsideWorkspace: true });
    expect(evaluatePermission('Read', { filePath: '../secret.txt' }, s, scope(workspace))).toBe(
      'refuse',
    );
    expect(
      evaluatePermission('Read', { filePath: 'src/../../secret.txt' }, s, scope(workspace)),
    ).toBe('refuse');
    expect(evaluatePermission('Grep', { pattern: 'x', path: outside }, s, scope(workspace))).toBe(
      'refuse',
    );
    expect(
      evaluatePermissionDetail('Grep', { pattern: 'x', path: '..' }, s, scope(workspace)),
    ).toMatchObject({ decision: 'refuse', outsideWorkspace: true });
    expect(evaluatePermission('Glob', { pattern: '../**/*' }, s, scope(workspace))).toBe('refuse');
    expect(
      evaluatePermission(
        'Glob',
        { pattern: `${outside.replace(/\\/g, '/')}/**` },
        s,
        scope(workspace),
      ),
    ).toBe('refuse');
    // No path at all is not "outside": the call goes on to the tool, which rejects it with the
    // real reason (a missing argument, or arguments that were not valid JSON).
    expect(evaluatePermissionDetail('Read', {}, s, scope(workspace))).toEqual({
      decision: 'allow',
      source: 'workspace',
    });
    expect(
      evaluatePermissionDetail('Read', { __raw: '{"filePath": "a.tx' }, s, scope(workspace)),
    ).toEqual({ decision: 'allow', source: 'workspace' });
  });

  it('judges a Glob by where fast-glob would start walking', () => {
    const { workspace, outside } = setup();
    const s = settings();
    const posix = (path: string) => path.replace(/\\/g, '/');
    const glob = (pattern: string) => evaluatePermission('Glob', { pattern }, s, scope(workspace));
    expect(glob(`${posix(workspace)}/src/*.ts`)).toBe('allow');
    expect(glob(`${posix(outside)}/*.txt`)).toBe('refuse');
    expect(glob('.{.,x}/*')).toBe('refuse');
    expect(glob('src/{a,{b,../..}}/*')).toBe('refuse');
    // These never leave the workspace: fast-glob walks from inside it.
    expect(glob('src/{a,{b,..}}/*')).toBe('allow');
    expect(glob('{..,src}/*')).toBe('allow');
    expect(glob('**/*.{ts,tsx}')).toBe('allow');
    expect(glob('logs/{1..3}.txt')).toBe('allow');
    expect(glob('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}.txt')).toBe('allow');
    expect(glob('~$*.docx')).toBe('allow');
  });

  it('refuses an outside target even where reads keep asking, and still honours an ask rule', () => {
    const { workspace, outside } = setup();
    const outsideFile = join(outside, 'secret.txt');
    // A workspace that holds a home asks for everything, and an outside target is still refused:
    // `autoAllowReads` is about skipping the prompt, not about which roots exist.
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: outsideFile },
        settings(),
        scope(workspace, { autoAllowReads: false }),
      ),
    ).toEqual({ decision: 'refuse', source: 'default', outsideWorkspace: true });
    const rule = `Read(${outside.replace(/\\/g, '/')}/**)`;
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: outsideFile.replace(/\\/g, '/') },
        settings({ ask: [rule] }),
        scope(workspace),
      ),
    ).toEqual({ decision: 'ask', source: 'ask', matchedRule: rule, outsideWorkspace: true });
    // Only judged in the modes that judge reads.
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: outsideFile },
        settings(),
        scope(workspace, { judgeReads: false, autoAllowReads: false }),
      ),
    ).toEqual({ decision: 'ask', source: 'default' });
  });

  it('matches Write and Edit rules against an ApplyPatch path however it is spelled', () => {
    const { workspace } = setup();
    writeFileSync(join(workspace, '.env'), 'KEY=1\n');
    const off = scope(workspace, { judgeReads: false, autoAllowReads: false });
    const denied = settings({ deny: ['Write(.env)', 'Edit(.env)'] });
    for (const path of ['src/../.env', join(workspace, '.env').replace(/\\/g, '/')]) {
      const patch = `*** Begin Patch\n*** Update File: ${path}\n@@\n-KEY=1\n+KEY=2\n*** End Patch`;
      expect(evaluatePermissionDetail('ApplyPatch', { patch }, denied, off)).toMatchObject({
        decision: 'deny',
      });
    }
    const allowed = settings({ allow: ['Edit(src/**)'] });
    const inSrc = join(workspace, 'src', 'a.ts').replace(/\\/g, '/');
    const patch = `*** Begin Patch\n*** Update File: ${inSrc}\n@@\n-a\n+b\n*** End Patch`;
    expect(evaluatePermission('ApplyPatch', { patch }, allowed, off)).toBe('allow');
  });

  it.runIf(process.platform === 'win32')(
    'matches a path rule on Windows whatever the case of the path',
    () => {
      const { workspace } = setup();
      writeFileSync(join(workspace, '.env'), 'KEY=1\n');
      const s = settings({ deny: ['Read(.env)'] });
      expect(evaluatePermission('Read', { filePath: '.ENV' }, s, scope(workspace))).toBe('deny');
    },
  );

  it('allows a Glob whose file names merely contain two dots', () => {
    const { workspace } = setup();
    const s = settings();
    expect(evaluatePermission('Glob', { pattern: '**/*..orig' }, s, scope(workspace))).toBe(
      'allow',
    );
    expect(evaluatePermission('Glob', { pattern: 'docs/v1..v2/*.md' }, s, scope(workspace))).toBe(
      'allow',
    );
  });

  it('follows a link inside the workspace that points out of it', () => {
    const { workspace, outside } = setup();
    // A junction needs no symlink privilege on Windows; elsewhere the type is ignored.
    symlinkSync(outside, join(workspace, 'link'), 'junction');
    const s = settings();
    // Following the link is what makes it outside, so the answer is a refusal rather than a
    // prompt: a workspace-relative spelling does not make the target reachable.
    expect(evaluatePermission('Read', { filePath: 'link/secret.txt' }, s, scope(workspace))).toBe(
      'refuse',
    );
    expect(evaluatePermission('Grep', { pattern: 'x', path: 'link' }, s, scope(workspace))).toBe(
      'refuse',
    );
  });

  it("allows a Read of Book's memory directory, which the Read tool can open, but not its inbox", () => {
    const { workspace } = setup();
    const memory = tempDir('book-perm-memory-');
    writeFileSync(join(memory, 'MEMORY.md'), '- a memory\n');
    mkdirSync(join(memory, '.inbox'));
    writeFileSync(join(memory, '.inbox', 'pending.md'), 'pending\n');
    const s = settings();
    const withMemory = scope(workspace, { readOnlyRoots: [{ root: memory, exclude: ['.inbox'] }] });
    expect(evaluatePermission('Read', { filePath: join(memory, 'MEMORY.md') }, s, withMemory)).toBe(
      'allow',
    );
    expect(
      evaluatePermission('Read', { filePath: join(memory, '.inbox', 'pending.md') }, s, withMemory),
    ).toBe('ask');
    // Grep and Glob reach only the workspace and the honored directories: the memory directory is
    // a root `Read` alone may cross, so Grep on it is refused, not asked about.
    expect(evaluatePermission('Grep', { pattern: 'x', path: memory }, s, withMemory)).toBe(
      'refuse',
    );
  });

  it("keeps asking for Book's project-local settings, which can hold an API key", () => {
    const { workspace } = setup();
    mkdirSync(join(workspace, '.book'));
    writeFileSync(join(workspace, '.book', 'settings.local.json'), '{}\n');
    const s = settings();
    expect(
      evaluatePermission('Read', { filePath: '.book/settings.local.json' }, s, scope(workspace)),
    ).toBe('ask');
    expect(
      evaluatePermission(
        'Read',
        { filePath: join(workspace, '.book', 'settings.local.json') },
        s,
        scope(workspace),
      ),
    ).toBe('ask');
    expect(evaluatePermission('Grep', { pattern: 'x', path: '.book' }, s, scope(workspace))).toBe(
      'ask',
    );
    // Compared case-insensitively everywhere: a case-insensitive Linux mount (WSL on /mnt/c)
    // serves this spelling from the same file.
    expect(
      evaluatePermission('Read', { filePath: '.BOOK/SETTINGS.LOCAL.JSON' }, s, scope(workspace)),
    ).toBe('ask');
  });

  it('keeps deny and ask rules in force, however the path is spelled', () => {
    const { workspace } = setup();
    writeFileSync(join(workspace, '.env'), 'KEY=1\n');
    mkdirSync(join(workspace, 'secrets'));
    writeFileSync(join(workspace, 'secrets', 'key.pem'), 'pem\n');
    const s = settings({ deny: ['Read(.env)'], ask: ['Read(secrets/**)'] });
    const absoluteEnv = join(workspace, '.env');
    expect(
      evaluatePermissionDetail('Read', { filePath: '.env' }, s, scope(workspace)),
    ).toMatchObject({ decision: 'deny', matchedRule: 'Read(.env)' });
    expect(
      evaluatePermissionDetail('Read', { filePath: absoluteEnv }, s, scope(workspace)),
    ).toMatchObject({ decision: 'deny', matchedRule: 'Read(.env)' });
    expect(
      evaluatePermissionDetail('Read', { filePath: 'src/../.env' }, s, scope(workspace)),
    ).toMatchObject({ decision: 'deny' });
    // A deny rule is not a mode decision: the same spelling is denied where reads are not
    // auto-allowed (auto, bypassPermissions).
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: absoluteEnv },
        s,
        scope(workspace, { autoAllowReads: false }),
      ),
    ).toMatchObject({ decision: 'deny' });
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: join(workspace, 'secrets', 'key.pem') },
        s,
        scope(workspace),
      ),
    ).toMatchObject({ decision: 'ask', source: 'ask', matchedRule: 'Read(secrets/**)' });
    expect(evaluatePermission('Read', { filePath: 'notes.txt' }, s, scope(workspace))).toBe(
      'allow',
    );
  });

  it('matches a path rule for a file-writing tool however the path is spelled', () => {
    const { workspace } = setup();
    writeFileSync(join(workspace, '.env'), 'KEY=1\n');
    const s = settings({ deny: ['Write(.env)', 'Edit(.env)'] });
    const off = scope(workspace, { autoAllowReads: false });
    for (const tool of ['Write', 'Edit']) {
      expect(
        evaluatePermissionDetail(tool, { filePath: join(workspace, '.env') }, s, off),
      ).toMatchObject({ decision: 'deny', matchedRule: `${tool}(.env)` });
      expect(evaluatePermissionDetail(tool, { filePath: 'src/../.env' }, s, off)).toMatchObject({
        decision: 'deny',
      });
    }
  });

  it('judges a read in plan mode the way default does (#305 item 7)', () => {
    const { workspace, outside } = setup();
    mkdirSync(join(workspace, '.book'));
    writeFileSync(join(workspace, '.book', 'settings.local.json'), '{}\n');
    const s = settings();
    // Plan mode is a judging mode now: the scope it is given is the one loop.ts builds. Before
    // this, a plan-mode run auto-approved every read-only tool outside `PLAN_PERMISSION_REQUIRED_TOOLS`,
    // so a guarded Read ran unprompted and an outside Read reached the tool and came back
    // `path_outside_workspace` with nobody asked.
    const plan = () => scope(workspace, { judgeReads: true, autoAllowReads: true });
    // A workspace target runs.
    expect(evaluatePermission('Read', { filePath: 'notes.txt' }, s, plan())).toBe('allow');
    expect(evaluatePermission('Grep', { pattern: 'notes' }, s, plan())).toBe('allow');
    // A guarded target asks, instead of running unprompted.
    expect(evaluatePermission('Read', { filePath: '.book/settings.local.json' }, s, plan())).toBe(
      'ask',
    );
    // An outside target is refused before the prompt: the tool cannot serve it.
    expect(
      evaluatePermissionDetail('Read', { filePath: join(outside, 'secret.txt') }, s, plan()),
    ).toMatchObject({ decision: 'refuse', outsideWorkspace: true });
    expect(evaluatePermission('Glob', { pattern: '../**/*' }, s, plan())).toBe('refuse');
    // Plan mode is not exempt from a rule the user wrote either.
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: 'notes.txt' },
        settings({ deny: ['Read(notes.txt)'] }),
        plan(),
      ),
    ).toMatchObject({ decision: 'deny' });
  });

  it('refuses a target the tool cannot serve, rather than asking about it (item 3)', () => {
    const { workspace, outside } = setup();
    const s = settings();
    const outsideFile = join(outside, 'secret.txt');
    // A refusal is not a prompt: no mode reaches the approver for it.
    for (const autoAllowReads of [true, false]) {
      expect(
        evaluatePermissionDetail(
          'Read',
          { filePath: outsideFile },
          s,
          scope(workspace, { autoAllowReads }),
        ),
      ).toEqual({ decision: 'refuse', source: 'default', outsideWorkspace: true });
    }
    // An ask rule still asks: it is the user naming the target, so they may want to answer.
    const rule = `Read(${outside.replace(/\\/g, '/')}/**)`;
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: outsideFile },
        settings({ ask: [rule] }),
        scope(workspace),
      ),
    ).toEqual({ decision: 'ask', source: 'ask', matchedRule: rule, outsideWorkspace: true });
    // Deny still denies, and reports the rule rather than the remedy.
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: outsideFile },
        settings({ deny: [rule] }),
        scope(workspace),
      ),
    ).toEqual({ decision: 'deny', matchedRule: rule, source: 'deny' });
    // Allow wins outright: the tool can open an honored root, and a rule says to.
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: outsideFile },
        settings({ allow: [rule] }),
        scope(workspace),
      ),
    ).toEqual({ decision: 'allow', matchedRule: rule, source: 'allow' });
    // Only the modes that judge reads refuse; the rest are unchanged.
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: outsideFile },
        s,
        scope(workspace, { judgeReads: false, autoAllowReads: false }),
      ),
    ).toEqual({ decision: 'ask', source: 'default' });
  });

  it('folds the case of a deny or ask path rule on every platform (#305 item 1)', () => {
    const { workspace } = setup();
    writeFileSync(join(workspace, '.env'), 'KEY=1\n');
    const off = scope(workspace, { judgeReads: false, autoAllowReads: false });
    // Every spelling the path rules produce is folded, not just the raw argument.
    for (const spelling of ['.ENV', '.Env', join(workspace, '.ENV').replace(/\\/g, '/')]) {
      expect(
        evaluatePermissionDetail(
          'Read',
          { filePath: spelling },
          settings({ deny: ['Read(.env)'] }),
          off,
        ),
      ).toMatchObject({ decision: 'deny', matchedRule: 'Read(.env)' });
    }
    // Ask folds the same way.
    expect(
      evaluatePermission(
        'Read',
        { filePath: '.ENV' },
        settings({ ask: ['Read(.env)'] }),
        scope(workspace),
      ),
    ).toBe('ask');
    // A writing tool folds too, and every resolved spelling of the path is checked.
    expect(
      evaluatePermissionDetail(
        'Write',
        { filePath: 'src/../.ENV' },
        settings({ deny: ['Write(.env)'] }),
        off,
      ),
    ).toMatchObject({ decision: 'deny' });
    // Allow keeps today's matching, so nothing is widened by the folding.
    expect(
      evaluatePermission('Read', { filePath: '.ENV' }, settings({ allow: ['Read(.env)'] }), off),
    ).toBe('ask');
  });

  it('keeps Grep and Glob asking while a rule adjudicates reads, since a Read rule cannot see them', () => {
    const { workspace } = setup();
    writeFileSync(join(workspace, '.env'), 'KEY=1\n');
    for (const s of [settings({ deny: ['Read(.env)'] }), settings({ ask: ['Read(secrets/**)'] })]) {
      expect(evaluatePermission('Grep', { pattern: '.', path: '.env' }, s, scope(workspace))).toBe(
        'ask',
      );
      expect(evaluatePermission('Grep', { pattern: 'KEY' }, s, scope(workspace))).toBe('ask');
      expect(evaluatePermission('Glob', { pattern: '**/*' }, s, scope(workspace))).toBe('ask');
      // Read's own rules see every spelling, so an unrelated Read still needs no prompt.
      expect(evaluatePermission('Read', { filePath: 'notes.txt' }, s, scope(workspace))).toBe(
        'allow',
      );
    }
  });
});

describe('an honored additional directory reads like the workspace (#300)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function settings(overrides: Partial<ResolvedSettings['permissions']> = {}): ResolvedSettings {
    return {
      ...DEFAULT_SETTINGS,
      permissions: { ...DEFAULT_SETTINGS.permissions, ...overrides },
    };
  }

  function setup() {
    const workspace = tempDir('book-dir-ws-');
    const honored = tempDir('book-dir-extra-');
    writeFileSync(join(workspace, 'notes.txt'), 'notes\n');
    writeFileSync(join(honored, 'notes.txt'), 'extra\n');
    return { workspace, honored };
  }

  function scope(
    root: string,
    extra: Partial<WorkspaceScope> = {},
    additionalRoots: string[] = [],
  ): { workspace: WorkspaceScope } {
    return {
      workspace: { root, judgeReads: true, autoAllowReads: true, additionalRoots, ...extra },
    };
  }

  it('auto-allows a read inside an honored directory, with the workspace as its source', () => {
    const { workspace, honored } = setup();
    const s = settings();
    for (const spelling of [
      join(honored, 'notes.txt'),
      join(honored, 'notes.txt').replace(/\\/g, '/'),
    ]) {
      expect(
        evaluatePermissionDetail(
          'Read',
          { filePath: spelling },
          s,
          scope(workspace, {}, [honored]),
        ),
      ).toEqual({ decision: 'allow', source: 'workspace' });
    }
    // Grep and Glob reach it too, on the same terms as the workspace.
    expect(
      evaluatePermission(
        'Grep',
        { pattern: 'x', path: honored },
        s,
        scope(workspace, {}, [honored]),
      ),
    ).toBe('allow');
    expect(
      evaluatePermission(
        'Glob',
        { pattern: `${honored.replace(/\\/g, '/')}/**` },
        s,
        scope(workspace, {}, [honored]),
      ),
    ).toBe('allow');
    // The same path is refused outright when the directory is not honored.
    expect(
      evaluatePermission('Read', { filePath: join(honored, 'notes.txt') }, s, scope(workspace)),
    ).toBe('refuse');
  });

  it('keeps every exception an inside-the-workspace read has', () => {
    const { workspace, honored } = setup();
    // A deny rule still denies.
    expect(
      evaluatePermission(
        'Read',
        { filePath: join(honored, 'notes.txt') },
        settings({ deny: ['Read(**/notes.txt)'] }),
        scope(workspace, {}, [honored]),
      ),
    ).toBe('deny');
    // An ask rule still asks.
    expect(
      evaluatePermission(
        'Read',
        { filePath: join(honored, 'notes.txt') },
        settings({ ask: ['Read(**/notes.txt)'] }),
        scope(workspace, {}, [honored]),
      ),
    ).toBe('ask');
    // A `.book/settings.local.json` inside the honored directory keeps asking.
    mkdirSync(join(honored, '.book'));
    writeFileSync(join(honored, '.book', 'settings.local.json'), '{}\n');
    expect(
      evaluatePermission(
        'Read',
        { filePath: join(honored, '.book', 'settings.local.json') },
        settings(),
        scope(workspace, {}, [honored]),
      ),
    ).toBe('ask');
    // A path inside a home directory held by the root that serves it never auto-allows, but it is
    // still served: the prompt is the answer there, not a refusal. Keyed on the root rather than on
    // the target, so the guard is `homeGuards` — the real paths the loop resolved once for the run.
    const container = tempDir('book-dir-container-');
    const home = join(container, 'home');
    mkdirSync(home);
    writeFileSync(join(home, 'notes.txt'), 'extra\n');
    writeFileSync(join(container, 'beside.txt'), 'beside\n');
    const guards = { homeGuards: [realpathSync.native(home)] };
    expect(
      evaluatePermission(
        'Read',
        { filePath: join(home, 'notes.txt') },
        settings(),
        scope(workspace, guards, [container]),
      ),
    ).toBe('ask');
    // Only the home is guarded, not the whole root that holds it: a file beside the home is an
    // ordinary read in an honored root, which is what makes approving a directory useful.
    expect(
      evaluatePermission(
        'Read',
        { filePath: join(container, 'beside.txt') },
        settings(),
        scope(workspace, guards, [container]),
      ),
    ).toBe('allow');
    // Without that list the same read is an ordinary read in an honored root: whether a path is
    // under a home is resolved once per run, not per call.
    expect(
      evaluatePermission(
        'Read',
        { filePath: join(home, 'notes.txt') },
        settings(),
        scope(workspace, {}, [container]),
      ),
    ).toBe('allow');
  });

  it('does not guard a root that merely sits below a home (#300 regression)', () => {
    // Nearly every real workspace lives under the user's home. A read of an ordinary workspace
    // file must not stop prompting because of where the workspace happens to be, so the home has
    // to *contain* the root — which is the shape this was really about.
    const home = tempDir('book-dir-regression-home-');
    const workspace = join(home, 'repo');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'package.json'), '{}\n');
    const guarded = { homeGuards: [realpathSync.native(home)] };
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: join(workspace, 'package.json') },
        settings(),
        scope(workspace, guarded),
      ),
    ).toEqual({ decision: 'allow', source: 'workspace' });
    // Grep and Glob judge the same target the same way, so a search cannot be the way around a
    // Read that asks.
    expect(
      evaluatePermissionDetail('Grep', { pattern: 'x' }, settings(), scope(workspace, guarded)),
    ).toEqual({ decision: 'allow', source: 'workspace' });
    expect(
      evaluatePermissionDetail(
        'Glob',
        { pattern: join(workspace, '*.json') },
        settings(),
        scope(workspace, guarded),
      ),
    ).toEqual({ decision: 'allow', source: 'workspace' });
    // An honored directory under a home is not guarded by it either.
    const honored = join(home, 'shared');
    mkdirSync(honored);
    writeFileSync(join(honored, 'notes.txt'), 'extra\n');
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: join(honored, 'notes.txt') },
        settings(),
        scope(workspace, guarded, [honored]),
      ),
    ).toEqual({ decision: 'allow', source: 'workspace' });
  });

  it('keeps a relative path workspace-anchored, whatever is honored', () => {
    const { workspace, honored } = setup();
    // `notes.txt` is the workspace's own file, not the honored directory's.
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: 'notes.txt' },
        settings(),
        scope(workspace, {}, [honored]),
      ),
    ).toEqual({ decision: 'allow', source: 'workspace' });
    // A relative path that climbs out stays refused even when a real root would match it.
    expect(
      evaluatePermission(
        'Read',
        { filePath: '../notes.txt' },
        settings(),
        scope(workspace, {}, [honored]),
      ),
    ).toBe('refuse');
  });

  it('judges a write in an honored directory exactly as the same write in the workspace', () => {
    // The permission layer knows nothing about modes: the loop turns a mode into the scope flags,
    // and it does that the same way whatever root a path lands in. So parity is the property that
    // matters — for every rule configuration, the write into an honored directory gets the verdict
    // the identical write into the workspace gets. (`accept-edits` differs from `default` only in
    // how the loop treats the ask, and that is one code path for both roots.)
    const { workspace, honored } = setup();
    const inWorkspace = { filePath: join(workspace, 'notes.txt') };
    const inHonored = { filePath: join(honored, 'notes.txt') };
    const configurations: Array<[string, Partial<ResolvedSettings['permissions']>]> = [
      ['no rules', {}],
      ['a deny rule', { deny: ['Write(**/notes.txt)'] }],
      ['an ask rule', { ask: ['Write(**/notes.txt)'] }],
      ['an allow rule', { allow: ['Write(**/notes.txt)'] }],
      ['deny and allow', { deny: ['Write(**/notes.txt)'], allow: ['Write(**/notes.txt)'] }],
    ];

    for (const [label, overrides] of configurations) {
      for (const writing of ['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'NotebookEdit']) {
        const s = settings(overrides);
        const inWs = evaluatePermissionDetail(writing, inWorkspace, s, scope(workspace));
        const inRoot = evaluatePermissionDetail(
          writing,
          inHonored,
          s,
          scope(workspace, {}, [honored]),
        );
        // A deny is a hard block in every mode, and the source must not soften it either.
        expect(inRoot.decision, `${writing} with ${label}`).toBe(inWs.decision);
      }
    }

    // Spelled out, because parity alone would also pass if both answers were trivially the same
    // refusal: an unconfigured write into an honored directory is an ordinary `ask`, the way it is
    // in the workspace, and a deny rule still blocks it.
    expect(
      evaluatePermissionDetail('Write', inHonored, settings(), scope(workspace, {}, [honored])),
    ).toEqual({ decision: 'ask', source: 'default' });
    expect(
      evaluatePermissionDetail(
        'Write',
        inHonored,
        settings({ deny: ['Write(**/notes.txt)'] }),
        scope(workspace, {}, [honored]),
      ).decision,
    ).toBe('deny');
  });

  it('gives an honored directory the workspace guards, local settings included', () => {
    // The `.book/settings.local.json` guard and the home guard are both consulted on the read
    // path, and both enumerate the roots. An honored directory therefore has to appear in that
    // enumeration, or approving a directory would expose a local settings file — or a home
    // directory it contains — to exactly the read the rule exists to stop.
    const { workspace } = setup();
    const container = tempDir('book-dir-guards-');
    mkdirSync(join(container, '.book'));
    writeFileSync(join(container, '.book', 'settings.local.json'), '{}\n');
    const s = settings();

    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: join(container, '.book', 'settings.local.json') },
        s,
        scope(workspace, {}, [container]),
      ),
    ).toEqual({ decision: 'ask', source: 'default' });
    // The same file in the workspace asks, so the two are the same guard seen from two roots.
    mkdirSync(join(workspace, '.book'));
    writeFileSync(join(workspace, '.book', 'settings.local.json'), '{}\n');
    expect(
      evaluatePermissionDetail(
        'Read',
        { filePath: join(workspace, '.book', 'settings.local.json') },
        s,
        scope(workspace),
      ),
    ).toEqual({ decision: 'ask', source: 'default' });
  });

  /**
   * #305 item 5. One Read evaluation resolves its path once and remembers the answer, because a
   * resolution walks the root list with `realpath` on every candidate — running it per rule
   * candidate turned a single read into a dozen filesystem round trips. The decisions must be
   * identical either way; only the work changes.
   */
  describe('a Read evaluation resolves its path once', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('resolves once per distinct path, however many rule spellings it is matched against', () => {
      const { workspace, honored } = setup();
      const target = join(honored, 'notes.txt');
      // A deny and an ask rule for the same path, each in a different spelling, so the matcher
      // has reason to look at the target more than once.
      const rules = settings({ deny: [`Read(${target})`], ask: [`Read(${honored}/notes.txt)`] });
      const spy = vi.spyOn(pathUtils, 'resolveReadablePathDetail');

      const decision = evaluatePermission(
        'Read',
        { filePath: target },
        rules,
        scope(workspace, {}, [honored]),
      );

      expect(decision).toBe('deny');
      // The deny rule matched the very path that was resolved, so the ladder never needed a
      // second look at it.
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('decides each path on its own', () => {
      const { workspace, honored } = setup();
      const rules = settings({});
      const workspaceScope = scope(workspace, {}, [honored]);

      expect(
        evaluatePermissionDetail(
          'Read',
          { filePath: join(honored, 'notes.txt') },
          rules,
          workspaceScope,
        ),
      ).toEqual({ decision: 'allow', source: 'workspace' });
      expect(
        evaluatePermission(
          'Read',
          { filePath: join(workspace, '..', 'escape.txt') },
          rules,
          workspaceScope,
        ),
      ).toBe('refuse');
    });

    it('reaches the same decision however many times the same path is evaluated', () => {
      const { workspace, honored } = setup();
      const rules = settings({ ask: ['Read(*)'] });
      const workspaceScope = scope(workspace, {}, [honored]);

      const first = evaluatePermissionDetail(
        'Read',
        { filePath: join(honored, 'notes.txt') },
        rules,
        workspaceScope,
      );
      const second = evaluatePermissionDetail(
        'Read',
        { filePath: join(honored, 'notes.txt') },
        rules,
        workspaceScope,
      );

      expect(first).toEqual(second);
    });
  });
});
