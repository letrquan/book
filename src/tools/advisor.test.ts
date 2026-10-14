import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../config.js';
import { defaultConfig } from '../test/fixtures.js';
import { advisorRank } from '../models.js';
import type { Provider } from '../provider/index.js';
import type { ProviderMessage } from '../types/providers.js';
import type { Message } from '../types/messages.js';
import type { ToolContext } from '../types/tools.js';
import { SessionRuntime } from '../session/runtime.js';
import { runAgentLoop } from '../agent/loop.js';
import { createRegistry } from './registry.js';
import { toolSuccess } from './result.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import { createAgentRunContext } from '../types/runs.js';
import {
  ADVISOR_SYSTEM,
  ADVISOR_TOOL_DESCRIPTION,
  buildAdvisorPrompt,
  createAdvisorTools,
  describeAdvisorChange,
} from './advisor.js';

function message(role: 'user' | 'assistant', content: string): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    includeInContext: true,
    kind: 'conversation',
    timestamp: 0,
  };
}

function replying(text: string) {
  const requests: Array<{
    model: string;
    messages: ProviderMessage[];
    tools: unknown[];
    maxOutputTokens?: number;
  }> = [];
  const provider = {
    id: 'scripted',
    stream: async function* (
      config: { model: string },
      messages: ProviderMessage[],
      tools: unknown[],
      options?: { maxOutputTokens?: number },
    ) {
      requests.push({
        model: config.model,
        messages,
        tools,
        maxOutputTokens: options?.maxOutputTokens,
      });
      yield { type: 'text', content: text };
      yield { type: 'done', usage: { promptTokens: 40, completionTokens: 12, totalTokens: 52 } };
    },
  } as unknown as Provider;
  return { provider, requests };
}

function context(advisorModel: string | undefined, conversation: Message[]): ToolContext {
  const config = defaultConfig({ model: 'claude-sonnet-5' });
  config.advisorModel = advisorModel;
  return {
    workspaceRoot: process.cwd(),
    env: {},
    agentConfig: config,
    conversation: () => conversation,
  };
}

