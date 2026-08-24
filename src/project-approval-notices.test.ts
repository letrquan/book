import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
