import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectWithheldProjectNotices } from './project-approval-notices.js';
import { hookFingerprint } from './hook-approvals.js';
import { resolveSettings } from './settings-loader.js';
import { DEFAULT_SETTINGS, type ResolvedSettings } from './settings.js';
import { updateWorkspaceTrust } from './workspace-trust.js';

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-notices-ws-'));
  home = mkdtempSync(join(tmpdir(), 'book-notices-home-'));
  // The notices resolve the user-global layer themselves, through `BOOK_HOME`, so
  // without this the suite would read the developer's real settings.
  vi.stubEnv('BOOK_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeProject(settings: unknown): void {
  mkdirSync(join(workspace, '.book'), { recursive: true });
  writeFileSync(join(workspace, '.book', 'settings.json'), JSON.stringify(settings));
}

/**
 * The two workspace layers, and the user-global one. `BOOK_HOME` is pointed at a
 * temp directory so the suite neither reads nor writes the developer's real
 * settings, and so the activation question is asked of a baseline the test owns.
 */
function writeLocal(settings: unknown): void {
  mkdirSync(join(workspace, '.book'), { recursive: true });
  writeFileSync(join(workspace, '.book', 'settings.local.json'), JSON.stringify(settings));
}

/** `BOOK_HOME` is the directory itself, so the user layer is the file in it. */
function writeUser(settings: unknown): void {
  writeFileSync(userPath(), JSON.stringify(settings));
}

const trustPath = () => join(home, '.book', 'trust.json');
// The same file the notices resolve themselves, so both halves of the suite see
// one user layer rather than a resolved one and a read one.
const userPath = () => join(home, 'settings.json');
const resolved = () =>
  resolveSettings(workspace, undefined, {
    userSettingsPath: userPath(),
    home,
    trustStorePath: trustPath(),
  });
const notices = (settings: ResolvedSettings, settingsEnabled = true) =>
  collectWithheldProjectNotices({ workspace, settings, settingsEnabled });

describe('collectWithheldProjectNotices', () => {
  it('says nothing when the project declares nothing gated', () => {
    writeProject({ permissions: { deny: ['Bash(rm *)'] } });

    expect(notices(resolved())).toEqual([]);
  });

  it('names each withheld allow rule and counts withheld hooks by event', () => {
    writeProject({
      permissions: { allow: ['Bash(curl *)'] },
      hooks: {
        PreToolUse: [{ command: 'a.sh' }, { command: 'b.sh' }],
        Stop: [{ command: 'c.sh' }],
      },
    });

    const reported = notices(resolved()).join('\n');

    expect(reported).toContain('Ignoring project-declared permission rule "Bash(curl *)"');
    expect(reported).toContain('Ignoring 3 project-declared hook(s) (PreToolUse x2, Stop x1)');
    expect(reported).toContain('Run `book doctor` to approve them.');
  });

  it('drops a declaration once it has been decided', () => {
    writeProject({ hooks: { PreToolUse: [{ command: 'a.sh' }, { command: 'b.sh' }] } });
    updateWorkspaceTrust(
      workspace,
      (trust) => {
        trust.hookEntries[hookFingerprint('PreToolUse', { command: 'a.sh', env: {} })] = 'approved';
      },
      trustPath(),
    );

    expect(notices(resolved()).join('\n')).toContain('Ignoring 1 project-declared hook(s)');
  });

  // Under `--no-settings` no layer was read, so nothing is withheld awaiting a
  // decision. Reporting one would send the user after a decision that changes
  // nothing — and, the decision store being empty too, would announce hooks the
  // user has already approved as if they had never been asked about.
  it('says nothing under --no-settings, even with pending declarations on disk', () => {
    writeProject({
      permissions: { allow: ['Bash(curl *)'] },
      hooks: { PreToolUse: [{ command: 'a.sh' }] },
    });

    expect(notices(structuredClone(DEFAULT_SETTINGS) as ResolvedSettings, false)).toEqual([]);
  });
});

/**
 * A withheld sandbox key has no other symptom either, and a worse one: the run is
 * simply *less* protected than the repository says, so nothing fails and the
 * session looks ordinary. Print and SDK runs cannot ask about it, so they report
 * what they ignored and where the value has to go instead.
 */
