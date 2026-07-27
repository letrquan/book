import type { AgentRuntimeEvent } from '../agents/types.js';
import type { Message, Usage } from './messages.js';
import type { PermissionMode, RetryPhase } from './runtime.js';
import type { CompactResult } from './sessions.js';
import type { PlanApprovalResult, ToolCall, ToolResult, UserQuestionHandler } from './tools.js';

export type ProviderContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      data: string;
    };

export interface SystemPromptZones {
  /** Cacheable session-stable system prompt prefix. */
  cachedPrefix: string;
  /** Dynamic per-turn system prompt suffix, such as the active todo list. */
  dynamicSuffix: string;
}

export interface ProviderMessage {
  role: string;
  content: string | ProviderContentPart[] | SystemPromptZones | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ProviderStreamEvent {
  type: 'text' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  error?: string;
  usage?: Usage;
}

export interface ProviderStreamOptions {
  signal?: AbortSignal;
  onRetry?: (attempt: number, max: number, delayMs: number) => void;
  onStreamStall?: (countdownMs: number) => void;
  onStreamResume?: () => void;
  maxOutputTokens?: number;
}

export interface AgentLoopCallbacks {
  onText: (text: string) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult) => void;
  onError: (error: string) => void;
  onTurnStart: (turn: number) => void;
  onDone: () => void;
  onPermissionRequired: (toolCall: ToolCall) => Promise<'allow' | 'deny' | 'always'>;
  /** Reads the host's current permission mode while an agent loop is active. */
  getMode?: () => PermissionMode;
  /** @deprecated use onUsage for real token counts from the API. */
  onTokenCount?: (count: number) => void;
  onUsage?: (usage: Usage) => void;
  /** Called when a tool changes the live permission mode. */
  onModeChange?: (mode: PermissionMode) => void;
  /** Called when ExitPlanMode submits a plan for host approval. */
  onPlanApprovalRequired?: (plan: string) => Promise<PlanApprovalResult>;
  /**
   * Called when the user approves a plan with "fresh context" (`approve-fresh`).
   * The loop restores the pre-plan mode and stops the current turn; the host is
   * responsible for reseeding a fresh context with the approved plan.
   */
  onPlanHandoff?: (handoff: { plan: string; mode: PermissionMode }) => void;
  /** Called when the root agent or a Task subagent needs structured user input. */
  onUserQuestionRequired?: UserQuestionHandler;
  /**
   * Called when the context approaches its limit mid-loop.
   * Return a CompactResult; only `status: 'compacted'` replaces loop history.
   */
  onCompact?: (history: Message[], usage: Usage | null) => Promise<CompactResult>;
  /**
   * Called when an assistant turn (including tool results) is finalized.
   * Hosts should persist this immediately rather than slicing the final history.
   */
  onAssistantMessageComplete?: (message: Message) => void;
  /** Called after each tool execution with the current agent todo list. */
  onTodos?: (todos: Array<{ content: string; status: string; activeForm?: string }>) => void;
  /** Called when a transport-level retry starts (delay > 0). */
  onRetry?: (phase: RetryPhase, attempt: number, max: number, delayMs: number) => void;
  /** Called when the response stream stalls (no data for streamStallTimeoutMs). */
  onStreamStall?: (countdownMs: number) => void;
  /** Called when data resumes after a stream stall. */
  onStreamResume?: () => void;
  /**
   * Called when the user picks "always allow" at a permission prompt — so the
   * host can persist a Tool(specifier) rule (CC-aligned approval flow). The
   * `rule` string is canonical (e.g. `Bash(npm install)` or `Read`).
   */
  onPersistPermissionRule?: (rule: string) => void;
  /** Called when a hook lifecycle event fires (for --include-hook-events in stream-json mode). */
  onHookEvent?: (event: string, payload: Record<string, unknown>) => void;
  /** Called for managed-agent lifecycle, evidence, and application events. */
  onAgentEvent?: (event: AgentRuntimeEvent) => void;
}
