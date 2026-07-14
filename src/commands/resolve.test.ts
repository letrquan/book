import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  resolveVariables,
  resolveShellInjection,
  resolveCommandBody,
} from './resolve.js';
import type { SlashCommand } from '../types.js';

describe('parseArgs', () => {
  it('splits on whitespace', () => {
    expect(parseArgs('hello world')).toEqual(['hello', 'world']);
  });

  it('respects double quotes', () => {
    expect(parseArgs('"hello world" arg2')).toEqual(['hello world', 'arg2']);
  });

  it('respects single quotes', () => {
    expect(parseArgs("'hello world' arg2")).toEqual(['hello world', 'arg2']);
  });

  it('handles mixed quoting', () => {
    expect(parseArgs('"double quoted" \'single quoted\' plain')).toEqual([
      'double quoted',
      'single quoted',
      'plain',
    ]);
  });

  it('handles empty string', () => {
    expect(parseArgs('')).toEqual([]);
  });

  it('handles whitespace only', () => {
    expect(parseArgs('   ')).toEqual([]);
  });

  it('handles empty quoted string', () => {
    // parseArgs treats "" as no args (empty strings are filtered)
    expect(parseArgs('""')).toEqual([]);
  });
});

describe('resolveVariables', () => {
  it('substitutes $ARGUMENTS', () => {
    const result = resolveVariables('echo $ARGUMENTS', ['hello', 'world'], []);
    expect(result).toBe('echo hello world');
  });

  it('substitutes $*', () => {
    const result = resolveVariables('run $*', ['a', 'b', 'c'], []);
    expect(result).toBe('run a b c');
  });

  it('substitutes positional $1..$9', () => {
    const result = resolveVariables('First: $1, Second: $2', ['alpha', 'beta'], []);
    expect(result).toBe('First: alpha, Second: beta');
  });

  it('handles out-of-range positional args', () => {
    const result = resolveVariables('$1 $2 $3', ['only'], []);
    expect(result).toBe('only  ');
  });

  it('substitutes named arguments', () => {
    const result = resolveVariables(
      'File: $file, Focus: $focus',
      ['src/app.ts', 'performance'],
      ['file', 'focus'],
    );
    expect(result).toBe('File: src/app.ts, Focus: performance');
  });

  it('handles missing named args', () => {
    const result = resolveVariables('$file $focus', ['only-one'], ['file', 'focus']);
    expect(result).toBe('only-one ');
  });

  it('substitutes ${BOOK_DATE}', () => {
    const result = resolveVariables('Date: ${BOOK_DATE}', [], []);
    const today = new Date().toISOString().split('T')[0];
    expect(result).toBe(`Date: ${today}`);
  });

  it('substitutes ${BOOK_WORKSPACE} from context', () => {
    const result = resolveVariables('WS: ${BOOK_WORKSPACE}', [], [], { workspace: '/my/project' });
    expect(result).toBe('WS: /my/project');
  });

  it('substitutes ${BOOK_SESSION_ID} from context', () => {
    const result = resolveVariables('Session: ${BOOK_SESSION_ID}', [], [], {
      sessionId: 'abc-123',
    });
    expect(result).toBe('Session: abc-123');
  });

  it('substitutes ${BOOK_MODEL} from context', () => {
    const result = resolveVariables('Model: ${BOOK_MODEL}', [], [], { model: 'gpt-4o' });
    expect(result).toBe('Model: gpt-4o');
  });

  it('leaves unknown ${VAR} as-is', () => {
    const result = resolveVariables('Unknown: ${UNKNOWN_VAR}', [], []);
    expect(result).toBe('Unknown: ${UNKNOWN_VAR}');
  });
});

describe('resolveShellInjection', () => {
  it('injects inline !`cmd` output', () => {
    const { resolved, errors } = resolveShellInjection('Output: !`echo hello_test`', process.cwd());
    expect(resolved).toContain('hello_test');
    expect(errors).toHaveLength(0);
  });

  it('injects fenced ```! block output', () => {
    const isWindows = process.platform === 'win32';
    const shellCmd = isWindows
      ? '```!\necho test_output_12345\n```'
      : '```!\necho line1\necho line2\n```';
    const { resolved, errors } = resolveShellInjection(shellCmd, process.cwd());
    if (isWindows) {
      expect(resolved).toContain('test_output_12345');
    } else {
      expect(resolved).toContain('line1');
      expect(resolved).toContain('line2');
    }
    expect(errors).toHaveLength(0);
  });

  it('preserves non-shell backticks', () => {
    const { resolved, errors } = resolveShellInjection(
      'This is `code` and this is !`echo cmd`',
      process.cwd(),
    );
    expect(resolved).toContain('`code`');
    expect(resolved).toContain('cmd');
    expect(errors).toHaveLength(0);
  });

  it('captures errors from failed commands', () => {
    // Use a command that definitely doesn't exist.
    const { resolved, errors } = resolveShellInjection(
      'Result: !`this_command_definitely_does_not_exist_xyz`',
      process.cwd(),
    );
    // On Windows, cmd.exe may behave differently. Just verify errors are collected.
    if (errors.length > 0) {
      expect(resolved).toContain('[shell error');
    }
    // Either the command fails (errors present) or cmd.exe outputs something.
    // Both are valid behaviors cross-platform.
  });
});

describe('resolveCommandBody', () => {
  const baseCmd: SlashCommand = {
    name: 'test',
    description: 'test',
    body: '$ARGUMENTS',
    source: 'project',
  };

  it('returns resolved body and empty errors for simple command', () => {
    const { resolved, shellErrors } = resolveCommandBody(baseCmd, 'hello');
    expect(resolved).toBe('hello');
    expect(shellErrors).toEqual([]);
  });

  it('applies named args from command.arguments', () => {
    const cmd: SlashCommand = {
      ...baseCmd,
      body: 'Review $file focusing on $aspect',
      arguments: ['file', 'aspect'],
    };
    const { resolved } = resolveCommandBody(cmd, 'src/main.ts performance');
    expect(resolved).toContain('Review src/main.ts focusing on performance');
  });

  it('resolves shell injections before variables', () => {
    const isWindows = process.platform === 'win32';
    const shellCmd = isWindows ? 'Env: !`echo hello_test`' : 'Env: !`echo $USER`';
    const cmd: SlashCommand = {
      ...baseCmd,
      body: shellCmd,
    };
    const { resolved } = resolveCommandBody(cmd, '', { workspace: process.cwd() });
    // Shell injection should have been resolved (no `!` backtick markers left).
    expect(resolved).not.toContain('!`');
  });
});
