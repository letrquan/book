import type { Message } from '../types/messages.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import type { AgentConfig } from '../types/runtime.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { toolFailure, toolSuccess } from '../tools/result.js';

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
  return { id: 'u1', role: 'user', content, includeInContext: true, timestamp: 0 };
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
    includeInContext: true,
    toolCalls,
    toolResults,
    timestamp: 0,
  };
}

export function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args };
}

export function toolResult(toolCallId: string, content: string, success = true): ToolResult {
  return success
    ? toolSuccess(content, { toolCallId })
    : toolFailure('err', { toolCallId, content });
}
