import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveSettings } from '../settings-loader.js';
import { configuredAdvisorModel, loadConfig, resolveModelProviderConfig } from '../config.js';
import { resolveContextWindow } from '../models.js';
import { defaultConfig } from '../test/fixtures.js';
import {
  persistWorkspaceProviderChoice,
  workspaceProviderFingerprint,
} from '../provider-approvals.js';
import {
  persistSettingLocal,
  persistSettingsLocal,
  persistPermissionRuleLocal,
  persistSettingGlobal,
  persistSettingsGlobal,
  persistAgentProfileModel,
  persistSkillActivationLocal,
  persistSkillExecutionLocal,
  persistSkillsEnabledLocal,
  readSettingsLocal,
  readSettingsGlobal,
  readUserProvider,
  removeProviderLocal,
  removeProviderGlobal,
  clearLocalSettings,
  liveProviderAfterSave,
  persistProviderSave,
  turnOffAdvisorModel,
} from './persist.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-persist-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('persistSettingLocal', () => {
  it('returns ok and never throws/exits; writes a nested key to settings.local.json', () => {
    const r = persistSettingLocal(dir, 'model', 'claude-sonnet-5');
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();

    const localPath = join(dir, '.book', 'settings.local.json');
    expect(existsSync(localPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(localPath, 'utf-8'));
    expect(parsed.model).toBe('claude-sonnet-5');
  });

  it('merges with an existing local settings file without clobbering other keys', () => {
    persistSettingLocal(dir, 'model', 'claude-sonnet-5');
    persistSettingLocal(dir, 'maxTurns', 50);
    expect(readSettingsLocal(dir)).toEqual({ model: 'claude-sonnet-5', maxTurns: 50 });
  });

  it('refuses to write the shell setting to workspace-local settings', () => {
    const result = persistSettingLocal(dir, 'shell', 'pwsh');

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('cannot be written'),
    });
    expect(existsSync(join(dir, '.book', 'settings.local.json'))).toBe(false);
  });

  /**
   * The loader decides a sandbox key by its *value*, so a writer that refuses by
   * path alone refuses the harmless half of the surface: `enabled: true` is the
   * one value a workspace layer may set, and the deny lists are the whole point of
   * letting it set them.
   */
  it.each([
    ['sandbox.enabled', false],
    ['sandbox.failIfUnavailable', false],
    ['sandbox.allowUnsandboxedCommands', true],
    ['sandbox.autoAllowBashIfSandboxed', true],
    ['sandbox.excludedCommands', ['*']],
    ['sandbox.filesystem.allowWrite', ['/']],
    ['sandbox.network.allowedDomains', ['*']],
  ])('refuses the ignored sandbox value %s = %j', (key, value) => {
    const result = persistSettingLocal(dir, key, value);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ignored');
    expect(result.error).toContain('~/.book/settings.json');
    expect(existsSync(join(dir, '.book', 'settings.local.json'))).toBe(false);
  });

  it.each([
    ['sandbox.enabled', true],
    ['sandbox.failIfUnavailable', true],
    ['sandbox.allowUnsandboxedCommands', false],
    ['sandbox.autoAllowBashIfSandboxed', false],
    ['sandbox.filesystem.denyRead', ['~/.ssh']],
    ['sandbox.filesystem.denyWrite', ['/etc']],
    ['sandbox.network.deniedDomains', ['evil.example']],
  ])('writes the tightening sandbox value %s = %j', (key, value) => {
    expect(persistSettingLocal(dir, key, value).ok).toBe(true);
    expect(readSettingsLocal(dir)).toMatchObject({ sandbox: expect.anything() });
  });

  it('refuses a whole sandbox object that carries an ignored key, and names it', () => {
    // `book config set sandbox '{…}'` is the same decision as the nested write,
    // so it is judged the same way rather than passing the path check.
    const result = persistSettingLocal(dir, 'sandbox', {
      enabled: true,
      filesystem: { denyRead: ['~/.ssh'], allowWrite: ['/'] },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('sandbox.filesystem.allowWrite');
    expect(existsSync(join(dir, '.book', 'settings.local.json'))).toBe(false);
  });

  it('judges a whole sandbox.filesystem object by the keys it declares', () => {
    // Writing the section replaces `allowWrite` wholesale, so declaring it is
    // the decision the loader drops — even as `[]`, which is why the loader
    // reports an explicitly empty array rather than treating it as a no-op.
    const declared = persistSettingLocal(dir, 'sandbox.filesystem', { allowWrite: [] });
    expect(declared.ok).toBe(false);
    expect(declared.error).toContain('sandbox.filesystem.allowWrite');

    // Only deny entries, on the other hand, is a section that can narrow.
    expect(persistSettingLocal(dir, 'sandbox.filesystem', { denyRead: ['~/.ssh'] }).ok).toBe(true);
  });

  it('writes nested provider registry keys', () => {
    persistSettingLocal(dir, 'provider.openrouter.type', 'openai');
    persistSettingLocal(dir, 'provider.openrouter.baseURL', 'https://openrouter.ai/api/v1');
    persistSettingLocal(dir, 'provider.openrouter.models.deepseek-chat.contextWindow', 128000);
    const provider = readSettingsLocal(dir).provider as {
      openrouter: {
        type: string;
        baseURL: string;
        models: Record<string, { contextWindow: number }>;
      };
    };
    expect(provider.openrouter.type).toBe('openai');
    expect(provider.openrouter.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(provider.openrouter.models['deepseek-chat'].contextWindow).toBe(128000);
  });

  it('writes multiple settings atomically without splitting model IDs on dots', () => {
    const provider = {
      type: 'openai',
      apiKey: 'secret',
      models: { 'vendor/model.v2': { label: 'Model V2' } },
    };
    expect(
      persistSettingsLocal(dir, {
        'provider.gateway': provider,
        model: 'gateway/vendor/model.v2',
      }).ok,
    ).toBe(true);
    expect(readSettingsLocal(dir)).toEqual({
      provider: { gateway: provider },
      model: 'gateway/vendor/model.v2',
    });
  });

  it('returns {ok:false, error} on a bad workspace rather than throwing', () => {
    const badWorkspace = join(dir, 'not-a-directory');
    writeFileSync(badWorkspace, 'not a directory');

    const r = persistSettingLocal(badWorkspace, 'model', 'x');
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  it('preserves malformed local settings instead of replacing them', () => {
    const localPath = join(dir, '.book', 'settings.local.json');
    expect(persistSettingLocal(dir, 'model', 'initial').ok).toBe(true);
    writeFileSync(localPath, '{broken', 'utf-8');

    const result = persistSettingLocal(dir, 'model', 'replacement');

    expect(result.ok).toBe(false);
    expect(readFileSync(localPath, 'utf-8')).toBe('{broken');
  });
});

describe('persistAgentProfileModel', () => {
  it('keeps dotted profile names as literal keys and persists inherit', () => {
    expect(persistAgentProfileModel(dir, 'code.review', 'gateway/model.v2').ok).toBe(true);
    expect(persistAgentProfileModel(dir, 'code.review').ok).toBe(true);
    expect(readSettingsLocal(dir)).toMatchObject({
      agents: { profiles: { 'code.review': { model: 'inherit' } } },
    });
  });
});

describe('persistSkillActivationLocal', () => {
  it('keeps dotted skill names as literal override keys', () => {
    expect(persistSkillActivationLocal(dir, 'release.v2', 'manual').ok).toBe(true);
    expect(readSettingsLocal(dir)).toMatchObject({
      skills: { overrides: { 'release.v2': 'manual' } },
    });
  });

  it('persists consent policies and the global switch independently', () => {
    expect(persistSkillExecutionLocal(dir, 'release.v2', 'ask').ok).toBe(true);
    expect(persistSkillsEnabledLocal(dir, false).ok).toBe(true);
    expect(readSettingsLocal(dir)).toMatchObject({
      skills: { enabled: false, execution: { 'release.v2': 'ask' } },
    });
  });
});

describe('persistPermissionRuleLocal', () => {
  it('appends a rule to permissions.allow and dedupes exact repeats', () => {
    expect(persistPermissionRuleLocal(dir, 'allow', 'Bash(npm install)').ok).toBe(true);
    expect(persistPermissionRuleLocal(dir, 'allow', 'Bash(npm install)').ok).toBe(true); // dup
    expect(persistPermissionRuleLocal(dir, 'allow', 'Read(./.env)').ok).toBe(true);
    const perms = readSettingsLocal(dir).permissions as { allow: string[] };
    expect(perms.allow).toEqual(['Bash(npm install)', 'Read(./.env)']);
  });

  it('writes each list under its own permissions key', () => {
    persistPermissionRuleLocal(dir, 'deny', 'Bash(rm -rf)');
    persistPermissionRuleLocal(dir, 'ask', 'WebFetch');
    const perms = readSettingsLocal(dir).permissions as {
      allow: string[];
      deny: string[];
      ask: string[];
    };
    expect(perms.deny).toEqual(['Bash(rm -rf)']);
    expect(perms.ask).toEqual(['WebFetch']);
    expect(perms.allow).toBeUndefined();
  });
});

describe('removeProviderLocal', () => {
  function writeLocal(settings: Record<string, unknown>): string {
    persistSettingsLocal(dir, settings);
    return join(dir, '.book', 'settings.local.json');
  }

  it('removes the complete provider while preserving siblings and unrelated settings', () => {
    const localPath = writeLocal({
      model: 'gateway/custom',
      maxTurns: 42,
      theme: 'light',
      provider: {
        gateway: {
          type: 'openai',
          baseURL: 'https://gateway.test/v1',
          apiKey: 'top-secret',
          models: {
            custom: { label: 'Custom', maxOutputTokens: 8192 },
            second: { contextWindow: 128000 },
          },
        },
        other: {
          type: 'anthropic',
          apiKey: 'other-secret',
          models: { model: { label: 'Other' } },
        },
      },
    });

    expect(removeProviderLocal(dir, 'gateway')).toEqual({
      ok: true,
      providerId: 'gateway',
      removedModelCount: 2,
      localDefaultCleared: true,
      localProviderExisted: true,
    });
    expect(readSettingsLocal(dir)).toEqual({
      maxTurns: 42,
      theme: 'light',
      provider: {
        other: {
          type: 'anthropic',
          apiKey: 'other-secret',
          models: { model: { label: 'Other' } },
        },
      },
    });
    const serialized = readFileSync(localPath, 'utf-8');
    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('Custom');
    expect(serialized.endsWith('\n')).toBe(true);
  });

  it('prunes the provider registry when the last local provider is removed', () => {
    writeLocal({ provider: { gateway: { type: 'openai', models: { custom: {} } } } });

    expect(removeProviderLocal(dir, 'gateway').ok).toBe(true);
    expect(readSettingsLocal(dir)).toEqual({});
  });

  it('keeps a local model selection that references another provider', () => {
    writeLocal({
      model: 'other/model',
      provider: {
        gateway: { type: 'openai', models: { custom: {} } },
        other: { type: 'openai', models: { model: {} } },
      },
    });

    const result = removeProviderLocal(dir, 'gateway');
    expect(result.ok && result.localDefaultCleared).toBe(false);
    expect(readSettingsLocal(dir).model).toBe('other/model');
  });

  it('rejects a missing local provider without rewriting the file', () => {
    const localPath = writeLocal({
      model: 'project-model',
      provider: { other: { type: 'openai', models: { model: {} } } },
    });
    const before = readFileSync(localPath, 'utf-8');

    const result = removeProviderLocal(dir, 'gateway');

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        localProviderExisted: false,
        error: expect.stringContaining('not configured'),
      }),
    );
    expect(readFileSync(localPath, 'utf-8')).toBe(before);
  });

  it('returns an error for an invalid workspace and does not throw', () => {
    const badWorkspace = join(dir, 'not-a-directory');
    writeFileSync(badWorkspace, 'not a directory');

    expect(removeProviderLocal(badWorkspace, 'gateway')).toEqual(
      expect.objectContaining({ ok: false, localProviderExisted: false }),
    );
  });

  it('reveals a lower-layer provider and removes stale local selection on restart', () => {
    writeLocal({
      model: 'gateway/local',
      provider: {
        gateway: {
          type: 'openai',
          apiKey: 'local-key',
          models: { local: { label: 'Local' } },
        },
      },
    });
    writeFileSync(
      join(dir, '.book', 'settings.json'),
      JSON.stringify(
        {
          model: 'project-model',
          provider: {
            gateway: {
              type: 'openai',
              apiKey: 'project-key',
              models: { inherited: { label: 'Inherited' } },
            },
          },
        },
        null,
        2,
      ) + '\n',
    );

    expect(removeProviderLocal(dir, 'gateway').ok).toBe(true);
    // An absent user layer, so the machine's own ~/.book/settings.json cannot take part.
    const restarted = resolveSettings(dir, undefined, {
      userSettingsPath: join(dir, 'no-user-settings.json'),
      trustStorePath: join(dir, 'trust.json'),
    });

    expect(restarted.model).toBe('project-model');
    // A provider only the project layer declares stays withheld until approved (#418), so the
    // revealed lower-layer entry is checked once its declaration has been approved.
    expect(restarted.provider.gateway).toBeUndefined();
    const declaration = { type: 'openai', apiKey: 'project-key' } as const;
    persistWorkspaceProviderChoice(
      dir,
      'gateway',
      workspaceProviderFingerprint(declaration),
      'approved',
      join(dir, 'trust.json'),
    );
    const approved = resolveSettings(dir, undefined, {
      userSettingsPath: join(dir, 'no-user-settings.json'),
      trustStorePath: join(dir, 'trust.json'),
    });
    expect(approved.provider.gateway.apiKey).toBe('project-key');
    expect(approved.provider.gateway.models).toEqual({ inherited: { label: 'Inherited' } });
    expect(readSettingsLocal(dir)).toEqual({});
  });
});

