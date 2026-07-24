import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../types/runtime.js';
import type { ToolContext, ToolDefinition } from '../types/tools.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { createToolSurface } from './catalog.js';
import { createDefaultRegistry, createRegistry } from './registry.js';
import { toolSuccess } from './result.js';
import { SessionRuntime } from '../session/runtime.js';

function config(): AgentConfig {
  return {
    apiKey: 'test',
    baseUrl: 'http://localhost',
    model: 'test',
    maxTokens: 128_000,
    autoCompactEnabled: false,
    workspace: process.cwd(),
    animation: { typewriterSpeed: 0, spinnerStyle: 'dots' },
    accessibility: { screenReader: false, reducedMotion: false },
    settings: structuredClone(DEFAULT_SETTINGS),
    retry: {
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      totalBudgetMs: 0,
      requestTimeoutMs: 10_000,
      streamStallTimeoutMs: 10_000,
      toolRetries: 0,
      watchdog: false,
    },
  };
}

function definition(name: string, description = name): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
    execute: async () => toolSuccess('ok'),
  };
}

function context(): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    env: {},
    currentMode: 'default',
    backgroundShells: { nextId: 1, shells: new Map() },
  };
}

describe('tool surface discovery', () => {
  it('defers large catalogs and activates search matches on the next surface snapshot', () => {
    const definitions = [
      definition('Read'),
      ...Array.from({ length: 12 }, (_, index) =>
        definition(`SpecialTool${index}`, `Special capability ${index}`),
      ),
    ];
    const runtimeConfig = config();
    const runtimeContext = context();
    const surface = createToolSurface({
      config: runtimeConfig,
      context: runtimeContext,
      definitions,
    });

    const initial = surface.activeDefinitions().map((tool) => tool.name);
    expect(initial).toContain('ToolSearch');
    expect(initial).toContain('Read');
    expect(initial).not.toContain('SpecialTool3');

    const matches = surface.search('special capability 3');
    expect(matches[0]?.name).toBe('SpecialTool3');
    surface.activate([matches[0]!.name]);
    expect(surface.activeDefinitions().map((tool) => tool.name)).toContain('SpecialTool3');
  });

  it('keeps command argument rules in force for both visibility and execution', () => {
    const runtimeConfig = config();
    const runtimeContext = context();
    const surface = createToolSurface({
      config: runtimeConfig,
      context: runtimeContext,
      definitions: [
        {
          ...definition('Bash', 'Execute shell commands'),
          parameters: {
            type: 'object',
            properties: { command: { type: 'string', description: 'Command' } },
            required: ['command'],
          },
        },
      ],
      capabilityRules: ['Bash(git status*)'],
    });

    surface.activeDefinitions();
    expect(
      surface.canExecute({ id: '1', name: 'Bash', arguments: { command: 'git status --short' } }),
    ).toBe(true);
    expect(surface.canExecute({ id: '2', name: 'Bash', arguments: { command: 'git push' } })).toBe(
      false,
    );
  });

  it('does not expose child-only evidence tools to the root surface', () => {
    const runtimeConfig = config();
    const runtimeContext = context();
    const surface = createToolSurface({
      config: runtimeConfig,
      context: runtimeContext,
      definitions: [
        definition('EvidencePublish'),
        definition('EvidenceReview'),
        definition('Read'),
      ],
    });
    expect(surface.activeDefinitions().map((tool) => tool.name)).not.toContain('EvidencePublish');
    expect(surface.search('evidence publish')).toEqual([]);
  });

  it('intersects skill restrictions with the existing surface', () => {
    const runtimeConfig = config();
    const runtimeContext = context();
    const surface = createToolSurface({
      config: runtimeConfig,
      context: runtimeContext,
      definitions: [definition('Read'), definition('Bash')],
    });
    expect(surface.activeDefinitions().map((tool) => tool.name)).toContain('Bash');
    surface.restrict(['Read']);
    expect(surface.activeDefinitions().map((tool) => tool.name)).not.toContain('Bash');
  });

  it('canonicalizes model-facing names and infers catalog effects', () => {
    const registry = createRegistry();
    registry.register(definition('read_file', 'Read a file'));

    expect(registry.getDefinitions()[0]).toMatchObject({
      name: 'Read',
      catalog: { category: 'filesystem', effects: ['read'] },
    });
  });

  it('keeps ApplyPatch in the core filesystem/write surface', () => {
    const surface = createToolSurface({
      config: config(),
      context: context(),
      definitions: [definition('ApplyPatch')],
    });
    expect(surface.activeDefinitions().map((tool) => tool.name)).toContain('ApplyPatch');
    expect(surface.activeDefinitions()[0]?.catalog).toMatchObject({
      category: 'filesystem',
      exposure: 'core',
      effects: ['write'],
    });
  });

  it('retains higher-ranked activations when the loaded-tool cap is smaller than the match set', () => {
    const runtimeConfig = config();
    runtimeConfig.settings.toolDiscovery.mode = 'deferred';
    runtimeConfig.settings.toolDiscovery.maxLoadedTools = 1;
    const surface = createToolSurface({
      config: runtimeConfig,
      context: context(),
      definitions: [definition('Read'), definition('BestTool'), definition('SecondTool')],
    });

    expect(surface.activate(['BestTool', 'SecondTool'])).toEqual(['BestTool']);
    expect(surface.activeDefinitions().map((tool) => tool.name)).toContain('BestTool');
    expect(surface.activeDefinitions().map((tool) => tool.name)).not.toContain('SecondTool');
  });

  it('refreshes loaded-tool recency when an activated tool executes', () => {
    const runtimeConfig = config();
    runtimeConfig.settings.toolDiscovery.mode = 'deferred';
    runtimeConfig.settings.toolDiscovery.maxLoadedTools = 2;
    const surface = createToolSurface({
      config: runtimeConfig,
      context: context(),
      definitions: [
        definition('Read'),
        definition('FirstTool'),
        definition('SecondTool'),
        definition('ThirdTool'),
      ],
    });
    surface.activate(['FirstTool', 'SecondTool']);
    surface.activeDefinitions();
    expect(surface.canExecute({ id: 'second', name: 'SecondTool', arguments: {} })).toBe(true);

    surface.activate(['ThirdTool']);
    const active = surface.activeDefinitions().map((tool) => tool.name);
    expect(active).toContain('SecondTool');
    expect(active).toContain('ThirdTool');
    expect(active).not.toContain('FirstTool');
  });

  it('keeps smaller recent tools when an oversized schema cannot fit the budget', () => {
    const runtimeConfig = config();
    runtimeConfig.settings.toolDiscovery.mode = 'deferred';
    runtimeConfig.settings.toolDiscovery.schemaTokenBudget = 1_000;
    const huge = definition('HugeTool');
    huge.parameters = {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'x'.repeat(5_000) },
      },
    };
    const surface = createToolSurface({
      config: runtimeConfig,
      context: context(),
      definitions: [definition('Read'), huge, definition('SmallTool')],
    });

    expect(surface.activate(['HugeTool', 'SmallTool'])).toEqual(['SmallTool']);
    expect(surface.activeDefinitions().map((tool) => tool.name)).toContain('SmallTool');
  });

  it('does not evict an existing activation when a new schema cannot fit the budget', () => {
    const runtimeConfig = config();
    runtimeConfig.settings.toolDiscovery.mode = 'deferred';
    runtimeConfig.settings.toolDiscovery.maxLoadedTools = 1;
    runtimeConfig.settings.toolDiscovery.schemaTokenBudget = 1_000;
    const huge = definition('HugeTool');
    huge.parameters = {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'x'.repeat(5_000) },
      },
    };
    const surface = createToolSurface({
      config: runtimeConfig,
      context: context(),
      definitions: [definition('Read'), definition('SmallTool'), huge],
    });

    surface.activate(['SmallTool']);
    expect(surface.activate(['HugeTool'])).toEqual([]);
    expect(surface.activeDefinitions().map((tool) => tool.name)).toContain('SmallTool');
  });

  it('keeps session activations while a temporary capability surface hides them', () => {
    const runtimeConfig = config();
    const runtime = new SessionRuntime();
    runtimeConfig.settings.toolDiscovery.mode = 'deferred';
    const definitions = [definition('Read'), definition('SpecialTool')];
    const root = createToolSurface({
      config: runtimeConfig,
      context: { ...context(), runtime },
      definitions,
    });
    root.activate(['SpecialTool']);

    const restricted = createToolSurface({
      config: runtimeConfig,
      context: { ...context(), runtime },
      definitions,
      capabilityRules: ['Read'],
    });
    expect(restricted.activeDefinitions().map((tool) => tool.name)).not.toContain('SpecialTool');
    expect(runtime.toolDiscoveryState.loaded.has('SpecialTool')).toBe(true);

    const restored = createToolSurface({
      config: runtimeConfig,
      context: { ...context(), runtime },
      definitions,
    });
    expect(restored.activeDefinitions().map((tool) => tool.name)).toContain('SpecialTool');
  });

  it('keeps child discovery state isolated from root-session activations', () => {
    const runtimeConfig = config();
    const runtime = new SessionRuntime();
    runtimeConfig.settings.toolDiscovery.mode = 'deferred';
    const definitions = [
      definition('Read'),
      definition('AgentSpawn'),
      definition('EvidencePublish'),
    ];
    const root = createToolSurface({
      config: runtimeConfig,
      context: { ...context(), runtime },
      definitions,
    });
    root.activate(['AgentSpawn']);

    const child = createToolSurface({
      config: runtimeConfig,
      context: { ...context(), runtime },
      definitions,
      isSubagent: true,
    });
    child.activate(['EvidencePublish']);
    child.activeDefinitions();

    expect(root.activeDefinitions().map((tool) => tool.name)).toContain('AgentSpawn');
    expect(runtime.toolDiscoveryState.loaded.has('EvidencePublish')).toBe(false);
  });
});

