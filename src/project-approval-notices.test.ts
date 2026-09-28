import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeProject(settings: unknown): void {
  mkdirSync(join(workspace, '.book'), { recursive: true });
  writeFileSync(join(workspace, '.book', 'settings.json'), JSON.stringify(settings));
}

const trustPath = () => join(home, '.book', 'trust.json');
const resolved = () => resolveSettings(workspace, undefined, { home });
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