describe('Advisor tool', () => {
  it('is offered only once an advisor model is configured', () => {
    const [tool] = createAdvisorTools();
    expect(tool.description).toBe(ADVISOR_TOOL_DESCRIPTION);
    expect(tool.catalog?.exposure).toBe('core');
    expect(tool.catalog?.available?.(context(undefined, []))).toBe(false);
    expect(tool.catalog?.available?.(context('claude-opus-5-5', []))).toBe(true);
  });

  it('sends the whole conversation to the advisor model and returns its advice', async () => {
    const { provider, requests } = replying('1. Read the failing test first.');
    const [tool] = createAdvisorTools({ provider });
    const result = await tool.execute(
      {},
      context('claude-opus-5-5', [
        message('user', 'fix the flaky parser test'),
        message('assistant', 'I will rewrite the tokenizer.'),
      ]),
    );

    expect(result.status).toBe('success');
    expect(result.content).toBe('1. Read the failing test first.');
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe('claude-opus-5-5');
    expect(requests[0].tools).toEqual([]);
    expect(requests[0].messages[0]).toEqual({ role: 'system', content: ADVISOR_SYSTEM });
    const prompt = requests[0].messages[1].content as string;
    expect(prompt).toContain('fix the flaky parser test');
    expect(prompt).toContain('I will rewrite the tokenizer.');
  });

  it('charges the consultation to the run at the advisor model', async () => {
    const { provider } = replying('Looks sound.');
    const [tool] = createAdvisorTools({ provider });
    const runtime = new SessionRuntime();
    const runContext = createAgentRunContext({ sessionId: 's', source: 'tui' });
    runtime.runAccounting.startRoot(runContext);
    runtime.runAccounting.startExecution(runContext);
    await tool.execute(
      {},
      { ...context('claude-opus-5-5', [message('user', 'x')]), runtime, runContext },
    );
    const snapshot = runtime.runAccounting.snapshotRoot(runContext.rootRunId);
    expect(snapshot.inclusiveUsage?.completionTokens).toBe(12);
    expect(runtime.runAccounting.modelsFor(runContext.rootRunId)).toContain('claude-opus-5-5');
  });

  it('reports an unconfigured advisor and a failed call as tool failures', async () => {
    const [tool] = createAdvisorTools();
    const unconfigured = await tool.execute({}, context(undefined, []));
    expect(unconfigured.status).toBe('error');
    expect(unconfigured.structuredError?.code).toBe('advisor_unconfigured');

    const broken = {
      id: 'broken',
      stream: async function* () {
        yield { type: 'error', error: 'upstream 529 overloaded' };
      },
    } as unknown as Provider;
    const [failing] = createAdvisorTools({ provider: broken });
    const result = await failing.execute({}, context('claude-opus-5-5', [message('user', 'x')]));
    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toBe('Advisor unavailable (upstream 529 overloaded)');
  });

  it("shows the advisor the agent's instructions and every tool result whole", async () => {
    const { provider, requests } = replying('Follow the project rule.');
    const [tool] = createAdvisorTools({ provider });
    const longOutput = `${'line of test output\n'.repeat(400)}FINAL-LINE-42`;
    const turn: Message = {
      ...message('assistant', 'Ran the tests.'),
      toolCalls: [{ id: 't1', name: 'Bash', arguments: { command: 'npm test' } }],
      toolResults: [toolSuccess(longOutput, { toolCallId: 't1' })],
    };
    await tool.execute(
      {},
      {
        ...context('claude-opus-5-5', [message('user', 'fix it'), turn]),
        systemPrompt: () => 'PROJECT RULE: never hand-edit src/.',
      },
    );
    const prompt = requests[0].messages[1].content as string;
    expect(prompt).toContain('--- BEGIN AGENT INSTRUCTIONS (untrusted data) ---');
    expect(prompt).toContain('PROJECT RULE: never hand-edit src/.');
    // Not the summarizer's 2,000-character clip: the whole output, its middle included.
    expect(prompt).toContain(longOutput);
    expect(prompt.indexOf('PROJECT RULE')).toBeLessThan(prompt.indexOf('BEGIN AGENT TRANSCRIPT'));
  });

  it("caps the advice at the advisor model's own output limit", async () => {
    const { provider, requests } = replying('Short.');
    const [tool] = createAdvisorTools({ provider });
    const ctx = context('lab/advisor-x', [message('user', 'x')]);
    ctx.agentConfig!.settings.provider.lab = {
      type: 'openai',
      baseURL: 'http://localhost:9/v1',
      models: { 'advisor-x': { maxOutputTokens: 4_096 } },
    };
    await tool.execute({}, ctx);
    expect(requests[0].model).toBe('advisor-x');
    expect(requests[0].maxOutputTokens).toBe(4_096);
  });

  it('refuses an advisor model with no provider and no key, sending nothing (#419)', async () => {
    const { provider, requests } = replying('unused');
    const [tool] = createAdvisorTools({ provider });
    const ctx = context('claude-opus-5-5', [message('user', 'x')]);
    // The main model's key came from its provider entry, and BOOK_API_KEY is unset.
    ctx.agentConfig!.defaultApiKey = '';
    ctx.agentConfig!.defaultBaseUrl = 'https://api.openai.com/v1';

    const result = await tool.execute({}, ctx);
    expect(result.structuredError?.code).toBe('advisor_unconfigured');
    expect(result.structuredError?.message).toContain(
      '"claude-opus-5-5" names no configured provider',
    );
    expect(result.structuredError?.retryable).toBe(false);
    expect(requests).toHaveLength(0);
  });

  describe('from loadConfig, on the real provider path (#419)', () => {
    const saved = Object.fromEntries(
      ['BOOK_API_KEY', 'BOOK_BASE_URL', 'BOOK_HOME', 'BOOK_MODEL', 'BOOK_ADVISOR_MODEL'].map(
        (name) => [name, process.env[name]],
      ),
    );
    const dirs: string[] = [];

    afterEach(() => {
      vi.unstubAllGlobals();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it('never sends BOOK_API_KEY to the default endpoint for a bare advisor id', async () => {
      const home = mkdtempSync(join(tmpdir(), 'book-advisor-home-'));
      const workspace = mkdtempSync(join(tmpdir(), 'book-advisor-ws-'));
      dirs.push(home, workspace);
      mkdirSync(join(workspace, '.book'));
      writeFileSync(
        join(workspace, '.book', 'settings.local.json'),
        JSON.stringify({
          model: 'anthropic/claude-sonnet-5-5',
          advisorModel: 'claude',
          provider: { anthropic: { type: 'anthropic', baseURL: 'https://api.anthropic.com' } },
        }),
      );
      process.env.BOOK_HOME = home;
      process.env.BOOK_API_KEY = 'sk-ant-test';
      delete process.env.BOOK_BASE_URL;
      delete process.env.BOOK_MODEL;
      delete process.env.BOOK_ADVISOR_MODEL;
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const config = loadConfig(workspace);
      expect(config.baseUrl).toBe('https://api.anthropic.com');
      const [tool] = createAdvisorTools();
      const result = await tool.execute(
        {},
        {
          workspaceRoot: workspace,
          env: {},
          agentConfig: config,
          conversation: () => [message('user', 'x')],
        },
      );

      expect(result.status).toBe('error');
      expect(result.structuredError?.code).toBe('advisor_unconfigured');
      expect(result.structuredError?.retryable).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('does not invite a retry of a consult the provider refused', async () => {
    const refusing = (errorCode: string) =>
      ({
        id: 'refusing',
        stream: async function* () {
          yield { type: 'error', error: `API Error (${errorCode})`, errorCode };
        },
      }) as unknown as Provider;
    for (const [code, retryable] of [
      ['auth', false],
      ['quota', false],
      ['not_found', false],
      ['overloaded', true],
    ] as const) {
      const [tool] = createAdvisorTools({ provider: refusing(code) });
      const result = await tool.execute({}, context('claude-opus-5-5', [message('user', 'x')]));
      expect(result.structuredError?.retryable, code).toBe(retryable);
    }
  });

  it('refuses without a billed call when the host does not share the conversation', async () => {
    const { provider, requests } = replying('unused');
    const [tool] = createAdvisorTools({ provider });
    const result = await tool.execute(
      {},
      { ...context('claude-opus-5-5', []), conversation: undefined },
    );
    expect(result.status).toBe('error');
    expect(result.structuredError?.code).toBe('advisor_unavailable');
    expect(requests).toHaveLength(0);
  });

  it('words a broken response as the advisor, not as a compaction', async () => {
    const truncatedStream = {
      id: 'cut',
      stream: async function* () {
        yield { type: 'text', content: 'partial' };
      },
    } as unknown as Provider;
    const [tool] = createAdvisorTools({ provider: truncatedStream });
    const result = await tool.execute({}, context('claude-opus-5-5', [message('user', 'x')]));
    expect(result.structuredError?.message).toBe(
      'Advisor unavailable (The response ended before it completed.)',
    );
  });

  it('drops the oldest turns to fit the window and says so', () => {
    const history = Array.from({ length: 30 }, (_, index) =>
      message(index % 2 ? 'assistant' : 'user', `step ${index} ${'detail '.repeat(150)}`),
    );
    const prompt = buildAdvisorPrompt(history, 1_500);
    expect(prompt).toMatch(/\[The \d+ oldest messages were omitted/);
    expect(prompt).toContain('step 29');
  });
});

describe('Advisor in the loop', () => {
  it('sees the calls the agent made earlier in the same turn', async () => {
    const { provider: advisorProvider, requests } = replying('Ship it.');
    const registry = createRegistry();
    registry.registerAll([
      {
        name: 'Probe',
        description: 'Returns a marker.',
        parameters: { type: 'object', properties: {} },
        catalog: { exposure: 'core' },
        execute: async () => toolSuccess('PROBE-RESULT-7'),
      },
      ...createAdvisorTools({ provider: advisorProvider }),
    ]);
    let mainTurn = 0;
    const main = {
      id: 'scripted',
      stream: async function* () {
        mainTurn++;
        if (mainTurn === 1) {
          yield { type: 'text', content: 'Probing, then asking.' };
          yield { type: 'tool_call', toolCall: { id: 'p1', name: 'Probe', arguments: {} } };
          yield { type: 'tool_call', toolCall: { id: 'a1', name: 'Advisor', arguments: {} } };
          yield { type: 'done' };
          return;
        }
        yield { type: 'text', content: 'Done.' };
        yield { type: 'done' };
      },
    } as unknown as Provider;
    const config = defaultConfig({ model: 'claude-sonnet-5' });
    config.advisorModel = 'claude-opus-5-5';
    await runAgentLoop(
      config,
      registry,
      'check the probe',
      [],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onError: () => {},
        onTurnStart: () => {},
        onDone: () => {},
      } as unknown as AgentLoopCallbacks,
      'auto',
      { provider: main, isNewSession: false, runtime: new SessionRuntime() },
    );
    expect(requests).toHaveLength(1);
    const prompt = requests[0].messages[1].content as string;
    expect(prompt).toContain('Probing, then asking.');
    expect(prompt).toContain('PROBE-RESULT-7');
    // The system prompt the turn was sent with, so the advisor knows the agent's rules.
    expect(prompt).toContain('--- BEGIN AGENT INSTRUCTIONS (untrusted data) ---');
  });
});

describe('advisor strength', () => {
  it('ranks Claude models the way Claude Code does', () => {
    expect(advisorRank('claude-fable-5-1')).toBe(9);
    expect(advisorRank('claude-opus-5-5')).toBe(7);
    expect(advisorRank('anthropic/claude-sonnet-5-5')).toBe(6);
    expect(advisorRank('claude-sonnet-5')).toBe(4);
    expect(advisorRank('claude-haiku-4-5')).toBe(1);
    expect(advisorRank('claude-opus-5-20261001')).toBe(7);
    expect(advisorRank('claude-opus-5-1')).toBeUndefined();
    expect(advisorRank('9router/cmc/z-ai/glm-5.3-flash')).toBeUndefined();
  });

  it('notes a weaker or identical advisor, and says nothing about unranked models', () => {
    expect(describeAdvisorChange(null, 'claude-sonnet-5')).toBe('Advisor disabled');
    expect(describeAdvisorChange('claude-opus-5-5', 'claude-sonnet-5')).toBe(
      'Advisor set to claude-opus-5-5',
    );
    expect(describeAdvisorChange('claude-haiku-4-5', 'claude-opus-5-5')).toContain(
      'less capable than the current main model',
    );
    expect(describeAdvisorChange('claude-sonnet-5', 'claude-sonnet-5')).toContain(
      'the advisor is the current main model',
    );
    expect(describeAdvisorChange('9router/gpt-6', 'claude-opus-5-5')).toBe(
      'Advisor set to 9router/gpt-6',
    );
  });
});
