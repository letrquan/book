import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  collectDeclaredHooks,
  describeDeclaredHook,
  evaluateProjectHook,
  hookFingerprint,
  partitionProjectHooks,
  persistProjectHookChoice,
  renderUntrustedText,
} from './hook-approvals.js';
import type { DeclaredHook } from './hook-approvals.js';
import type { HookEntry, HookEvent, ProjectHookChoice } from './settings.js';

function entry(command: string, matcher?: string): HookEntry {
  return matcher === undefined ? { command, env: {} } : { command, matcher, env: {} };
}

describe('hookFingerprint', () => {
  const event: HookEvent = 'PreToolUse';

  it('is deterministic for identical entries', () => {
    expect(hookFingerprint(event, entry('echo hi'))).toBe(hookFingerprint(event, entry('echo hi')));
  });

  it('changes when anything the user is asked to trust changes', () => {
    const base = hookFingerprint(event, entry('echo hi'));
    expect(hookFingerprint(event, entry('evil.sh'))).not.toBe(base);
    expect(hookFingerprint(event, entry('echo hi', 'Bash(*)'))).not.toBe(base);
    expect(hookFingerprint('SessionStart', entry('echo hi'))).not.toBe(base);
    expect(hookFingerprint(event, { command: 'echo hi', env: { INJECT: '1' } })).not.toBe(base);
  });

  // Env order is serialization noise, not a trust change.
  it('ignores env key order', () => {
    const a = hookFingerprint(event, { command: 'x', env: { A: '1', B: '2' } });
    const b = hookFingerprint(event, { command: 'x', env: { B: '2', A: '1' } });
    expect(a).toBe(b);
  });
});

describe('collectDeclaredHooks', () => {
  it('flattens declared entries per event and skips the decision store', () => {
    const pre = entry('echo pre');
    const start = entry('echo start');
    const declared = collectDeclaredHooks({
      hooks: {
        PreToolUse: [pre],
        SessionStart: [start],
        PostToolUse: [],
        projectEntries: { whatever: 'approved' },
      },
    });

    // Entries come back in HOOK_EVENTS declaration order, not file order.
    expect(declared.map((h) => [h.event, h.entry])).toEqual([
      ['SessionStart', start],
      ['PreToolUse', pre],
    ]);
  });

  it('returns nothing for absent or empty documents', () => {
    expect(collectDeclaredHooks(null)).toEqual([]);
    expect(collectDeclaredHooks({})).toEqual([]);
    expect(collectDeclaredHooks({ hooks: { Stop: [] } })).toEqual([]);
  });
});

describe('partitionProjectHooks', () => {
  const event: HookEvent = 'UserPromptSubmit';
  const hook: DeclaredHook = { event, entry: entry('notify.sh') };

  it('partitions by recorded decision, defaulting to pending', () => {
    const approved = { event, entry: entry('a.sh') };
    const rejected = { event, entry: entry('r.sh') };
    const store = {
      [hookFingerprint(approved.event, approved.entry)]: 'approved',
      [hookFingerprint(rejected.event, rejected.entry)]: 'rejected',
    } as Record<string, 'approved' | 'rejected'>;

    const partition = partitionProjectHooks([hook, approved, rejected], store);

    expect(partition.approved).toEqual([approved]);
    expect(partition.rejected).toEqual([rejected]);
    expect(partition.pending).toEqual([hook]);
    expect(evaluateProjectHook(store, 'nope')).toBe('unknown');
  });

  it('treats an empty store as all pending', () => {
    const partition = partitionProjectHooks([hook], {});
    expect(partition.pending).toHaveLength(1);
  });
});

describe('renderUntrustedText', () => {
  // The text belongs to the party being gated: printed raw, a newline plus a
  // forged status line makes one hook look like several, one of them approved.
  it('escapes control characters that could forge report lines', () => {
    const forged = renderUntrustedText('npm test\n    [x] Stop: safe.sh');
    expect(forged).toBe('npm test\\n    [x] Stop: safe.sh');
    expect(forged).not.toContain('\n');
  });

  it('escapes the ANSI introducer so a value cannot repaint the terminal', () => {
    expect(renderUntrustedText(`a\u001b[31mred`)).toBe('a\\x1b[31mred');
  });

  it('truncates a value long enough to push the rest of the disclosure away', () => {
    const rendered = renderUntrustedText('x'.repeat(400));
    expect(rendered).toHaveLength(201);
    expect(rendered.endsWith('…')).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(renderUntrustedText('npm run build -- --flag')).toBe('npm run build -- --flag');
  });
});

