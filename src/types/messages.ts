import type { FileObservation, NestedToolInvocation, ToolCall, ToolResult } from './tools.js';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Context-pressure metric for auto-compact (includes Anthropic cache tokens when known). */
  contextTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Structured presentation data for local slash-command output.
 *
 * These snapshots stay UI-only: local command messages are excluded from the
 * provider context and are never persisted as assistant turns.
 */
export interface ConfigCommandDisplay {
  kind: 'config';
  snapshot: Record<string, unknown>;
  runtime: {
    model: string;
    provider: string;
    effort?: string;
    mode: string;
    maxTokens: number;
    workspace: string;
  };
}

export interface ContextCommandDisplay {
  kind: 'context';
  model: string;
  maxTokens: number;
  estimatedTokens: number;
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  userTokens: number;
  assistantTokens: number;
  ambient: {
    commandCount: number;
    skillCount?: number;
    subagentCount?: number;
    hasMemoryIndex?: boolean;
    hasClaudeMdLoader: boolean;
  };
}

export interface UsageCommandDisplay {
  kind: 'usage';
  model: string;
  currentTurn: number;
  messageCount: number;
  turnDurationMs: number;
  usage: Usage | null;
  rate?: { inputPerMillion: number; outputPerMillion: number };
  estimatedCostUsd?: number;
}

export type LocalCommandDisplay =
  ConfigCommandDisplay | ContextCommandDisplay | UsageCommandDisplay;

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  /** User-facing text shown in the TUI/history. */
  content: string;
  /** Provider-facing text when it differs from the displayed content. */
  contextContent?: string;
  /** Whether this message is included in provider and compaction context. */
  includeInContext: boolean;
  kind?: 'conversation' | 'checkpoint' | 'local';
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  /** UI-only subagent activity. Never serialized as provider tool calls. */
  nestedToolInvocations?: NestedToolInvocation[];
  /** UI-only visual treatment for local slash-command output. */
  localCommand?: LocalCommandDisplay;
  fileObservations?: FileObservation[];
  timestamp: number;
}
