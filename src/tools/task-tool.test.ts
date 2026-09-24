import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentManager } from '../agents/manager.js';
import { SessionRuntime } from '../session/runtime.js';
import { defaultConfig } from '../test/fixtures.js';
import type { ToolContext } from '../types/tools.js';
import { taskTool } from './task-tool.js';

describe('Task tool', () => {
  let root: string;
  let bookHome: string;
  let originalBookHome: string | undefined;

  beforeEach(() => {
    originalBookHome = process.env.BOOK_HOME;
    bookHome = mkdtempSync(join(tmpdir(), 'book-home-'));
    process.env.BOOK_HOME = bookHome;
    root = mkdtempSync(join(tmpdir(), 'book-task-tool-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalBookHome !== undefined) {
      process.env.BOOK_HOME = originalBookHome;
    } else {
      delete process.env.BOOK_HOME;
    }
    rmSync(bookHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function createHoldingResponse(signal?: AbortSignal | null): Response {
    const stream = new ReadableStream({
      start(controller) {
        if (signal?.aborted) {
          controller.close();
          return;
        }
        signal?.addEventListener('abort', () => {
          try {
            controller.close();
          } catch {
            // Stream already closed
          }
        });
      },
    });
    return new Response(stream, { status: 200 });
  }

  function createSuccessResponse(text = 'Task finished.'): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  it('stops the child and returns partial error on timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        createHoldingResponse(init?.signal),
      ),
    );

    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const manager = new AgentManager(config, [], {
      storeRoot: root,
      findGitRoot: async () => undefined,
    });
    const runtime = new SessionRuntime();
    runtime.agentManager = manager;

    const context: ToolContext = {
      workspaceRoot: root,
      env: { BOOK_TOOL_TIMEOUT_MS: '200' },
      agentConfig: config,
      availableTools: [],
      currentMode: 'bypassPermissions',
      runtime,
    };

    try {
      const result = await taskTool[0].execute(
        { agent: 'explorer', prompt: 'explore slowly' },
        context,
      );

      expect(result.status).toBe('error');
      expect(result.structuredError?.code).toBe('subagent_timeout');
      expect(result.content).toContain('AgentRead with agentId');
      expect(result.content).not.toContain('full transcript');

      const agents = await manager.list();
      expect(agents.length).toBeGreaterThan(0);
      const child = await manager.get(agents[0].id);
      expect(child?.status).toBe('stopped');

      // The child unwinds after Task returns and opens a second terminal
      // generation; none of them may reach the parent as a completion.
      await manager.waitForIdle();
      expect(await manager.listPendingCompletions()).toEqual([]);
    } finally {
      manager.dispose();
      runtime.dispose();
    }
  });

  it('aborts and stops running child when ctx.signal is aborted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        createHoldingResponse(init?.signal),
      ),
    );

    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const manager = new AgentManager(config, [], {
      storeRoot: root,
      findGitRoot: async () => undefined,
    });
    const runtime = new SessionRuntime();
    runtime.agentManager = manager;

    const controller = new AbortController();
    const context: ToolContext = {
      workspaceRoot: root,
      env: {},
      agentConfig: config,
      availableTools: [],
      currentMode: 'bypassPermissions',
      runtime,
      signal: controller.signal,
    };

    try {
      const taskPromise = taskTool[0].execute(
        { agent: 'explorer', prompt: 'explore until aborted' },
        context,
      );

      // Abort parent signal after the child starts running
      setTimeout(() => {
        controller.abort();
      }, 50);

      await taskPromise;

      const agents = await manager.list();
      expect(agents.length).toBeGreaterThan(0);
      const child = await manager.get(agents[0].id);
      expect(child?.status).toBe('stopped');

      await manager.waitForIdle();
      expect(await manager.listPendingCompletions()).toEqual([]);
    } finally {
      manager.dispose();
      runtime.dispose();
    }
  });

  it('stops the child when the parent was cancelled before the spawn returned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        createHoldingResponse(init?.signal),
      ),
    );

    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const manager = new AgentManager(config, [], {
      storeRoot: root,
      findGitRoot: async () => undefined,
    });
    const runtime = new SessionRuntime();
    runtime.agentManager = manager;

    const controller = new AbortController();
    controller.abort();
    const context: ToolContext = {
      workspaceRoot: root,
      // A listener added to an already-aborted signal never fires, so only the
      // ceiling would end the wait. Keep it short: the test then fails on the
      // result code instead of hanging for thirty minutes.
      env: { BOOK_TOOL_TIMEOUT_MS: '2000' },
      agentConfig: config,
      availableTools: [],
      currentMode: 'bypassPermissions',
      runtime,
      signal: controller.signal,
    };

    try {
      const result = await taskTool[0].execute(
        { agent: 'explorer', prompt: 'explore after a cancel' },
        context,
      );

      expect(result.status).toBe('error');
      expect(result.structuredError?.code).not.toBe('subagent_timeout');

      const agents = await manager.list();
      expect(agents.length).toBeGreaterThan(0);
      const child = await manager.get(agents[0].id);
      expect(child?.status).toBe('stopped');

      await manager.waitForIdle();
      expect(await manager.listPendingCompletions()).toEqual([]);
    } finally {
      manager.dispose();
      runtime.dispose();
    }
  });

  it('completes normally with status success when child succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => createSuccessResponse('Found all target files.')),
    );

    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const manager = new AgentManager(config, [], {
      storeRoot: root,
      findGitRoot: async () => undefined,
    });
    const runtime = new SessionRuntime();
    runtime.agentManager = manager;

    const context: ToolContext = {
      workspaceRoot: root,
      env: {},
      agentConfig: config,
      availableTools: [],
      currentMode: 'bypassPermissions',
      runtime,
    };

    try {
      const result = await taskTool[0].execute(
        { agent: 'explorer', prompt: 'find target files' },
        context,
      );

      expect(result.status).toBe('success');
      expect(result.content).toContain('Found all target files.');

      const agents = await manager.list();
      expect(agents.length).toBeGreaterThan(0);
      const child = await manager.get(agents[0].id);
      expect(child?.status).toBe('completed');
    } finally {
      manager.dispose();
      runtime.dispose();
    }
  });
});