describe('describeDeclaredHook', () => {
  // Approval is keyed by a fingerprint over event, matcher, command and env, so
  // a disclosure of the command alone understates what approving it grants.
  it('discloses every field the fingerprint covers', () => {
    const hook: DeclaredHook = {
      event: 'PreToolUse',
      entry: {
        command: 'npm test',
        matcher: 'Bash(*)',
        env: { NODE_OPTIONS: '--require ./payload.js' },
      },
    };

    const described = describeDeclaredHook(hook);

    expect(described.headline).toBe('PreToolUse: npm test');
    expect(described.details).toEqual([
      `fingerprint: ${hookFingerprint(hook.event, hook.entry)}`,
      'matcher:     Bash(*)',
      'env:         NODE_OPTIONS=--require ./payload.js',
    ]);
  });

  it('omits absent fields but always names the fingerprint', () => {
    const hook: DeclaredHook = { event: 'Stop', entry: entry('notify.sh') };

    expect(describeDeclaredHook(hook).details).toEqual([
      `fingerprint: ${hookFingerprint(hook.event, hook.entry)}`,
    ]);
  });

  it('renders env values through the untrusted-text filter', () => {
    const described = describeDeclaredHook({
      event: 'Stop',
      entry: { command: 'ok', env: { A: 'one\ntwo' } },
    });

    expect(described.details).toContain('env:         A=one\\ntwo');
  });
});

describe('persistProjectHookChoice', () => {
  let workspace: string;
  let home: string;
  let storePath: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'book-hook-persist-'));
    home = mkdtempSync(join(tmpdir(), 'book-hook-home-'));
    storePath = join(home, 'trust.json');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function readHookEntries(): Record<string, ProjectHookChoice> {
    const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as {
      workspaces: Record<string, { hookEntries: Record<string, ProjectHookChoice> }>;
    };
    const entries = Object.values(parsed.workspaces);
    expect(entries).toHaveLength(1);
    return entries[0].hookEntries;
  }

  it('writes the decision where evaluate reads it back', () => {
    const fingerprint = hookFingerprint('PreToolUse', entry('echo hi'));

    expect(
      persistProjectHookChoice(workspace, fingerprint, 'approved', { trustStorePath: storePath })
        .ok,
    ).toBe(true);

    expect(readHookEntries()[fingerprint]).toBe('approved');
    expect(evaluateProjectHook(readHookEntries(), fingerprint)).toBe('approved');

    expect(
      persistProjectHookChoice(workspace, fingerprint, 'rejected', { trustStorePath: storePath })
        .ok,
    ).toBe(true);
    expect(readHookEntries()[fingerprint]).toBe('rejected');
  });

  // The old flow printed a `config set` one-liner carrying only the newly
  // pending entries, and `config set` replaces the value at a path: running the
  // suggestion silently revoked every decision made before it.
  it('preserves decisions made earlier', () => {
    const first = hookFingerprint('PreToolUse', entry('a.sh'));
    const second = hookFingerprint('Stop', entry('b.sh'));

    persistProjectHookChoice(workspace, first, 'approved', { trustStorePath: storePath });
    persistProjectHookChoice(workspace, second, 'rejected', { trustStorePath: storePath });

    expect(readHookEntries()).toEqual({ [first]: 'approved', [second]: 'rejected' });
  });

  // Nothing is written into the workspace, so a repository cannot read the
  // decision back, and a clone of it arrives with no decisions at all.
  it('writes nothing inside the workspace', () => {
    persistProjectHookChoice(workspace, 'abc123', 'approved', { trustStorePath: storePath });

    expect(() => readFileSync(join(workspace, '.book', 'settings.local.json'), 'utf-8')).toThrow();
  });
});
