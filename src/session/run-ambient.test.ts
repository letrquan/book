import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { discoverSkills } from '../skills.js';
import { createRegistry } from '../tools/registry.js';
import { toolSuccess } from '../tools/result.js';
import type { ToolDefinition } from '../types/tools.js';
import { createRunAmbientSnapshot } from './run-ambient.js';

const temporaryRoots: string[] = [];

function tool(name: string, description = `${name} description`): ToolDefinition {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    execute: async () => toolSuccess('ok'),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createRunAmbientSnapshot', () => {
  it('creates a stable fingerprint independent of tool registration order and capture time', () => {
    const firstRegistry = createRegistry();
    firstRegistry.registerAll([tool('Beta'), tool('Alpha')]);
    const secondRegistry = createRegistry();
    secondRegistry.registerAll([tool('Alpha'), tool('Beta')]);

    const first = createRunAmbientSnapshot(defaultConfig(), firstRegistry, 10);
    const second = createRunAmbientSnapshot(defaultConfig(), secondRegistry, { capturedAt: 20 });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.capturedAt).toBe(10);
    expect(second.capturedAt).toBe(20);
    expect(first.tools.names).toEqual(['Alpha', 'Beta']);
  });

  it('changes when the effective tool contract or managed-agent mode changes', () => {
    const baselineRegistry = createRegistry();
    baselineRegistry.register(tool('ReadLike'));
    const changedRegistry = createRegistry();
    changedRegistry.register(tool('ReadLike', 'Changed provider-facing description'));
    const baselineConfig = defaultConfig();
    const changedConfig = defaultConfig();
    changedConfig.settings.agents.mode = 'off';

    const baseline = createRunAmbientSnapshot(baselineConfig, baselineRegistry, { capturedAt: 1 });
    const changedTool = createRunAmbientSnapshot(baselineConfig, changedRegistry, {
      capturedAt: 1,
    });
    const changedMode = createRunAmbientSnapshot(changedConfig, baselineRegistry, {
      capturedAt: 1,
    });

    expect(changedTool.tools.fingerprint).not.toBe(baseline.tools.fingerprint);
    expect(changedTool.fingerprint).not.toBe(baseline.fingerprint);
    expect(changedMode.settings.agentsMode).toBe('off');
    expect(changedMode.fingerprint).not.toBe(baseline.fingerprint);
  });

  it('changes when the resolved initial permission mode changes', () => {
    const registry = createRegistry();
    const config = defaultConfig();

    const defaultMode = createRunAmbientSnapshot(config, registry, {
      capturedAt: 1,
      permissionMode: 'default',
    });
    const planMode = createRunAmbientSnapshot(config, registry, {
      capturedAt: 1,
      permissionMode: 'plan',
    });

    expect(defaultMode.policies.permissionMode).toBe('default');
    expect(planMode.policies.permissionMode).toBe('plan');
    expect(planMode.fingerprint).not.toBe(defaultMode.fingerprint);
  });

  it('redacts credential values and declares inputs that are not frozen yet', () => {
    const registry = createRegistry();
    const firstConfig = defaultConfig({ apiKey: 'first-secret' });
    const secondConfig = defaultConfig({ apiKey: 'second-secret' });
    firstConfig.settings.provider.gateway = {
      type: 'openai',
      apiKey: 'settings-secret-one',
      models: {},
    };
    secondConfig.settings.provider.gateway = {
      type: 'openai',
      apiKey: 'settings-secret-two',
      models: {},
    };

    const first = createRunAmbientSnapshot(firstConfig, registry, { capturedAt: 1 });
    const second = createRunAmbientSnapshot(secondConfig, registry, { capturedAt: 1 });
    const serialized = JSON.stringify(first);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(serialized).not.toContain('first-secret');
    expect(serialized).not.toContain('settings-secret-one');
    expect(first).toMatchObject({
      schemaVersion: 2,
      completeness: 'partial',
      bookHome: { isolation: 'shared' },
      missingSources: expect.arrayContaining([
        'clock_control',
        'book_home_isolation',
        'random_seed',
      ]),
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.tools.names)).toBe(true);
  });

  it('attributes an explicit BOOK_HOME without claiming content isolation', () => {
    const registry = createRegistry();
    vi.stubEnv('BOOK_HOME', './isolated-book-home');

    const snapshot = createRunAmbientSnapshot(defaultConfig(), registry, { capturedAt: 1 });

    expect(snapshot.bookHome.isolation).toBe('configured');
    expect(snapshot.bookHome.contentsStatus).toBe('not-captured');
    expect(snapshot.missingSources).toContain('book_home_isolation');
    expect(snapshot.missingSources).toContain('book_home_contents');
    expect(snapshot.completeness).toBe('partial');
  });

  it('captures a stable, secret-safe content identity for disposable evaluation Book home', () => {
    const root = mkdtempSync(join(tmpdir(), 'book-run-ambient-'));
    temporaryRoots.push(root);
    const bookHome = join(root, 'book-home');
    mkdirSync(bookHome);
    writeFileSync(join(bookHome, 'settings.json'), '{"apiKey":"first-secret"}', 'utf8');
    vi.stubEnv('BOOK_HOME', bookHome);
    vi.stubEnv('BOOK_EVALUATION_RUN_ID', 'evaluation-run');
    const registry = createRegistry();

    const first = createRunAmbientSnapshot(defaultConfig(), registry, { capturedAt: 1 });
    const repeated = createRunAmbientSnapshot(defaultConfig(), registry, { capturedAt: 2 });
    writeFileSync(join(bookHome, 'settings.json'), '{"apiKey":"other-secret"}', 'utf8');
    const changed = createRunAmbientSnapshot(defaultConfig(), registry, { capturedAt: 1 });

    expect(first.bookHome).toMatchObject({
      isolation: 'isolated',
      contentsStatus: 'captured',
      fileCount: 1,
      totalBytes: 25,
    });
    expect(first.bookHome.contentsFingerprint).toBe(repeated.bookHome.contentsFingerprint);
    expect(first.fingerprint).toBe(repeated.fingerprint);
    expect(changed.bookHome.contentsFingerprint).not.toBe(first.bookHome.contentsFingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(first.missingSources).not.toContain('book_home_isolation');
    expect(first.missingSources).not.toContain('book_home_contents');
    expect(JSON.stringify(first)).not.toContain('first-secret');
    expect(JSON.stringify(first)).not.toContain('settings.json');
  });

  it('is complete for a controlled isolated single-agent evaluation', () => {
    const root = mkdtempSync(join(tmpdir(), 'book-run-ambient-complete-'));
    temporaryRoots.push(root);
    const bookHome = join(root, 'book-home');
    const workspace = join(root, 'workspace');
    mkdirSync(bookHome);
    mkdirSync(workspace);
    vi.stubEnv('BOOK_HOME', bookHome);
    vi.stubEnv('BOOK_EVALUATION_RUN_ID', 'evaluation-run');
    vi.stubEnv('BOOK_EVALUATION_DATE', '2030-02-03');
    vi.stubEnv('BOOK_EVALUATION_RANDOM_SEED', 'case-1-attempt-1');
    vi.stubEnv('BOOK_EVALUATION_RUNTIME_REVISION', 'runtime-revision-1');
    vi.stubEnv('BOOK_EVALUATION_FIXTURE_REVISION', 'fixture-revision-1');
    const config = defaultConfig({ workspace });
    config.settings.agents.mode = 'off';
    config.settings.skills.enabled = false;

    const snapshot = createRunAmbientSnapshot(config, createRegistry(), { capturedAt: 1 });

    expect(snapshot).toMatchObject({
      completeness: 'complete',
      missingSources: [],
      bookHome: { isolation: 'isolated', contentsStatus: 'captured' },
      tools: { activationState: 'fresh' },
      skills: { activationState: 'disabled' },
      agents: { mode: 'off' },
      runtime: {
        runtimeRevision: 'runtime-revision-1',
        fixtureRevision: 'fixture-revision-1',
        randomSeed: 'case-1-attempt-1',
      },
    });
  });

  it('normalizes evaluator-owned run IDs and disposable paths across equivalent arms', () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'book-run-ambient-arm-a-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'book-run-ambient-arm-b-'));
    temporaryRoots.push(firstRoot, secondRoot);
    const firstBookHome = join(firstRoot, 'book-home');
    const secondBookHome = join(secondRoot, 'book-home');
    const firstWorkspace = join(firstRoot, 'workspace');
    const secondWorkspace = join(secondRoot, 'workspace');
    for (const directory of [firstBookHome, secondBookHome, firstWorkspace, secondWorkspace]) {
      mkdirSync(directory);
    }
    for (const bookHome of [firstBookHome, secondBookHome]) {
      writeFileSync(join(bookHome, 'settings.json'), '{"model":"evaluation/model"}', 'utf8');
    }
    for (const workspace of [firstWorkspace, secondWorkspace]) {
      const commandRoot = join(workspace, '.book', 'commands');
      const skillRoot = join(workspace, '.book', 'skills', 'review');
      mkdirSync(commandRoot, { recursive: true });
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(
        join(commandRoot, 'review.md'),
        ['---', 'description: Review changes', '---', 'Review the current diff.'].join('\n'),
        'utf8',
      );
      writeFileSync(
        join(skillRoot, 'SKILL.md'),
        ['---', 'name: review', 'description: Review changes', '---', 'Review carefully.'].join(
          '\n',
        ),
        'utf8',
      );
    }
    const registry = createRegistry();
    const firstConfig = defaultConfig({ workspace: firstWorkspace });
    const secondConfig = defaultConfig({ workspace: secondWorkspace });

    vi.stubEnv('BOOK_HOME', firstBookHome);
    vi.stubEnv('BOOK_EVALUATION_RUN_ID', 'run-a');
    const first = createRunAmbientSnapshot(firstConfig, registry, { capturedAt: 1 });
    vi.stubEnv('BOOK_HOME', secondBookHome);
    vi.stubEnv('BOOK_EVALUATION_RUN_ID', 'run-b');
    const second = createRunAmbientSnapshot(secondConfig, registry, { capturedAt: 2 });

    expect(first.bookHome.contentsFingerprint).toBe(second.bookHome.contentsFingerprint);
    expect(first.runtime.workspaceFingerprint).toBe(second.runtime.workspaceFingerprint);
    expect(first.bookHome.pathFingerprint).toBe(second.bookHome.pathFingerprint);
    expect(first.commands).toEqual(second.commands);
    expect(first.skills).toEqual(second.skills);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.missingSources).not.toContain('command_registry');
    expect(first.missingSources).not.toContain('skill_registry');
  });

  it('invalidates command and skill fingerprints without retaining their bodies', () => {
    const root = mkdtempSync(join(tmpdir(), 'book-run-ambient-capabilities-'));
    temporaryRoots.push(root);
    const bookHome = join(root, 'book-home');
    const workspace = join(root, 'workspace');
    const commandRoot = join(workspace, '.book', 'commands');
    const skillRoot = join(workspace, '.book', 'skills', 'review');
    mkdirSync(bookHome);
    mkdirSync(commandRoot, { recursive: true });
    mkdirSync(skillRoot, { recursive: true });
    const commandPath = join(commandRoot, 'review.md');
    const skillPath = join(skillRoot, 'SKILL.md');
    writeFileSync(
      commandPath,
      ['---', 'description: Review changes', '---', 'command-secret-one'].join('\n'),
      'utf8',
    );
    writeFileSync(
      skillPath,
      ['---', 'name: review', 'description: Review changes', '---', 'skill-secret-one'].join('\n'),
      'utf8',
    );
    vi.stubEnv('BOOK_HOME', bookHome);
    vi.stubEnv('BOOK_EVALUATION_RUN_ID', 'evaluation-run');
    const config = defaultConfig({ workspace });

    const first = createRunAmbientSnapshot(config, createRegistry(), {
      capturedAt: 1,
      skills: discoverSkills(workspace, {}, { includeUser: false, projectRoot: workspace }),
    });
    writeFileSync(
      commandPath,
      ['---', 'description: Review changes', '---', 'command-secret-two'].join('\n'),
      'utf8',
    );
    writeFileSync(
      skillPath,
      ['---', 'name: review', 'description: Review changes', '---', 'skill-secret-two'].join('\n'),
      'utf8',
    );
    const changed = createRunAmbientSnapshot(config, createRegistry(), {
      capturedAt: 1,
      skills: discoverSkills(workspace, {}, { includeUser: false, projectRoot: workspace }),
    });

    expect(first.commands).toMatchObject({ count: 1, names: ['review'] });
    expect(first.skills).toMatchObject({ count: 1, names: ['review'] });
    expect(changed.commands.fingerprint).not.toBe(first.commands.fingerprint);
    expect(changed.skills.fingerprint).not.toBe(first.skills.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(JSON.stringify(first)).not.toContain('command-secret-one');
    expect(JSON.stringify(first)).not.toContain('skill-secret-one');
  });

  it('keeps Book-home contents explicitly incomplete when the bounded capture is exceeded', () => {
    const root = mkdtempSync(join(tmpdir(), 'book-run-ambient-limits-'));
    temporaryRoots.push(root);
    const bookHome = join(root, 'book-home');
    mkdirSync(bookHome);
    writeFileSync(join(bookHome, 'settings.json'), Buffer.alloc(2 * 1024 * 1024, 1));
    vi.stubEnv('BOOK_HOME', bookHome);
    vi.stubEnv('BOOK_EVALUATION_RUN_ID', 'evaluation-run');

    const snapshot = createRunAmbientSnapshot(defaultConfig(), createRegistry(), {
      capturedAt: 1,
      bookHomeCaptureLimits: { maxFiles: 1, maxBytes: 1024 },
    });

    expect(snapshot.bookHome).toMatchObject({
      isolation: 'isolated',
      contentsStatus: 'incomplete',
      fileCount: 0,
      totalBytes: 0,
    });
    expect(snapshot.missingSources).not.toContain('book_home_isolation');
    expect(snapshot.missingSources).toContain('book_home_contents');
  });
});
