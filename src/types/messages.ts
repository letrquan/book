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

/** Provider-native response data needed to replay a provider protocol exactly. */
export interface ProviderMessageMetadata {
  /** Anthropic content blocks, including thinking signatures, in original order. */
  anthropicContentBlocks?: Array<Record<string, unknown>>;
}

/** A session-owned image referenced by a user message. */
export interface ImageAttachment {
  id: string;
  sha256: string;
  storageKey: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  byteSize: number;
  displayName?: string;
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
  /** False/absent when maxTokens is the assumed default, not a declared window. */
  windowDeclared?: boolean;
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
  /** Per-tool call/failure counters for this session, ordered by call count. */
  toolCallStats?: Array<{ tool: string; calls: number; failures: Record<string, number> }>;
}

/** Compact completion metadata rendered as a host notification. */
export interface AgentNotificationDisplay {
  deliveryId?: string;
  sequence?: number;
  agentId: string;
  displayName: string;
  status: 'completed' | 'failed' | 'stopped' | 'interrupted';
  summary?: string;
  error?: string;
  evidenceIds: string[];
  durationMs?: number;
}

export type LocalCommandDisplay =
  ConfigCommandDisplay | ContextCommandDisplay | UsageCommandDisplay;

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  /** User-facing text shown in the TUI/history. */
  content: string;
  /** Provider-native reasoning/thinking text shown separately and replayed in later context. */
  reasoningContent?: string;
  /** Provider-native metadata used only when reconstructing provider requests. */
  providerMetadata?: ProviderMessageMetadata;
  /** Provider-facing text when it differs from the displayed content. */
  contextContent?: string;
  /**
   * Host-rendered `<session-state>` block appended to this turn for the provider.
   * Written once when the turn is first built and never rewritten, so rebuilds
   * reproduce the message byte-for-byte behind the conversation cache breakpoint.
   */
  sessionState?: string;
  /** Images attached to a user turn; bytes live in session attachment storage. */
  attachments?: ImageAttachment[];
  /** Whether this message is included in provider and compaction context. */
  includeInContext: boolean;
  kind?: 'conversation' | 'checkpoint' | 'local' | 'agent-notification';
  /**
   * The content was produced by resolving something -- a slash command's body, a
   * delegated task prompt -- rather than typed by the user. The role still reads
   * `user` because that is the turn's position in the conversation, so anything
   * that means "the user's own words" must check this too.
   */
  derivedContent?: boolean;
  /** Structured display data for automatically delivered child completions. */
  agentNotifications?: AgentNotificationDisplay[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  /** UI-only subagent activity. Never serialized as provider tool calls. */
  nestedToolInvocations?: NestedToolInvocation[];
  /** UI-only visual treatment for local slash-command output. */
  localCommand?: LocalCommandDisplay;
  fileObservations?: FileObservation[];
  timestamp: number;
}
