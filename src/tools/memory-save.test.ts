import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '../types/tools.js';
import type { Message } from '../types/messages.js';
import {
  getMemoryInboxDir,
  getProjectMemoryDir,
  listMemoryCandidates,
  readMemoryFile,
} from '../memory-store.js';
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

// Memory writes resolve under BOOK_HOME; pin it so this suite never touches the developer's
// ~/.book (vitest-setup leaves it unpinned on purpose — suites that write there pin their own).
let pinnedBookHome: string;
const previousBookHome = process.env.BOOK_HOME;
beforeEach(() => {
  pinnedBookHome = mkdtempSync(join(tmpdir(), 'book-home-test-'));
  process.env.BOOK_HOME = pinnedBookHome;
});
afterEach(() => {
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
  rmSync(pinnedBookHome, { recursive: true, force: true });
});

describe('MemorySave tool', () => {
  describe('save action', () => {
    it('asks the model to consolidate as the index nears its load limit', async () => {
      const memoryDir = getProjectMemoryDir(workspace);
      mkdirSync(memoryDir, { recursive: true });
      // Free-form lines: entries linking to missing files would be pruned on the write.
      const filler = Array.from({ length: 165 }, (_, i) => `- note ${i}`);
      writeFileSync(join(memoryDir, 'MEMORY.md'), ['# Book memory index', ...filler].join('\n'));
      const near = await memorySaveTool.execute(
        { action: 'save', type: 'project', title: 'One more', body: 'A fact.' },
        createContext(),
      );
      expect(near.content).toContain('Consolidate soon');

      const over = Array.from({ length: 205 }, (_, i) => `- note ${i}`);
      writeFileSync(join(memoryDir, 'MEMORY.md'), ['# Book memory index', ...over].join('\n'));
      const past = await memorySaveTool.execute(
        { action: 'save', type: 'project', title: 'Yet another', body: 'A fact.' },
        createContext(),
      );
      expect(past.content).toContain('only the first 200 load');
    });

    it('supersedes an existing entry when asked', async () => {
      await memorySaveTool.execute(
        { action: 'save', type: 'project', title: 'Old rule', body: 'Use tabs.', slug: 'style' },
        createContext(),
      );
      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'New rule',
          body: 'Use spaces.',
          supersedes: 'style',
        },
        createContext(),
      );
      expect(result.status).toBe('success');
      expect(result.content).toContain('Retired style.md');
      const memoryDir = getProjectMemoryDir(workspace);
      expect(readFileSync(join(memoryDir, 'style.md'), 'utf-8')).toContain('status: superseded');
      expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf-8')).not.toContain('style.md');
    });

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
      expect(result.data).toMatchObject({ memorySaved: true, action: 'save' });
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
      expect(result.data).toMatchObject({
        memorySaved: true,
        action: 'save',
        status: 'pending',
      });
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
        },
        context,
      );
      expect(updateResult.status).toBe('success');

      const memoryDir = getProjectMemoryDir(workspace);
      const filePath = join(memoryDir, 'conventions.md');
      expect(existsSync(filePath)).toBe(true);

      const parsed = readMemoryFile(filePath);
      expect(parsed?.title).toBe('Updated Conventions');

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

    it('rejects body exceeding MAX_BODY_CHARS with limit and received length', async () => {
      const context = createContext();
      const longBody = 'A'.repeat(2000);

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

      expect(result.status).toBe('error');
      expect(result.content).toContain(
        'body exceeds maximum length of 1600 characters (received 2000)',
      );
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

    it('sanitizes a slug before it reaches the file name', async () => {
      const context = createContext();

      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Payload test',
          body: 'Content.',
          slug: 'safe-slug.md\nstatus: discarded',
        },
        context,
      );

      expect(result.status).toBe('success');
      const memoryDir = getProjectMemoryDir(workspace);
      const parsed = readMemoryFile(join(memoryDir, 'safe-slug.mdstatus: discarded.md'));
      expect(parsed?.status).toBe('approved');
    });

    it('updates the existing file when the slug names it through a path', async () => {
      const context = createContext();
      const memoryDir = getProjectMemoryDir(workspace);

      await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Build command',
          body: 'Use npm run build.',
          slug: 'build-cmd.md',
        },
        context,
      );

      const updated = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Build command',
          body: 'Use npm run build --production.',
          slug: 'memory/build-cmd.md',
        },
        context,
      );

      expect(updated.status).toBe('success');
      const files = readdirSync(memoryDir).filter((name) => name.endsWith('.md'));
      expect(files).toEqual(expect.arrayContaining(['build-cmd.md', 'MEMORY.md']));
      expect(files).toHaveLength(2);
    });

    it('treats a whitespace-only slug as absent rather than failing', async () => {
      const context = createContext();

      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Valid title',
          body: 'Valid body.',
          slug: '\r\n\t',
        },
        context,
      );

      expect(result.status).toBe('success');
      expect(result.data).toMatchObject({ action: 'save', status: 'approved' });
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
      expect(result.content).toContain('Model memory writes are disabled in settings');
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
    it('deletes an existing memory entry, emits notice, and reports the slug', async () => {
      const notices: string[] = [];
      const context = createContext({
        onNotice: (n) => notices.push(n),
      });

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

      notices.length = 0;
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
      expect(delResult.data).toEqual({ action: 'delete', slug: 'ref.md' });
      expect(notices).toEqual(['memory deleted: ref.md']);
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

    it('refuses delete when session has external context and quarantineExternal is true', async () => {
      const context = createContext({
        usedToolNames: new Set(['WebFetch']),
      });

      const result = await memorySaveTool.execute({ action: 'delete', slug: 'ref.md' }, context);

      expect(result.status).toBe('error');
      expect(result.content).toBe(
        'this session read external content; deletion needs the user — ask them to run /memory delete',
      );
    });

    it('refuses delete when requireApproval is true even without external context', async () => {
      const config = defaultConfig({ workspace });
      config.settings.memory.requireApproval = true;
      const context = createContext({
        agentConfig: config,
        usedToolNames: new Set(['Read']),
      });

      const result = await memorySaveTool.execute({ action: 'delete', slug: 'ref.md' }, context);

      expect(result.status).toBe('error');
      expect(result.content).toBe(
        'memory.requireApproval is on; deletion needs the user — ask them to run /memory delete',
      );
    });

    it('allows updating and deleting mixed-case slug files', async () => {
      const context = createContext();

      const saveResult = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Mixed Case Fact',
          body: 'Body.',
          slug: 'MixedCaseFile.md',
        },
        context,
      );
      expect(saveResult.status).toBe('success');
      const memoryDir = getProjectMemoryDir(workspace);
      expect(existsSync(join(memoryDir, 'MixedCaseFile.md'))).toBe(true);

      const updateResult = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Updated Mixed Case Fact',
          body: 'Updated body.',
          slug: 'MixedCaseFile.md',
        },
        context,
      );
      expect(updateResult.status).toBe('success');

      const delResult = await memorySaveTool.execute(
        {
          action: 'delete',
          slug: 'MixedCaseFile.md',
        },
        context,
      );
      expect(delResult.status).toBe('success');
      expect(existsSync(join(memoryDir, 'MixedCaseFile.md'))).toBe(false);
    });
  });

  describe('provenance and externalContext tracking', () => {
    const resumedHistory: Message[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'fetch something',
        includeInContext: true,
        timestamp: 1000,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        includeInContext: true,
        timestamp: 2000,
        toolCalls: [{ id: 'call-web', name: 'WebFetch', arguments: { url: 'https://e.com' } }],
        toolResults: [
          { version: 2, toolCallId: 'call-web', status: 'success', content: 'page text' },
        ],
      },
    ];

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

      const notices: string[] = [];
      const contextWithWebFetchAndNotice = createContext({
        usedToolNames: new Set(['WebFetch']),
        onNotice: (n) => notices.push(n),
      });

      // Save using contextWithWebFetch and verify it quarantines to inbox with explicit notice
      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Fact with web evidence',
          body: 'Web-derived fact.',
          slug: 'web-fact.md',
        },
        contextWithWebFetchAndNotice,
      );
      expect(result.status).toBe('success');
      expect(result.content).toContain(
        'Memory candidate saved to inbox (this session read external content)',
      );
      expect(result.data).toMatchObject({
        action: 'save',
        status: 'pending',
        quarantined: true,
      });
      expect(notices).toEqual([
        'memory candidate saved (this session read external content): Fact with web evidence — /memory inbox',
      ]);

      const inboxDir = getMemoryInboxDir(workspace);
      const candidates = listMemoryCandidates(workspace);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].path.startsWith(inboxDir)).toBe(true);
      const parsed = readMemoryFile(candidates[0].path);
      expect(parsed?.externalContext).toBe(true);
      expect(parsed?.origin).toBe('model-tool');
      expect(parsed?.targetSlug).toBe('web-fact.md');
    });

    it('saves directly to approved store when quarantineExternal is false even with external context', async () => {
      const config = defaultConfig({ workspace });
      config.settings.memory.quarantineExternal = false;
      const context = createContext({
        agentConfig: config,
        usedToolNames: new Set(['WebFetch']),
      });

      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Unquarantined web fact',
          body: 'Content.',
          slug: 'unquarantined.md',
        },
        context,
      );

      expect(result.status).toBe('success');
      expect(result.content).toContain('Memory saved:');
      const memoryDir = getProjectMemoryDir(workspace);
      const parsed = readMemoryFile(join(memoryDir, 'unquarantined.md'));
      expect(parsed?.status).toBe('approved');
      expect(parsed?.externalContext).toBe(true);
    });

    it('quarantines save to inbox when session read agent-produced text', async () => {
      const notices: string[] = [];
      const contextWithTask = createContext({
        usedToolNames: new Set(['Task']),
        onNotice: (n) => notices.push(n),
      });

      const result = await memorySaveTool.execute(
        {
          action: 'save',
          type: 'project',
          title: 'Fact from task',
          body: 'Learned via subagent task.',
          slug: 'task-fact.md',
        },
        contextWithTask,
      );

      expect(result.status).toBe('success');
      expect(result.data).toMatchObject({
        action: 'save',
        status: 'pending',
        quarantined: true,
      });
      expect(notices).toEqual([
        'memory candidate saved (this session read external content): Fact from task — /memory inbox',
      ]);
    });

    it('counts web, MCP, and agent-produced text, and not local-only agent tools', () => {
      const external = [
        'WebFetch',
        'WebSearch',
        'mcp__x',
        'Task',
        'AgentRead',
        'AgentGet',
        'AgentWait',
        'AgentSpawn',
        'AgentSend',
        'EvidenceList',
      ];
      for (const tool of external) {
        expect(
          hasExternalContext({
            workspaceRoot: workspace,
            env: {},
            usedToolNames: new Set([tool]),
          }),
          `${tool} should count as external`,
        ).toBe(true);
      }

      // Agent and evidence tools that report this session's own state rather
      // than another agent's text: `Check` runs a command here, `AgentList`
      // lists agents we spawned. (`AgentSpawn` counts: its result is delivered
      // back automatically.)
      const localOnly = [
        'Read',
        'Edit',
        'Write',
        'Bash',
        'Grep',
        'TodoWrite',
        'TaskCreate',
        'Check',
        'AgentList',
        'AgentStop',
        'AgentPlan',
      ];
      for (const tool of localOnly) {
        expect(
          hasExternalContext({
            workspaceRoot: workspace,
            env: {},
            usedToolNames: new Set([tool]),
          }),
          `${tool} should not count as external`,
        ).toBe(false);
      }
    });

    it('seeds usedToolNames from the conversation the runtime is built for', () => {
      // What a resume, a rewind, and a headless run all have in common: the host
      // hands the runtime the conversation it is rebuilding.
      const runtime = new SessionRuntime({ history: resumedHistory });

      expect(
        hasExternalContext({
          workspaceRoot: workspace,
          env: {},
          usedToolNames: runtime.usedToolNames,
        }),
      ).toBe(true);
      runtime.dispose();
    });

    it('counts a call only when its result is there and was not blocked', () => {
      const [user, assistant] = resumedHistory;
      const withResults = (results: Message['toolResults']): Message[] => [
        user,
        { ...assistant, toolResults: results },
      ];
      const external = (history: Message[]): boolean => {
        const runtime = new SessionRuntime({ history });
        try {
          return hasExternalContext({
            workspaceRoot: workspace,
            env: {},
            usedToolNames: runtime.usedToolNames,
          });
        } finally {
          runtime.dispose();
        }
      };

      expect(external(resumedHistory)).toBe(true);

      // Denied, skipped, or refused in plan mode: recorded, never run.
      expect(
        external(
          withResults([
            {
              version: 2,
              toolCallId: 'call-web',
              status: 'blocked',
              content: 'SKIPPED: Permission denied',
            },
          ]),
        ),
      ).toBe(false);

      // A call with no result at all is not evidence that anything ran.
      expect(external([user, { ...assistant, toolResults: undefined }])).toBe(false);
    });
  });

  describe('permissions and visibility', () => {
    it('is blocked and hidden in plan mode at catalog level', () => {
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
      expect(activeNames).not.toContain('MemorySave');
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
