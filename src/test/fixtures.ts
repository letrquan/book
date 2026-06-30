import type { Message, ToolCall, ToolResult, AgentConfig } from '../types.js';
import { DEFAULT_SETTINGS } from '../settings.js';

export function defaultConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    apiKey: 'k',
    baseUrl: 'http://x/v1',
    model: 'm',
    maxTurns: 5,
    maxTokens: 128000,
    autoCompactEnabled: false,
    workspace: '.',
    animation: { typewriterSpeed: 3, spinnerStyle: 'braille' },
    accessibility: { screenReader: false, reducedMotion: false },
    settings: structuredClone(DEFAULT_SETTINGS),
    retry: {
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 100,
      totalBudgetMs: 0,
      requestTimeoutMs: 0,
      streamStallTimeoutMs: 0,
      toolRetries: 0,
      watchdog: false,
    },
    ...overrides,
  };
}

export function userMsg(content: string): Message {
  return { id: 'u1', role: 'user', content, timestamp: 0 };
}

export function assistantMsg(
  content: string,
  toolCalls?: ToolCall[],
  toolResults?: ToolResult[],
): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content,
    toolCalls,
    toolResults,
    timestamp: 0,
  };
}

export function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): ToolCall {
  return { id, name, arguments: args };
}

export function toolResult(toolCallId: string, output: string, success = true): ToolResult {
  return { toolCallId, success, output, error: success ? undefined : 'err' };
}
