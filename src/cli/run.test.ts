import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enterInteractiveScreen, runMainAction, shouldBridgeWslTerminal } from './run.js';
import { setExitFn } from './exit.js';
import { createRepeatingScriptedProvider, sseResponse } from '../test/scripted-provider.js';

function fakeStdout(isTTY: boolean) {
  const writes: string[] = [];
  const stdout = {
    isTTY,
    write(chunk: string | Uint8Array) {
      writes.push(String(chunk));
      return true;
    },
  } as Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;

  return { stdout, writes };
}

describe('enterInteractiveScreen', () => {
  it('enters alternate screen with SGR mouse reporting for wheel scrolling', () => {
    const { stdout, writes } = fakeStdout(true);
    const restore = enterInteractiveScreen(stdout);

    expect(writes).toEqual(['\x1b[?1049h\x1b[?1000h\x1b[?1006h']);

    restore();
    restore();

    expect(writes).toEqual([
      '\x1b[?1049h\x1b[?1000h\x1b[?1006h',
      '\x1b[?1006l\x1b[?1000l\x1b[?1049l',
    ]);
  });

  it('does nothing for non-TTY output', () => {
    const { stdout, writes } = fakeStdout(false);
    const previousDistro = process.env.WSL_DISTRO_NAME;
    const previousWindowsTerminal = process.env.WT_SESSION;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WT_SESSION;
    try {
      const restore = enterInteractiveScreen(stdout);
      restore();
      expect(writes).toEqual([]);
    } finally {
      if (previousDistro === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = previousDistro;
      if (previousWindowsTerminal === undefined) delete process.env.WT_SESSION;
      else process.env.WT_SESSION = previousWindowsTerminal;
    }
  });

  it('enables mouse capture for WSL sessions whose stdout is not marked TTY', () => {
    const { stdout, writes } = fakeStdout(false);
    const previousDistro = process.env.WSL_DISTRO_NAME;
    const previousWindowsTerminal = process.env.WT_SESSION;
    const previousWslEnv = process.env.WSLENV;
    process.env.WT_SESSION = 'test-session';
    process.env.WSLENV = 'WT_SESSION:WT_PROFILE_ID:';

    try {
      // The bridge decision is injected because it is win32-only by definition;
      // shouldBridgeWslTerminal's platform/env logic is covered separately below.
      const restore = enterInteractiveScreen(stdout, true);
      restore();
      expect(writes[0]).toContain('\x1b[?1000h');
    } finally {
      if (previousDistro === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = previousDistro;
      if (previousWindowsTerminal === undefined) delete process.env.WT_SESSION;
      else process.env.WT_SESSION = previousWindowsTerminal;
      if (previousWslEnv === undefined) delete process.env.WSLENV;
      else process.env.WSLENV = previousWslEnv;
    }
  });

  it('detects the Windows Node through WSL terminal bridge narrowly', () => {
    expect(
      shouldBridgeWslTerminal('win32', {
        WT_SESSION: 'session',
        WSLENV: 'WT_SESSION:WT_PROFILE_ID:',
      }),
    ).toBe(true);
    expect(shouldBridgeWslTerminal('linux', { WT_SESSION: 'session', WSLENV: 'WT_SESSION:' })).toBe(
      false,
    );
    expect(shouldBridgeWslTerminal('win32', { WT_SESSION: 'session' })).toBe(false);
  });
});

describe('runMainAction — slash commands in print mode', () => {
  const saved: Record<string, string | undefined> = {};
  let tempDirs: string[] = [];

  function stashEnv(name: string, value: string): void {
    if (!(name in saved)) saved[name] = process.env[name];
    process.env[name] = value;
  }

  function printWorkspace(): string {
    const workspace = mkdtempSync(join(tmpdir(), 'book-run-print-'));
    const home = mkdtempSync(join(tmpdir(), 'book-run-home-'));
    tempDirs.push(workspace, home);
    stashEnv('BOOK_HOME', home);
    stashEnv('BOOK_API_KEY', 'test-key');
    return workspace;
  }

  /** Print-mode option shape as src/index.ts builds it, minus the prompt. */
  function printOptions(workspace: string, print: string): Record<string, unknown> {
    return {
      print,
      workspace,
      settings: false,
      inputFormat: 'text',
      outputFormat: 'text',
      sessionPersistence: false,
      maxTurns: '1',
    };
  }

  afterEach(() => {
    setExitFn((code: number): never => process.exit(code));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      delete saved[name];
    }
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it('exits non-zero through the exit abstraction for an interactive-only command', async () => {
    const workspace = printWorkspace();
    const provider = createRepeatingScriptedProvider(() => sseResponse([]));
    vi.stubGlobal('fetch', provider.fetch);
    const codes: number[] = [];
    setExitFn(((code: number) => {
      codes.push(code);
      throw new Error('process.exit');
    }) as (code: number) => never);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });

    await expect(runMainAction(printOptions(workspace, '/clear'))).rejects.toThrow('process.exit');

    expect(codes).toEqual([1]);
    expect(errors.join('\n')).toContain('/clear');
    expect(errors.join('\n')).toContain('Commands supported in print mode:');
    // The refusal happens before the model is ever asked.
    expect(provider.requests.length).toBe(0);
  });

  it('runs a resolved custom command body and exits normally', async () => {
    const workspace = printWorkspace();
    mkdirSync(join(workspace, '.book', 'commands'), { recursive: true });
    writeFileSync(
      join(workspace, '.book', 'commands', 'triage.md'),
      'Triage $ARGUMENTS please',
      'utf-8',
    );
    const provider = createRepeatingScriptedProvider(() =>
      sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })]),
    );
    vi.stubGlobal('fetch', provider.fetch);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    setExitFn(((code: number) => {
      throw new Error(`unexpected exit(${code})`);
    }) as (code: number) => never);

    await runMainAction(printOptions(workspace, '/triage parser'));

    expect(provider.requests.length).toBe(1);
    expect(String(provider.requests[0].init?.body)).toContain('Triage parser please');
    expect(writes.join('')).toContain('ok');
  });

  /** Dirty git worktree so `/review` has a real target to resolve. */
  function reviewWorkspace(): string {
    const workspace = printWorkspace();
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: workspace,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    git('init', '-q');
    git('config', 'user.email', 'book-tests@example.invalid');
    git('config', 'user.name', 'Book Tests');
    writeFileSync(join(workspace, 'a.ts'), 'export const value = 1;\n', 'utf-8');
    git('add', '.');
    git('commit', '-qm', 'initial');
    writeFileSync(join(workspace, 'a.ts'), 'export const value = 2;\n', 'utf-8');
    return workspace;
  }

  it('runs /review to completion and prints the report', async () => {
    const workspace = reviewWorkspace();
    const report = JSON.stringify({
      verdict: 'recommend',
      findings: [
        {
          severity: 'major',
          category: 'correctness',
          file: 'a.ts',
          line: 1,
          summary: 'the exported constant changed meaning',
          evidence: 'export const value = 2;',
          failure: 'callers branching on value === 1 stop matching',
          suggestedFix: 'add a new constant instead',
          confidence: 91,
        },
      ],
    });
    const provider = createRepeatingScriptedProvider(() =>
      sseResponse([JSON.stringify({ choices: [{ delta: { content: report } }] })]),
    );
    vi.stubGlobal('fetch', provider.fetch);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    setExitFn(((code: number) => {
      throw new Error(`unexpected exit(${code})`);
    }) as (code: number) => never);

    await runMainAction(printOptions(workspace, '/review'));

    expect(writes.join('')).toContain('Verdict: recommend');
    expect(writes.join('')).toContain('the exported constant changed meaning');
    // The reviewer agent was asked; the parent loop never was.
    expect(provider.requests.length).toBe(1);
  }, 30000);

  it('exits non-zero for /review --fix instead of patching unattended', async () => {
    const workspace = reviewWorkspace();
    const provider = createRepeatingScriptedProvider(() => sseResponse([]));
    vi.stubGlobal('fetch', provider.fetch);
    const codes: number[] = [];
    setExitFn(((code: number) => {
      codes.push(code);
      throw new Error('process.exit');
    }) as (code: number) => never);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });

    await expect(runMainAction(printOptions(workspace, '/review --fix'))).rejects.toThrow(
      'process.exit',
    );

    expect(codes).toEqual([1]);
    expect(errors.join('\n')).toContain('/review --fix needs an interactive session');
    expect(provider.requests.length).toBe(0);
  }, 30000);
});