describe('global scope (~/.book/settings.json)', () => {
  // The global helpers resolve their path via os.homedir(), which reads HOME on
  // POSIX and USERPROFILE on Windows. Point both at a temp dir so writes land in
  // an isolated fake home instead of the developer's real ~/.book.
  // An explicit BOOK_HOME outranks the home directory, so it is cleared for the block: these
  // tests exercise the homedir() fallback, and a suite run with BOOK_HOME set must not send
  // their writes to that directory instead of the fake home.
  let home: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedBookHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'book-home-'));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedBookHome = process.env.BOOK_HOME;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.BOOK_HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedBookHome === undefined) delete process.env.BOOK_HOME;
    else process.env.BOOK_HOME = savedBookHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('writes provider and model to the global settings.json, not the workspace', () => {
    const provider = {
      type: 'openai',
      apiKey: 'secret',
      models: { 'deepseek-chat': { label: 'DeepSeek' } },
    };
    expect(
      persistSettingsGlobal({
        'provider.gateway': provider,
        model: 'gateway/deepseek-chat',
      }).ok,
    ).toBe(true);

    const globalPath = join(home, '.book', 'settings.json');
    expect(existsSync(globalPath)).toBe(true);
    expect(readSettingsGlobal()).toEqual({
      provider: { gateway: provider },
      model: 'gateway/deepseek-chat',
    });
    // Nothing should have been written to the project-local layer.
    expect(existsSync(join(dir, '.book', 'settings.local.json'))).toBe(false);
  });

  it('a global provider resolves for any workspace', () => {
    persistSettingGlobal('provider.gateway', {
      type: 'openai',
      apiKey: 'secret',
      models: { 'deepseek-chat': { label: 'DeepSeek' } },
    });
    const resolved = resolveSettings(dir);
    expect(resolved.provider.gateway.apiKey).toBe('secret');
  });

  it('removeProviderGlobal drops the provider and a global default that targets it', () => {
    persistSettingsGlobal({
      'provider.gateway': {
        type: 'openai',
        apiKey: 'secret',
        models: { m: { label: 'M' } },
      },
      model: 'gateway/m',
    });

    const result = removeProviderGlobal('gateway');
    expect(result).toEqual({
      ok: true,
      providerId: 'gateway',
      removedModelCount: 1,
      localDefaultCleared: true,
      localProviderExisted: true,
    });
    expect(readSettingsGlobal()).toEqual({});
  });

  it('removeProviderGlobal reports a missing provider against the global path', () => {
    const result = removeProviderGlobal('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('~/.book/settings.json');
  });

  it('clearLocalSettings removes a stale local model so the global default wins', () => {
    // Simulate a folder used before the change: a per-project model override.
    persistSettingLocal(dir, 'model', 'old/x');
    persistSettingGlobal('model', 'new/y');

    // Local shadows global for scalars — this is the pre-clear regression.
    expect(resolveSettings(dir).model).toBe('old/x');

    expect(clearLocalSettings(dir, ['model']).ok).toBe(true);

    // With the stale override gone, the folder inherits the global default.
    expect(resolveSettings(dir).model).toBe('new/y');
    expect(readSettingsLocal(dir).model).toBeUndefined();
  });

  it('clearLocalSettings prunes a stale local provider and empties its registry', () => {
    persistSettingsLocal(dir, {
      'provider.gateway': { type: 'openai', apiKey: 'old', models: { m: { label: 'M' } } },
      model: 'gateway/m',
    });
    persistSettingGlobal('provider.gateway', {
      type: 'openai',
      apiKey: 'new',
      models: { m: { label: 'M' } },
    });

    expect(clearLocalSettings(dir, ['provider.gateway', 'model']).ok).toBe(true);

    // The emptied provider registry is pruned, leaving no local overrides.
    expect(readSettingsLocal(dir)).toEqual({});
    expect((resolveSettings(dir).provider.gateway as { apiKey: string }).apiKey).toBe('new');
  });

  it('clearLocalSettings is a no-op when the local file is absent', () => {
    expect(clearLocalSettings(dir, ['model']).ok).toBe(true);
    expect(existsSync(join(dir, '.book', 'settings.local.json'))).toBe(false);
  });

  // #418. `/advisor off` removes the user layer's key and the local layer's, but a checked-in
  // `.book/settings.json` that declares an advisor then came back at the next launch: the loader
  // reads it as the project layer, and nothing the command wrote outranked it.
  describe('turnOffAdvisorModel', () => {
    const writeProject = (settings: Record<string, unknown>) => {
      mkdirSync(join(dir, '.book'), { recursive: true });
      writeFileSync(join(dir, '.book', 'settings.json'), JSON.stringify(settings));
    };
    const reload = () => {
      const saved = process.env.BOOK_ADVISOR_MODEL;
      delete process.env.BOOK_ADVISOR_MODEL;
      try {
        return configuredAdvisorModel(loadConfig(dir, { allowMissingApiKey: true }));
      } finally {
        if (saved !== undefined) process.env.BOOK_ADVISOR_MODEL = saved;
      }
    };

    it('leaves no advisor after a reload although the project settings declare one', () => {
      persistSettingGlobal('advisorModel', 'user/adv');
      writeProject({ advisorModel: 'project/adv' });
      expect(reload()).toBe('project/adv');

      expect(turnOffAdvisorModel(dir)).toEqual({ ok: true });

      expect(reload()).toBeUndefined();
      expect(readSettingsGlobal().advisorModel).toBeUndefined();
      // The checked-in file is the repository's: it is not edited.
      expect(JSON.parse(readFileSync(join(dir, '.book', 'settings.json'), 'utf-8'))).toEqual({
        advisorModel: 'project/adv',
      });
    });

    it('overrides an advisor the local layer declares too', () => {
      writeProject({ advisorModel: 'project/adv' });
      persistSettingLocal(dir, 'advisorModel', 'local/adv');

      expect(turnOffAdvisorModel(dir).ok).toBe(true);

      expect(reload()).toBeUndefined();
    });

    it('writes nothing to the workspace when no workspace layer declares an advisor', () => {
      persistSettingGlobal('advisorModel', 'user/adv');
      writeProject({ model: 'gpt-4o' });

      expect(turnOffAdvisorModel(dir).ok).toBe(true);

      expect(reload()).toBeUndefined();
      expect(existsSync(join(dir, '.book', 'settings.local.json'))).toBe(false);
    });

    it('is a plain removal for a workspace with no settings files at all', () => {
      persistSettingGlobal('advisorModel', 'user/adv');

      expect(turnOffAdvisorModel(dir).ok).toBe(true);

      expect(reload()).toBeUndefined();
      expect(existsSync(join(dir, '.book'))).toBe(false);
    });

    // Finding 9: the `off` it writes is not permanent.
    it("stops outranking the user's own advisor once the repository drops its declaration", () => {
      persistSettingGlobal('advisorModel', 'user/adv');
      writeProject({ advisorModel: 'project/adv' });
      expect(turnOffAdvisorModel(dir).ok).toBe(true);
      expect(readSettingsLocal(dir).advisorModel).toBe('off');
      expect(reload()).toBeUndefined();

      // The user sets their own advisor some way that does not clear the local layer.
      persistSettingGlobal('advisorModel', 'user/adv2');
      // Still off while the checked-in file declares one...
      expect(reload()).toBeUndefined();

      // ...and the user's value applies once it stops.
      writeProject({ model: 'gpt-4o' });
      expect(reload()).toBe('user/adv2');

      // Leave the shared user file as the sibling tests expect to find it.
      expect(turnOffAdvisorModel(dir).ok).toBe(true);
    });
  });
});

