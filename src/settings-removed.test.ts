import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectRemovedEnvNotices,
  collectRemovedSettingNotices,
  readSettingsDocumentForNotices,
} from './settings-removed.js';
import { bookSettingsSchema } from './settings.js';

const keys = (document: unknown): string[] =>
  collectRemovedSettingNotices(document).map((notice) => notice.key);

describe('collectRemovedSettingNotices', () => {
  it('still reports a removed top-level block and a removed compactStrategy value', () => {
    expect(keys({ auth: { profile: 'x' }, harness: {} })).toEqual(['auth', 'harness']);
    expect(keys({ compactStrategy: 'zero-mem' })).toEqual(['compactStrategy']);
    expect(keys({ compactStrategy: 'summary' })).toEqual([]);
  });

  it('reports each removed key nested in the memory block, by its dotted path', () => {
    const notices = collectRemovedSettingNotices({
      memory: {
        enabled: true,
        autoSave: false,
        requireApproval: true,
        quarantineExternal: false,
        extraction: { enabled: true, idleHours: 1 },
      },
    });
    expect(notices.map((notice) => notice.key)).toEqual([
      'memory.requireApproval',
      'memory.quarantineExternal',
      'memory.extraction',
    ]);
    // Each says what to do, and names the surviving switch where there is one.
    expect(notices[0].message).toContain('memory.autoSave');
    expect(notices[1].message).toContain('Delete memory.quarantineExternal');
    expect(notices[2].message).toContain('Delete the memory.extraction block');
  });

  it('reports a key whatever its value, a `false` or an empty block included', () => {
    expect(keys({ memory: { requireApproval: false } })).toEqual(['memory.requireApproval']);
    expect(keys({ memory: { extraction: {} } })).toEqual(['memory.extraction']);
    expect(keys({ memory: { extraction: null } })).toEqual(['memory.extraction']);
  });

  it('reports nothing for the memory keys that survive, or a document without a memory block', () => {
    expect(keys({ memory: { enabled: false, autoSave: true } })).toEqual([]);
    expect(keys({ memory: {} })).toEqual([]);
    expect(keys({})).toEqual([]);
  });

  it('does not walk into a memory value that is not an object', () => {
    for (const memory of [null, 'on', 3, [], ['requireApproval']]) {
      expect(keys({ memory }), JSON.stringify(memory)).toEqual([]);
    }
  });

  it('reports a permission rule naming MemorySave, bare or with a pattern, in any list', () => {
    const notices = collectRemovedSettingNotices({
      permissions: {
        allow: ['MemorySave'],
        ask: ['Read(.env)', 'MemorySave(*)'],
        deny: ['  MemorySave (save)', 'Bash(rm *)'],
      },
    });
    expect(notices.map((notice) => notice.key)).toEqual([
      'permissions.allow',
      'permissions.ask',
      'permissions.deny',
    ]);
    // The rule is quoted back, and the remedy points at the tools that write memory now.
    expect(notices[1].message).toContain('"MemorySave(*)"');
    expect(notices[1].message).toContain('Write, Edit and ApplyPatch');
    expect(notices[1].message).toContain('memory.autoSave');
  });

  it('reports each MemorySave rule once, and leaves lookalikes and other tools alone', () => {
    expect(keys({ permissions: { deny: ['MemorySave', 'MemorySave(x)'] } })).toEqual([
      'permissions.deny',
      'permissions.deny',
    ]);
    expect(
      keys({
        permissions: {
          allow: ['MemorySaver', 'MemorySavePlus(x)', 'Write(memory/*.md)', 'mcp__MemorySave__x'],
          deny: [42, null, {}],
        },
      }),
    ).toEqual([]);
  });

  it('survives permission lists that are not arrays, and a permissions value that is not a record', () => {
    expect(keys({ permissions: { deny: 'MemorySave' } })).toEqual([]);
    expect(keys({ permissions: 'MemorySave' })).toEqual([]);
    expect(keys({ permissions: null })).toEqual([]);
  });

  it('is empty for a document that is not a record', () => {
    for (const document of [undefined, null, 'x', 3, []]) {
      expect(collectRemovedSettingNotices(document)).toEqual([]);
    }
  });
});

describe('a settings document that still carries the removed keys', () => {
  it('parses: the schema drops the memory keys instead of failing on them', () => {
    const parsed = bookSettingsSchema.parse({
      memory: {
        autoSave: false,
        requireApproval: true,
        quarantineExternal: false,
        extraction: { enabled: true },
      },
      permissions: { deny: ['MemorySave'] },
    });
    expect(parsed.memory).toEqual({ enabled: true, autoSave: false });
    // The rule itself is kept (it is inert), which is why doctor reports it.
    expect(parsed.permissions.deny).toEqual(['MemorySave']);
  });
});

describe('reading a document for notices', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('feeds a settings file through the same collector', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-removed-'));
    dirs.push(dir);
    const path = join(dir, 'settings.json');
    writeFileSync(
      path,
      JSON.stringify({ memory: { requireApproval: true }, permissions: { ask: ['MemorySave'] } }),
    );
    expect(keys(readSettingsDocumentForNotices(path))).toEqual([
      'memory.requireApproval',
      'permissions.ask',
    ]);
    expect(keys(readSettingsDocumentForNotices(join(dir, 'missing.json')))).toEqual([]);
  });
});

describe('collectRemovedEnvNotices', () => {
  it('is unchanged by the memory rework', () => {
    expect(collectRemovedEnvNotices({}).length).toBe(0);
    expect(collectRemovedEnvNotices({ BOOK_AUTH_PROFILE: 'x' }).map((n) => n.key)).toEqual([
      'BOOK_AUTH_PROFILE',
    ]);
  });
});
