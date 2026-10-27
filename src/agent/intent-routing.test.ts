import { describe, expect, it } from 'vitest';
import { runAgentLoop } from './loop.js';
import { createDefaultRegistry } from '../tools/registry.js';
import type { Provider } from '../provider/index.js';
import type { Message } from '../types/messages.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import { defaultConfig } from '../test/fixtures.js';
import { isolateBookHome } from '../test/isolated-book-home.js';

// Intent routing (#619) through the whole agent loop: what the user typed activates a deferred
// tool before the turn's first model call, and nothing else does.

isolateBookHome();

interface Captured {
  /** The tool names each provider request declared. */
  tools: string[][];
  /** Each request's system text. */
  system: string[];
  toolCalls: string[];
}

const callbacks = (captured: Captured): AgentLoopCallbacks => ({
  onText: () => {},
  onToolCall: (call) => captured.toolCalls.push(call.name),
  onToolResult: () => {},
  onError: () => {},
  onTurnStart: () => {},
  onDone: () => {},
  onPermissionRequired: async () => 'allow',
  onPlanApprovalRequired: async () => 'approve',
});

async function run(options: {
  prompt: string;
  typedText?: string;
  kind?: Message['kind'];
  isSubagent?: boolean;
  allowedTools?: string[];
  intentRouting?: boolean;
  configure?: (config: ReturnType<typeof defaultConfig>) => void;
}): Promise<Captured> {
  const captured: Captured = { tools: [], system: [], toolCalls: [] };
  const provider = {
    id: 'scripted',
    stream: async function* (
      _config: unknown,
      messages: Array<{ role: string; content: unknown }>,
      tools: Array<{ name: string }>,
    ) {
      captured.tools.push(tools.map((tool) => tool.name));
      captured.system.push(JSON.stringify(messages.filter((message) => message.role === 'system')));
      yield { type: 'text', content: 'done' };
      yield { type: 'done' };
    },
  } as unknown as Provider;
  const config = defaultConfig({ maxTurns: 2 });
  if (options.intentRouting !== undefined) {
    config.settings.toolDiscovery.intentRouting = options.intentRouting;
  }
  options.configure?.(config);
  await runAgentLoop(
    config,
    createDefaultRegistry(),
    options.prompt,
    [],
    callbacks(captured),
    'default',
    {
      provider,
      isNewSession: false,
      typedText: options.typedText,
      userMessageKind: options.kind,
      isSubagent: options.isSubagent,
      allowedTools: options.allowedTools,
    },
  );
  return captured;
}

const URL_PROMPT = 'What does https://example.com/notes.txt say?';

describe('intent routing in the agent loop (#619)', () => {
  it('declares WebFetch on the first request when the typed text holds a URL', async () => {
    const captured = await run({ prompt: URL_PROMPT, typedText: URL_PROMPT });
    expect(captured.tools[0]).toContain('WebFetch');
    expect(captured.toolCalls).not.toContain('ToolSearch');
  });

  it('declares WebSearch on the first request for search intent', async () => {
    const prompt = 'Look up the latest Node.js LTS';
    const captured = await run({ prompt, typedText: prompt });
    expect(captured.tools[0]).toContain('WebSearch');
    expect(captured.tools[0]).not.toContain('WebFetch');
  });

  it('routes nothing with toolDiscovery.intentRouting off', async () => {
    const captured = await run({ prompt: URL_PROMPT, typedText: URL_PROMPT, intentRouting: false });
    expect(captured.tools[0]).not.toContain('WebFetch');
  });

  it('routes only what the user typed, not the prompt it resolved to', async () => {
    // A command's body, an inlined file or a delegated task reaches the loop as the prompt.
    const captured = await run({ prompt: URL_PROMPT, typedText: '/summarize' });
    expect(captured.tools[0]).not.toContain('WebFetch');
  });

  it.each<[string, { typedText?: string; kind?: Message['kind']; isSubagent?: boolean }]>([
    ['a turn the user did not type', {}],
    ['an agent notification', { typedText: URL_PROMPT, kind: 'agent-notification' }],
    ['a carried turn', { typedText: URL_PROMPT, kind: 'carried' }],
    ['a checkpoint', { typedText: URL_PROMPT, kind: 'checkpoint' }],
    ['a subagent', { typedText: URL_PROMPT, isSubagent: true }],
  ])('never routes %s', async (_name, options) => {
    const captured = await run({ prompt: URL_PROMPT, ...options });
    expect(captured.tools[0]).not.toContain('WebFetch');
  });

  it('routes a conversation turn the user typed', async () => {
    const captured = await run({ prompt: URL_PROMPT, typedText: URL_PROMPT, kind: 'conversation' });
    expect(captured.tools[0]).toContain('WebFetch');
  });

  it('respects the ToolSearch gate', async () => {
    const captured = await run({
      prompt: URL_PROMPT,
      typedText: URL_PROMPT,
      configure: (config) => {
        config.settings.hooks.PostToolUse = [{ matcher: 'ToolSearch', command: 'exit 0', env: {} }];
      },
    });
    expect(captured.tools[0]).not.toContain('WebFetch');
  });

  it("respects the run's allowed tools", async () => {
    const captured = await run({
      prompt: URL_PROMPT,
      typedText: URL_PROMPT,
      allowedTools: ['Read'],
    });
    expect(captured.tools[0]).not.toContain('WebFetch');
  });

  it('leaves the system text byte-identical with routing on and off', async () => {
    const on = await run({ prompt: URL_PROMPT, typedText: URL_PROMPT });
    const off = await run({ prompt: URL_PROMPT, typedText: URL_PROMPT, intentRouting: false });
    expect(on.tools[0]).toContain('WebFetch');
    expect(off.tools[0]).not.toContain('WebFetch');
    expect(on.system[0]).toBe(off.system[0]);
  });
});