describe('readUserProvider', () => {
  let savedBookHome: string | undefined;
  beforeEach(() => {
    savedBookHome = process.env.BOOK_HOME;
    process.env.BOOK_HOME = join(dir, 'book-home');
  });
  afterEach(() => {
    if (savedBookHome === undefined) delete process.env.BOOK_HOME;
    else process.env.BOOK_HOME = savedBookHome;
  });

  it('reads the provider as the user file holds it, not as a workspace merged it', () => {
    persistSettingsGlobal({
      'provider.work': {
        type: 'openai',
        baseURL: 'https://user.example/v1',
        apiKey: 'k',
        models: { m: { label: 'M' } },
      },
    });
    mkdirSync(join(dir, '.book'), { recursive: true });
    writeFileSync(
      join(dir, '.book', 'settings.json'),
      JSON.stringify({ provider: { work: { type: 'anthropic', models: { extra: {} } } } }),
    );

    // The resolved provider carries the workspace's models; the user's entry does not.
    expect(Object.keys(resolveSettings(dir).provider.work.models).sort()).toEqual(['extra', 'm']);
    expect(readUserProvider('work')).toEqual({
      type: 'openai',
      baseURL: 'https://user.example/v1',
      apiKey: 'k',
      models: { m: { label: 'M' } },
    });
  });

  it('is undefined for an absent provider, an inherited property name and an invalid entry', () => {
    mkdirSync(join(dir, 'book-home'), { recursive: true });
    // Written directly: the repository would refuse to save a provider this invalid.
    writeFileSync(
      join(dir, 'book-home', 'settings.json'),
      JSON.stringify({ provider: { bad: { type: 'nope' }, ok: {} } }),
    );

    expect(readUserProvider('ok')).toEqual({ type: 'openai', models: {} });
    expect(readUserProvider('missing')).toBeUndefined();
    expect(readUserProvider('constructor')).toBeUndefined();
    expect(readUserProvider('bad')).toBeUndefined();
  });
});

