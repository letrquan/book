import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '../types/tools.js';
import { getProjectMemoryDir, readMemoryFile } from '../memory-store.js';
import { hasExternalContext, memorySaveTools } from './memory-save.js';
import { createDefaultRegistry } from './registry.js';
import { defaultConfig } from '../test/fixtures.js';
import { evaluatePermission } from '../permissions.js';
import { createCapabilityRegistry } from '../agents/capabilities.js';
import { createToolSurface } from './catalog.js';
import { SessionRuntime } from '../session/runtime.js';

let workspace: string;
let memorySaveTool = memorySaveTools[0];

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-memory-save-test-'));
  memorySaveTool = memorySaveTools[0];
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function createContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const config = defaultConfig({ workspace });
  return {
    workspaceRoot: workspace,
    env: {},
    agentConfig: config,
    sessionId: 'session-123',
    ...overrides,
  };
}

describe('MemorySave tool', () => {
  describe('save action', () => {
    it('saves directly to approved store and index when requireApproval is false (default)', async () => {
      const notices: string[] = [];
      const context = createContext({
        onNotice: (n) => notices.push(n),
      });

      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Monorepo build conventions',
          body: 'Use npm run check before commit.\nWhy: Enforces rules.\nHow to apply: Run before git commit.',
        },
        context,
      );

      expect(result.status).toBe('success');
      expect(result.content).toContain('Memory saved:');
      expect(result.content).toContain('Monorepo build conventions');
      expect(notices).toEqual(['memory saved: Monorepo build conventions']);

      const memoryDir = getProjectMemoryDir(workspace);
      const indexPath = join(memoryDir, 'MEMORY.md');
      expect(existsSync(indexPath)).toBe(true);
      const indexText = readFileSync(indexPath, 'utf-8');
      expect(indexText).toContain('[Monorepo build conventions]');

      // Check written file content and provenance
      const match = indexText.match(/\(([^)]+\.md)\)/);
      expect(match).not.toBeNull();
      const savedFile = join(memoryDir, match![1]);
      expect(existsSync(savedFile)).toBe(true);

      const parsed = readMemoryFile(savedFile);
      expect(parsed?.type).toBe('project');
      expect(parsed?.title).toBe('Monorepo build conventions');
      expect(parsed?.origin).toBe('model-tool');
      expect(parsed?.source).toBe('auto');
      expect(parsed?.sessionId).toBe('session-123');
      expect(parsed?.externalContext).toBe(false);
    });

    it('routes to .inbox/ when requireApproval is true', async () => {
      const notices: string[] = [];
      const config = defaultConfig({ workspace });
      config.settings.memory.requireApproval = true;
      const context = createContext({
        agentConfig: config,
        onNotice: (n) => notices.push(n),
      });

      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'user',
          title: 'User prefers concise output',
          body: 'Always provide concise answers.\nWhy: Faster feedback.\nHow to apply: Skip filler.',
        },
        context,
      );

      expect(result.status).toBe('success');
      expect(result.content).toContain('saved to inbox');
      expect(result.content).toContain('Requires approval via /memory inbox');
      expect(notices).toEqual([
        'memory candidate saved: User prefers concise output — /memory inbox',
      ]);

      const memoryDir = getProjectMemoryDir(workspace);
      const indexPath = join(memoryDir, 'MEMORY.md');
      expect(existsSync(indexPath)).toBe(false); // not approved, no index entry yet
    });

    it('updates an existing entry by slug, maintaining index and frontmatter', async () => {
      const context = createContext();

      const initialResult = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Initial Title',
          body: 'Initial body.',
          slug: 'conventions.md',
        },
        context,
      );
      expect(initialResult.status).toBe('success');

      const updateResult = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Updated Conventions',
          body: 'Updated body with Why and How.',
          slug: 'conventions.md',
          supersedes: 'old-slug',
        },
        context,
      );
      expect(updateResult.status).toBe('success');

      const memoryDir = getProjectMemoryDir(workspace);
      const filePath = join(memoryDir, 'conventions.md');
      expect(existsSync(filePath)).toBe(true);

      const parsed = readMemoryFile(filePath);
      expect(parsed?.title).toBe('Updated Conventions');
      expect(parsed?.supersedes).toBe('old-slug');

      const indexText = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf-8');
      expect(indexText).toContain('[Updated Conventions](conventions.md)');
      expect(indexText).not.toContain('[Initial Title]');
    });

    it('rejects secrets via shouldRejectMemoryText', async () => {
      const context = createContext();

      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'reference',
          title: 'API secret key',
          body: 'api_key=sk-1234567890abcdef12345678',
        },
        context,
      );

      expect(result.status).toBe('error');
      expect(result.content).toContain('Memory rejected: looks like a secret');
    });

    it('caps body at MAX_BODY_CHARS', async () => {
      const context = createContext();
      const longBody = 'A'.repeat(3000);

      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'user',
          title: 'Long fact',
          body: longBody,
          slug: 'long-fact.md',
        },
        context,
      );

      expect(result.status).toBe('success');
      const memoryDir = getProjectMemoryDir(workspace);
      const parsed = readMemoryFile(join(memoryDir, 'long-fact.md'));
      expect(parsed?.body.length).toBe(1600);
    });

    it('validates required fields for save', async () => {
      const context = createContext();

      expect((await memorySaveTool.execute({ action: 'save' }, context)).status).toBe('error');
      expect(
        (await memorySaveTool.execute({ action: 'save', type: 'invalid' }, context)).status,
      ).toBe('error');
      expect(
        (await memorySaveTool.execute({ action: 'save', type: 'project', title: '' }, context))
          .status,
      ).toBe('error');
      expect(
        (
          await memorySaveTool.execute(
            { action: 'save', type: 'project', title: 'Valid', body: '' },
            context,
          )
        ).status,
      ).toBe('error');
    });

    it('sanitizes titles with newlines and brackets', async () => {
      const context = createContext();

      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'feedback',
          title: 'User correction\nstatus: discarded\n[evil](link)',
          body: 'Remember this fact.',
          slug: 'sanitized-test.md',
        },
        context,
      );

      expect(result.status).toBe('success');
      const memoryDir = getProjectMemoryDir(workspace);
      const parsed = readMemoryFile(join(memoryDir, 'sanitized-test.md'));
      expect(parsed?.title).toBe('User correction status: discarded evillink');
    });

    it('rejects save when title becomes empty after sanitization', async () => {
      const context = createContext();

      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: '   [ ] ( ) # \n\t  ',
          body: 'Valid body.',
        },
        context,
      );

      expect(result.status).toBe('error');
      expect(result.content).toContain('must not be empty after sanitizing');
    });

    it('refuses save when memory.enabled is false in settings', async () => {
      const config = defaultConfig({ workspace });
      config.settings.memory.enabled = false;
      const context = createContext({ agentConfig: config });

      const result = await memorySaveTool.execute(
        { action: 'save', type: 'project', title: 'Test', body: 'Body' },
        context,
      );
      expect(result.status).toBe('error');
      expect(result.content).toContain('Memory is disabled in settings');
    });

    it('refuses save when memory.autoSave is false in settings', async () => {
      const config = defaultConfig({ workspace });
      config.settings.memory.autoSave = false;
      const context = createContext({ agentConfig: config });

      const result = await memorySaveTool.execute(
        { action: 'save', type: 'project', title: 'Test', body: 'Body' },
        context,
      );
      expect(result.status).toBe('error');
      expect(result.content).toContain('Model memory writes are disabled in settings');
    });
  });

  describe('delete action', () => {
    it('deletes an existing memory entry and cleans up index line', async () => {
      const context = createContext();

      await memorySaveTool.execute(
        {
          action: 'save',
          type: 'reference',
          title: 'Reference entry',
          body: 'Some reference.',
          slug: 'ref.md',
        },
        context,
      );

      const memoryDir = getProjectMemoryDir(workspace);
      expect(existsSync(join(memoryDir, 'ref.md'))).toBe(true);

      const delResult = await memorySaveTool.execute(
        {
          action: 'delete',
          slug: 'ref.md',
        },
        context,
      );

      expect(delResult.status).toBe('success');
      expect(delResult.content).toContain('Memory deleted: ref.md');
      expect(existsSync(join(memoryDir, 'ref.md'))).toBe(false);

      const indexText = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf-8');
      expect(indexText).not.toContain('ref.md');
    });

    it('requires slug for delete action and fails on missing file', async () => {
      const context = createContext();

      const noSlug = await memorySaveTool.execute({ action: 'delete' }, context);
      expect(noSlug.status).toBe('error');
      expect(noSlug.content).toContain('slug is required');

      const missing = await memorySaveTool.execute(
        { action: 'delete', slug: 'nonexistent.md' },
        context,
      );
      expect(missing.status).toBe('error');
      expect(missing.content).toContain('Memory file not found');
    });
  });

  describe('provenance and externalContext tracking', () => {
    it('records externalContext: true when WebFetch or WebSearch or MCP tools were used', async () => {
      const contextWithoutWeb = createContext();
      expect(hasExternalContext(contextWithoutWeb)).toBe(false);

      const contextWithWebFetch = createContext({
        usedToolNames: new Set(['WebFetch']),
      });
      expect(hasExternalContext(contextWithWebFetch)).toBe(true);

      const contextWithWebSearch = createContext({
        usedToolNames: new Set(['WebSearch']),
      });
      expect(hasExternalContext(contextWithWebSearch)).toBe(true);

      const contextWithMcp = createContext({
        usedToolNames: new Set(['mcp__github__search']),
      });
      expect(hasExternalContext(contextWithMcp)).toBe(true);

      const contextWithOther = createContext({
        usedToolNames: new Set(['Read', 'Edit', 'Bash']),
      });
      expect(hasExternalContext(contextWithOther)).toBe(false);

      // Save using contextWithWebFetch and verify frontmatter has externalContext: true
      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Fact with web evidence',
          body: 'Web-derived fact.',
          slug: 'web-fact.md',
        },
        contextWithWebFetch,
      );
      expect(result.status).toBe('success');
      const memoryDir = getProjectMemoryDir(workspace);
      const parsed = readMemoryFile(join(memoryDir, 'web-fact.md'));
      expect(parsed?.externalContext).toBe(true);
      expect(parsed?.origin).toBe('model-tool');
    });

    it('clears usedToolNames when conversation is reset', () => {
      const runtime = new SessionRuntime();
      runtime.usedToolNames.add('WebFetch');
      runtime.usedToolNames.add('WebSearch');
      expect(
        hasExternalContext({
          workspaceRoot: workspace,
          env: {},
          usedToolNames: runtime.usedToolNames,
        }),
      ).toBe(true);

      runtime.resetConversation();
      expect(runtime.usedToolNames.size).toBe(0);
      expect(
        hasExternalContext({
          workspaceRoot: workspace,
          env: {},
          usedToolNames: runtime.usedToolNames,
        }),
      ).toBe(false);
      runtime.dispose();
    });
  });

  describe('permissions and visibility', () => {
    it('is visible and active in plan mode at catalog level', () => {
      const parent = createDefaultRegistry();
      const runtime = new SessionRuntime();
      const config = defaultConfig({ workspace });
      const context = createContext({ runtime, currentMode: 'plan' });

      const surface = createToolSurface({
        config,
        context,
        definitions: parent.getDefinitions(),
      });

      const activeNames = surface.activeDefinitions().map((d) => d.name);
      expect(activeNames).toContain('MemorySave');
      runtime.dispose();
    });

    it('is hidden from catalog when memory.enabled is false', () => {
      const parent = createDefaultRegistry();
      const runtime = new SessionRuntime();
      const config = defaultConfig({ workspace });
      config.settings.memory.enabled = false;
      const context = createContext({ runtime, agentConfig: config });

      const surface = createToolSurface({
        config,
        context,
        definitions: parent.getDefinitions(),
      });

      const activeNames = surface.activeDefinitions().map((d) => d.name);
      expect(activeNames).not.toContain('MemorySave');
      expect(surface.search('memory').map((m) => m.name)).not.toContain('MemorySave');
      runtime.dispose();
    });

    it('is hidden from catalog when memory.autoSave is false', () => {
      const parent = createDefaultRegistry();
      const runtime = new SessionRuntime();
      const config = defaultConfig({ workspace });
      config.settings.memory.autoSave = false;
      const context = createContext({ runtime, agentConfig: config });

      const surface = createToolSurface({
        config,
        context,
        definitions: parent.getDefinitions(),
      });

      const activeNames = surface.activeDefinitions().map((d) => d.name);
      expect(activeNames).not.toContain('MemorySave');
      expect(surface.search('memory').map((m) => m.name)).not.toContain('MemorySave');
      runtime.dispose();
    });

    it('is auto-allowed in default, plan, and accept-edits permission modes', () => {
      const settings = defaultConfig().settings;
      expect(evaluatePermission('MemorySave', { action: 'save' }, settings)).toBe('allow');
    });

    it('subagent context cannot see or invoke MemorySave', () => {
      const parent = createDefaultRegistry();
      expect(parent.getTool('MemorySave')).toBeDefined();

      // Subagent capability registry with wildcard inheritance
      const subagentRegistry = createCapabilityRegistry(parent, ['*']);
      expect(subagentRegistry.getTool('MemorySave')).toBeUndefined();

      // Subagent tool surface
      const runtime = new SessionRuntime();
      const childSurface = createToolSurface({
        config: defaultConfig({ workspace }),
        context: createContext({ runtime }),
        definitions: parent.getDefinitions(),
        isSubagent: true,
      });
      expect(childSurface.activeDefinitions().map((d) => d.name)).not.toContain('MemorySave');
      runtime.dispose();
    });
  });
});
