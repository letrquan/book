import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDoctorCommand } from './doctor.js';

// Only the backend probe is stubbed; `sandboxPolicySummary` and everything else
// stay real. Whether the developer's machine has bubblewrap installed must not
// decide which branch of the policy report these tests exercise.
vi.mock('../sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandbox.js')>();
  return {
    ...actual,
    createSandbox: (settings: Parameters<typeof actual.createSandbox>[0]) =>
      settings.enabled
        ? { wrap: () => ({ file: 'bwrap', args: [] }), describe: () => 'stub backend' }
        : null,
  };
});

let workspace: string;
let bookHome: string;
const previousEnv: Record<string, string | undefined> = {};

function writeSettings(
  sandbox: Record<string, unknown>,
  permissions?: Record<string, unknown>,
): void {
  mkdirSync(join(workspace, '.book'), { recursive: true });
  writeFileSync(
    join(workspace, '.book', 'settings.json'),
    JSON.stringify(permissions ? { sandbox, permissions } : { sandbox }),
  );
}

async function doctorOutput(): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await runDoctorCommand(workspace);
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
  return lines.join('\n');
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-doctor-ws-'));
  bookHome = mkdtempSync(join(tmpdir(), 'book-doctor-home-'));
  // loadConfig throws without an API key, so doctor needs one to reach the
  // sandbox section at all.
  for (const key of ['BOOK_HOME', 'BOOK_API_KEY']) previousEnv[key] = process.env[key];
  process.env.BOOK_HOME = bookHome;
  process.env.BOOK_API_KEY = 'test-key';
});

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workspace, { recursive: true, force: true });
  rmSync(bookHome, { recursive: true, force: true });
});

describe('runDoctorCommand sandbox policy', () => {
  it('reports the enforced state of allowUnsandboxedCommands and autoAllowBashIfSandboxed', async () => {
    writeSettings({ enabled: false });

    const output = await doctorOutput();

    expect(output).toContain(
      'Unsandboxed commands: allowed (sandbox.allowUnsandboxedCommands=true)',
    );
    // Sandboxing is off, so the auto-allow key cannot bite: doctor must not
    // report a policy stronger than the one actually enforced.
    expect(output).toMatch(/Auto-allow Bash: inert/);
  });

  it('reports unsandboxed commands as refused when the key is false', async () => {
    writeSettings({ enabled: false, allowUnsandboxedCommands: false });

    const output = await doctorOutput();

    expect(output).toContain(
      'Unsandboxed commands: refused (sandbox.allowUnsandboxedCommands=false)',
    );
  });

  it('reports auto-allow as off when the key is disabled', async () => {
    writeSettings({ enabled: false, autoAllowBashIfSandboxed: false });

    const output = await doctorOutput();

    expect(output).toContain('sandbox.autoAllowBashIfSandboxed=false');
    expect(output).toMatch(/Auto-allow Bash: off/);
  });

  it('reports auto-allow as on when the sandbox is active and nothing is adjudicated', async () => {
    writeSettings({ enabled: true });

    expect(await doctorOutput()).toMatch(/Auto-allow Bash: on for/);
  });

  // Doctor must not claim a policy stronger than the enforced one: a deny/ask
  // list keeps the default ask, so the auto-allow never fires while one exists.
  it('reports auto-allow as inert when deny/ask rules are configured', async () => {
    writeSettings({ enabled: true }, { deny: ['Bash(rm *)'] });

    const output = await doctorOutput();

    expect(output).toMatch(/Auto-allow Bash: inert/);
    expect(output).toContain('permissions.deny/ask');
  });

  it('reports how many commands are excluded from the sandbox', async () => {
    writeSettings({ enabled: true, excludedCommands: ['docker *', 'kubectl *'] });

    const output = await doctorOutput();

    expect(output).toContain('Excluded commands: 2');
  });
});