describe('an ignored sandbox key in a workspace layer is reported', () => {
  it('names each ignored key with the value the file wrote', () => {
    writeProject({
      sandbox: {
        enabled: false,
        excludedCommands: ['*'],
        filesystem: { allowWrite: ['/'], denyRead: ['~/.ssh'] },
      },
    });

    const reported = notices(resolved()).join('\n');

    expect(reported).toContain('sandbox.enabled=false');
    expect(reported).toContain('sandbox.excludedCommands=["*"]');
    expect(reported).toContain('sandbox.filesystem.allowWrite=["/"]');
    // The honoured half of the same section is not reported: a deny entry is the
    // one thing a repository may add, and reporting it would train the reader to
    // ignore the notice.
    expect(reported).not.toContain('denyRead');
    expect(reported).toContain('~/.book/settings.json');
  });

  it('says nothing for a sandbox section that only tightens', () => {
    writeProject({
      sandbox: {
        filesystem: { denyRead: ['./secrets'] },
        network: { deniedDomains: ['tracker.example'] },
      },
    });

    expect(notices(resolved())).toEqual([]);
  });

  it('says nothing under --no-settings, like every other withheld declaration', () => {
    writeProject({ sandbox: { enabled: false } });

    expect(notices(structuredClone(DEFAULT_SETTINGS) as ResolvedSettings, false)).toEqual([]);
  });

  /**
   * The local layer is filtered exactly as the project one is — `.gitignore` does
   * not stop a force-added `settings.local.json` from reaching a clone — and it
   * was not read here at all, so a file asking to widen the sandbox was being
   * stripped in silence.
   */
  it('names an ignored key from the local layer, with the file it came from', () => {
    writeLocal({ sandbox: { excludedCommands: ['*'] } });

    const reported = notices(resolved()).join('\n');

    expect(reported).toContain(join(workspace, '.book', 'settings.local.json'));
    expect(reported).toContain('sandbox.excludedCommands=["*"]');
  });

  it('names the file, so the reader knows which of the two to edit', () => {
    writeProject({ sandbox: { enabled: false } });
    writeLocal({ sandbox: { filesystem: { allowWrite: ['/'] } } });

    const reported = notices(resolved()).join('\n');

    expect(reported).toContain(`declared by ${join(workspace, '.book', 'settings.json')}`);
    expect(reported).toContain(`declared by ${join(workspace, '.book', 'settings.local.json')}`);
  });

  it('reports allowGitWrites: true as an ignored sandbox key from project and local layers', () => {
    writeProject({ sandbox: { filesystem: { allowGitWrites: true } } });
    writeLocal({ sandbox: { filesystem: { allowGitWrites: true } } });

    const reported = notices(resolved()).join('\n');

    expect(reported).toContain('sandbox.filesystem.allowGitWrites=true');
    expect(reported).toContain(`declared by ${join(workspace, '.book', 'settings.json')}`);
    expect(reported).toContain(`declared by ${join(workspace, '.book', 'settings.local.json')}`);
  });
});

/**
 * `sandbox.enabled` is the one key a workspace layer may set, and the loader
 * pairs it with `autoAllowBashIfSandboxed: false` (#373). Nothing fails, nothing
 * is refused, and the user simply stops being asked before each command — so it
 * is reported, and only for the layer that actually flipped the key on.
 */
describe('a workspace layer that turned the sandbox on is reported', () => {
  it('names the layer whose enabled: true cost the session its auto-allow', () => {
    writeProject({ sandbox: { enabled: true } });

    const reported = notices(resolved()).join('\n');

    expect(reported).toContain(join(workspace, '.book', 'settings.json'));
    expect(reported).toContain('sandbox.enabled=true');
    expect(reported).toContain('sandbox.autoAllowBashIfSandboxed');
  });

  it('names the local layer when that is the one that turned it on', () => {
    writeLocal({ sandbox: { enabled: true } });

    const reported = notices(resolved()).join('\n');

    expect(reported).toContain(join(workspace, '.book', 'settings.local.json'));
  });

  it('says nothing when a trusted layer had already turned the sandbox on', () => {
    // The user enabled it and kept auto-allow on; a checked-in layer repeating
    // the key changed nothing, and reporting it every run is how a notice gets
    // ignored.
    writeUser({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } });
    writeProject({ sandbox: { enabled: true } });
    writeLocal({ sandbox: { enabled: true } });

    expect(notices(resolved())).toEqual([]);
  });

  it('says nothing when no layer declares it', () => {
    writeProject({ permissions: { deny: ['Bash(rm *)'] } });

    expect(notices(resolved())).toEqual([]);
  });
});

/**
 * #300. A withheld `additionalDirectories` entry is the only gated declaration with no other
 * symptom: the run simply cannot see the directory, so the model reports the file as missing
 * rather than as un-approved. The notice is what turns that into something the operator can fix,
 * and it names the real path because that is what `book trust dir` matches on.
 */
describe('a withheld additionalDirectories entry is reported', () => {
  let shared: string;

  beforeEach(() => {
    shared = mkdtempSync(join(tmpdir(), 'book-notices-shared-'));
  });

  afterEach(() => {
    rmSync(shared, { recursive: true, force: true });
  });

  it('names the declared text and the real path, and points at doctor', () => {
    symlinkSync(shared, join(workspace, 'link'), 'junction');
    writeProject({ additionalDirectories: ['link'] });

    const reported = notices(resolved()).join('\n');

    expect(reported).toContain('Ignoring project-declared additionalDirectories entry "link"');
    expect(reported).toContain(realpathSync.native(shared));
    expect(reported).toContain('book doctor');
  });

  it('says nothing once the directory has been decided', () => {
    writeProject({ additionalDirectories: [shared] });
    updateWorkspaceTrust(
      workspace,
      (trust) => {
        trust.projectDirectories[realpathSync.native(shared)] = 'approved';
      },
      join(home, '.book', 'trust.json'),
    );

    expect(notices(resolved())).toEqual([]);
  });

  it('says nothing for a rejected directory, which is not awaiting anything', () => {
    writeProject({ additionalDirectories: [shared] });
    updateWorkspaceTrust(
      workspace,
      (trust) => {
        trust.projectDirectories[realpathSync.native(shared)] = 'rejected';
      },
      join(home, '.book', 'trust.json'),
    );

    expect(notices(resolved())).toEqual([]);
  });

  it('says nothing for a directory the user declared themselves', () => {
    mkdirSync(join(home, '.book'), { recursive: true });
    writeFileSync(
      join(home, '.book', 'settings.json'),
      JSON.stringify({ additionalDirectories: [shared] }),
    );

    expect(notices(resolved())).toEqual([]);
  });

  it('says nothing for an entry that does not exist', () => {
    writeProject({ additionalDirectories: [join(workspace, 'not-here')] });

    expect(notices(resolved())).toEqual([]);
  });

  it('reports each pending entry separately', () => {
    const other = mkdtempSync(join(tmpdir(), 'book-notices-other-'));
    try {
      writeProject({ additionalDirectories: [shared, other] });

      const reported = notices(resolved());
      expect(reported.filter((line) => line.includes('additionalDirectories'))).toHaveLength(2);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
