import { describe, expect, it } from 'vitest';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { Message } from '../types/messages.js';
import { defaultConfig, toolCall, toolResult } from '../test/fixtures.js';
import { formatToolCall, formatToolResult, runScrollbackSession } from './scrollback.js';
import type { ScrollbackOptions } from './scrollback.js';

function promptReader(values: string[]): () => Promise<string | null> {
  return async () => values.shift() ?? null;
}

function captureOutput() {
  let text = '';
  return {
    output: {
      write(chunk: string) {
        text += chunk;
        return true;
      },
    },
    text: () => text,
  };
}

describe('scrollback formatting', () => {
  it('formats tool call and result as append-only transcript lines', () => {
    const call = toolCall('t1', 'Read', { filePath: 'src/a.ts' });

    expect(formatToolCall(call)).toBe('\n[tool] Read src/a.ts\n');
    expect(formatToolResult(toolResult('t1', 'done'), call)).toBe('[OK] Read src/a.ts\ndone\n');
  });
});

describe('runScrollbackSession', () => {
  it('streams prompts through the agent loop and appends output once', async () => {
    const writes = captureOutput();
    const call = toolCall('t1', 'Read', { filePath: 'src/a.ts' });
    const runLoop: NonNullable<ScrollbackOptions['runLoop']> = async (
      _config,
      _registry,
      prompt,
      history,
      callbacks: AgentLoopCallbacks,
    ): Promise<Message[]> => {
      callbacks.onText(`answer to ${prompt}`);
      callbacks.onToolCall(call);
      callbacks.onToolResult(toolResult('t1', 'file contents'));
      callbacks.onDone();
      return [
        ...history,
        { id: 'u1', role: 'user', content: prompt, includeInContext: true, timestamp: 1 },
        {
          id: 'a1',
          role: 'assistant',
          content: 'answer',
          includeInContext: true,
          timestamp: 2,
        },
      ];
    };

    const history = await runScrollbackSession(defaultConfig(), {
      mode: 'default',
      readPrompt: promptReader(['hello', '/exit']),
      output: writes.output,
      runLoop,
    });

    expect(history.map((m) => m.content)).toEqual(['hello', 'answer']);
    expect(writes.text()).toContain('Book scrollback mode');
    expect(writes.text()).toContain('answer to hello');
    expect(writes.text()).toContain('[tool] Read src/a.ts');
    expect(writes.text()).toContain('[OK] Read src/a.ts');
    expect(writes.text()).toContain('file contents');
  });

  it('answers a permission prompt that meets the end of input as having no approver (#264)', async () => {
    const writes = captureOutput();
    const decisions: unknown[] = [];
    const runLoop: NonNullable<ScrollbackOptions['runLoop']> = async (
      _config,
      _registry,
      _prompt,
      history,
      callbacks: AgentLoopCallbacks,
    ): Promise<Message[]> => {
      decisions.push(
        await callbacks.onPermissionRequired(toolCall('t1', 'Bash', { command: 'ls' })),
      );
      decisions.push(
        await callbacks.onPermissionRequired(toolCall('t2', 'Bash', { command: 'ls' })),
      );
      return history;
    };

    await runScrollbackSession(defaultConfig(), {
      mode: 'default',
      readPrompt: promptReader(['hello', 'n']),
      output: writes.output,
      runLoop,
    });

    // A person's "n" is a plain refusal; the closed input after it is nobody to ask.
    expect(decisions).toEqual(['deny', { result: 'deny', reason: 'no_approver' }]);
  });

  it('/clear resets accumulated history without calling the agent loop', async () => {
    const writes = captureOutput();
    let calls = 0;
    const runLoop: NonNullable<ScrollbackOptions['runLoop']> = async () => {
      calls++;
      return [];
    };

    const history = await runScrollbackSession(defaultConfig(), {
      mode: 'default',
      readPrompt: promptReader(['/clear', '/exit']),
      output: writes.output,
      runLoop,
    });

    expect(history).toEqual([]);
    expect(calls).toBe(0);
    expect(writes.text()).toContain('[cleared]');
  });
});
