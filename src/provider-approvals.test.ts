import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  droppedProviderOverrides,
  evaluateLegacyBaseUrl,
  legacyBaseUrlFingerprint,
  LEGACY_BASE_URL_ID,
  partitionWorkspaceProviders,
  persistWorkspaceProviderChoice,
  providerIdsOf,
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

  it('reports and removes the same keys', () => {
    expect(droppedProviderOverrides(workspaceLayers, trusted)).toEqual([
      { path: 'p', providerId: 'work', keys: ['baseURL', 'apiKey'] },
    ]);
    expect(withoutWorkspaceProviderOverrides(workspaceLayers[0].providers!, trusted)).toEqual({
      work: { type: 'anthropic', models: {} },
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
  it('names the provider and the command, and renders control characters inert', () => {
    const message = workspaceProviderRefusal('evil', 'evil/x');
    expect(message).toContain('declared by the workspace');
    expect(message).toContain('`book trust provider evil`');
    expect(workspaceProviderRefusal('e\u001b[2Jvil', 'e\u001b[2Jvil/x')).not.toContain('\u001b');
  });
});