// #514: a `/model` provider save used to delete the whole local `provider.<id>` entry, taking a
// hand-set per-model override (the guide promises "a `contextWindow` you set yourself always
// wins") with it. A save clears only the connection keys it supersedes.
describe('persistProviderSave (#514)', () => {
  const claude = 'claude-test-9';
  const selection = `anthro/${claude}`;
  let savedBookHome: string | undefined;
  beforeEach(() => {
    savedBookHome = process.env.BOOK_HOME;
    process.env.BOOK_HOME = join(dir, 'book-home');
  });
  afterEach(() => {
    if (savedBookHome === undefined) delete process.env.BOOK_HOME;
    else process.env.BOOK_HOME = savedBookHome;
  });

  const override = {
    contextWindow: 150_000,
    maxOutputTokens: 4096,
    vision: false,
    editFormat: 'whole',
    effort: false,
  };
  /** What the save writes to the user file: the catalog the endpoint just reported. */
  const savedProvider = () =>
    ({
      type: 'anthropic',
      baseURL: 'https://user.example',
      apiKey: 'user-key',
      models: { [claude]: { reportedContextWindow: 345_678 } },
    }) as const;
  const writeLocal = (document: Record<string, unknown>) => {
    mkdirSync(join(dir, '.book'), { recursive: true });
    writeFileSync(join(dir, '.book', 'settings.local.json'), JSON.stringify(document));
  };
  const seedLocal = () =>
    writeLocal({
      model: 'anthro/stale',
      provider: {
        anthro: {
          type: 'openai',
          baseURL: 'https://stale.example',
          baseUrl: 'https://stale-legacy.example',
          apiKey: 'stale-key',
          models: { [claude]: override },
        },
      },
    });
  const localProvider = () =>
    (readSettingsLocal(dir).provider as Record<string, Record<string, unknown>> | undefined)
      ?.anthro;
  /** The window a fresh launch resolves: loaded from the layers on disk, not the live config. */
  const freshWindow = () => {
    const config = loadConfig(dir, { allowMissingApiKey: true });
    return resolveContextWindow(resolveModelProviderConfig(config, selection));
  };

  it('keeps a per-model override through a refresh and clears the keys it supersedes', () => {
    seedLocal();

    expect(persistProviderSave(dir, 'anthro', savedProvider())).toEqual({ ok: true });

    expect(localProvider()).toEqual({ models: { [claude]: override } });
    // A refresh activates nothing, so the local `model` is not this save's to clear.
    expect(readSettingsLocal(dir).model).toBe('anthro/stale');
    expect(readSettingsGlobal().provider).toEqual({ anthro: savedProvider() });
    expect(freshWindow()).toEqual({ window: 150_000, source: 'declared' });
  });

  it('keeps a per-model override through an activating save and still clears local model', () => {
    seedLocal();

    expect(persistProviderSave(dir, 'anthro', savedProvider(), selection)).toEqual({ ok: true });

    expect(localProvider()).toEqual({ models: { [claude]: override } });
    expect(readSettingsLocal(dir).model).toBeUndefined();
    expect(readSettingsGlobal().model).toBe(selection);
    expect(freshWindow()).toEqual({ window: 150_000, source: 'declared' });
  });

  it('prunes a local entry that held only connection keys', () => {
    writeLocal({ provider: { anthro: { type: 'openai', baseURL: 'https://stale.example' } } });

    expect(persistProviderSave(dir, 'anthro', savedProvider())).toEqual({ ok: true });

    expect(readSettingsLocal(dir)).toEqual({});
  });

  it('leaves another provider and an absent local file alone', () => {
    writeLocal({ provider: { other: { baseURL: 'https://other.example' } } });
    expect(persistProviderSave(dir, 'anthro', savedProvider())).toEqual({ ok: true });
    expect(readSettingsLocal(dir)).toEqual({
      provider: { other: { baseURL: 'https://other.example' } },
    });

    rmSync(join(dir, '.book'), { recursive: true, force: true });
    expect(persistProviderSave(dir, 'anthro', savedProvider(), selection)).toEqual({ ok: true });
    expect(existsSync(join(dir, '.book', 'settings.local.json'))).toBe(false);
  });

  describe('liveProviderAfterSave', () => {
    it('keeps resolving the local override after an activating save, until restart too', () => {
      seedLocal();
      persistProviderSave(dir, 'anthro', savedProvider(), selection);

      const live = liveProviderAfterSave({ workspace: dir }, 'anthro', savedProvider());

      expect(live.models[claude]).toMatchObject({ ...override, reportedContextWindow: 345_678 });
      const config = defaultConfig({
        workspace: dir,
        settings: { ...defaultConfig().settings, provider: { anthro: live } },
      });
      expect(resolveContextWindow(resolveModelProviderConfig(config, selection))).toEqual({
        window: 150_000,
        source: 'declared',
      });
    });

    it('falls back to the saved provider when the layers cannot be read', () => {
      writeLocal({});
      writeFileSync(join(dir, '.book', 'settings.local.json'), '{ not json');

      expect(liveProviderAfterSave({ workspace: dir }, 'anthro', savedProvider())).toEqual(
        savedProvider(),
      );
    });

    it('is the saved provider under --no-settings', () => {
      seedLocal();

      expect(
        liveProviderAfterSave(
          { workspace: dir, settingsContext: { noSettings: true } },
          'anthro',
          savedProvider(),
        ),
      ).toEqual(savedProvider());
    });
  });
});