describe('tool schema quality', () => {
  it('closes built-in schemas, describes properties, and hides host controls', () => {
    for (const definition of createDefaultRegistry().getDefinitions()) {
      const schema = definition.inputSchema!;
      expect(schema.additionalProperties, definition.name).toBe(false);
      for (const [propertyName, property] of Object.entries(schema.properties ?? {})) {
        expect(property.description?.trim(), `${definition.name}.${propertyName}`).toBeTruthy();
      }
      expect(schema.properties, definition.name).not.toHaveProperty('dangerouslyDisableSandbox');
      expect(schema.properties, definition.name).not.toHaveProperty('backend');
      expect(schema.properties, definition.name).not.toHaveProperty('timeout');
      expect(definition.catalog?.effects?.length, definition.name).toBeGreaterThan(0);
    }
  });

  it('keeps built-in dictionary fields open for dynamic metadata keys', async () => {
    const registry = createDefaultRegistry();
    const metadataSchema = registry.getTool('TaskCreate')?.inputSchema?.properties?.metadata;
    expect(metadataSchema?.additionalProperties).toBe(true);

    const result = await registry.execute(
      {
        id: 'task-metadata',
        name: 'TaskCreate',
        arguments: { subject: 'Document schemas', metadata: { priority: 'high' } },
      },
      context(),
    );
    expect(result.status).toBe('success');
  });
});
