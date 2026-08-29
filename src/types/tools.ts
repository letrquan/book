import type { AgentManager } from '../agents/manager.js';
import type { AgentRole, AgentRuntimeEvent } from '../agents/types.js';
import type { ResolvedSettings } from '../settings.js';
import type { SessionRuntime } from '../session/runtime.js';
import type { AgentConfig, AgentTask, BackgroundShellStore, PermissionMode } from './runtime.js';
import type { AgentRunContext } from './runs.js';

export type PermissionResult = 'allow' | 'deny' | 'always';

/** Why a submitted plan was never applied when the host could not approve it. */
export type PlanNotAppliedReason =
  'approval_unavailable' | 'approval_declined' | 'approval_cancelled' | 'invalid_approval_response';

/**
 * `stop` is the non-interactive terminal decision: no approver exists (or the
 * approver refused to decide), so the run ends with the plan as its deliverable
 * instead of asking the model to revise and resubmit forever.
 */
export type PlanApprovalResult =
  | 'approve'
  | 'approve-fresh'
  | 'reject'
  | { decision: 'revise'; feedback: string }
  | { decision: 'stop'; reason: PlanNotAppliedReason; message: string };

export interface UserQuestionOption {
  label: string;
  description: string;
}

export interface UserQuestion {
  question: string;
  header: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
}

export type UserQuestionSource =
  { kind: 'root'; traceId?: string } | { kind: 'subagent'; agentPath: string[]; traceId?: string };

export interface UserQuestionRequest {
  id: string;
  questions: UserQuestion[];
  source: UserQuestionSource;
}

export type UserQuestionResponse =
  | { action: 'answer'; answers: Record<string, string | string[]> }
  | { action: 'decline'; message?: string }
  | { action: 'cancel'; message?: string };

export type UserQuestionHandler = (
  request: UserQuestionRequest,
  context: { signal?: AbortSignal },
) => Promise<UserQuestionResponse>;

/**
 * One field of an MCP `elicitation/create` form, flattened from the protocol's
 * restricted JSON Schema subset (top-level primitives only). Enum options come
 * from either `enum`/`enumNames` or the `oneOf: [{const, title}]` spelling.
 */
export type ElicitationField = {
  name: string;
  title: string;
  description?: string;
  required: boolean;
} & (
  | { kind: 'string'; format?: string; minLength?: number; maxLength?: number; default?: string }
  | { kind: 'number'; integer: boolean; minimum?: number; maximum?: number; default?: number }
  | { kind: 'boolean'; default?: boolean }
  | { kind: 'enum'; options: Array<{ value: string; label: string }>; default?: string }
);

export interface ElicitationRequest {
  id: string;
  /** Declared name of the MCP server asking, so the user can see who is asking. */
  server: string;
  message: string;
  fields: ElicitationField[];
}

export type ElicitationValue = string | number | boolean;

export type ElicitationResponse =
  | { action: 'accept'; content: Record<string, ElicitationValue> }
  | { action: 'decline' }
  | { action: 'cancel' };

export type ElicitationHandler = (
  request: ElicitationRequest,
  context: { signal?: AbortSignal },
) => Promise<ElicitationResponse>;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Display-only trace for a tool invoked inside a Task subagent. */
export interface NestedToolInvocation {
  /** Globally unique UI identity. Raw provider tool-call ids may repeat across subagents. */
  traceId: string;
  /** Trace id of the Task invocation that directly launched this tool. */
  parentTraceId: string;
  call: ToolCall;
  result?: ToolResult;
}

/** Optional observer used by hosts that want live visibility into subagent tools. */
export interface NestedToolObserver {
  onToolCall: (invocation: NestedToolInvocation) => void;
  onToolResult: (traceId: string, result: ToolResult) => void;
}

export interface FileMutationSummary {
  kind: 'create' | 'update' | 'delete';
  filePath: string;
  addedLines: number;
  removedLines: number;
}

export type ToolResultStatus = 'success' | 'error' | 'blocked' | 'cancelled' | 'timed_out';

export interface ToolResultError {
  code: string;
  message: string;
  retryable: boolean;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface ToolResultPresentation {
  kind: 'text' | 'markdown' | 'diff' | 'file' | 'command' | 'search' | 'task' | 'agent';
  summary: string;
  details?: string;
  metadata?: string[];
  target?: string;
}

export interface ToolResultArtifacts {
  fileMutation?: FileMutationSummary;
  /** All mutations produced by a transactional multi-file tool call. */
  fileMutations?: FileMutationSummary[];
  fileObservations?: FileObservation[];
  eventRef?: string;
  /** User-local file containing the complete output when model-facing content is clipped. */
  outputPath?: string;
}

/** V2 result contract shared by runtime, persistence, SDK, and TUI. */
export interface ToolResult<TData = unknown> {
  version: 2;
  toolCallId: string;
  status: ToolResultStatus;
  /** Concise provider-facing content. */
  content: string;
  /** Machine-readable payload for consumers that should not parse content. */
  data?: TData;
  structuredError?: ToolResultError;
  presentation?: ToolResultPresentation;
  metrics?: {
    durationMs?: number;
    retryAttempt?: number;
  };
  artifacts?: ToolResultArtifacts;
  pagination?: {
    cursor?: string;
    nextCursor?: string;
    truncated?: boolean;
    omittedItems?: number;
    omittedBytes?: number;
  };
}

/** JSON-schema subset accepted by provider tool definitions. */
export interface JsonSchemaObject extends Record<string, unknown> {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaObject;
  items?: JsonSchemaObject;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  oneOf?: JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
}

export type ToolCategory =
  | 'filesystem'
  | 'shell'
  | 'git'
  | 'web'
  | 'planning'
  | 'tasks'
  | 'skills'
  | 'agents'
  | 'evidence'
  | 'session'
  | 'notebook'
  | 'mcp'
  | 'other';

export type ToolEffect = 'read' | 'write' | 'execute' | 'network' | 'delegate' | 'interactive';

export interface ToolCatalogMetadata {
  /** Search terms in addition to the canonical tool name. */
  aliases?: string[];
  keywords?: string[];
  category?: ToolCategory;
  namespace?: string;
  /** Tool is always available in the practical core, normally deferred, or runtime-gated. */
  exposure?: 'core' | 'deferred' | 'runtime';
  /** Agent roles allowed to discover and invoke this definition. */
  roles?: Array<'root' | 'child'>;
  effects?: ToolEffect[];
  /** Optional runtime predicate for stateful tools such as background shells. */
  available?: (context: ToolContext) => boolean;
  /** Short catalog summary; descriptions remain the full provider-facing guidance. */
  summary?: string;
}

export interface ToolPolicy {
  idempotent?: boolean;
  concurrency?: 'parallel' | 'serial';
  requiresPermission?: boolean;
}

export type FileObservationOperation =
  'read' | 'mention' | 'edit' | 'write' | 'create' | 'notebook-read';

export interface FileObservation {
  path: string;
  workspaceId: string;
  sha256: string;
  byteSize: number;
  lineStart?: number;
  lineEnd?: number;
  operation: FileObservationOperation;
  sourceRef: string;
  timestamp: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Typed provider schema. `parameters` remains accepted while tools migrate. */
  inputSchema?: JsonSchemaObject;
  /** Cross-harness argument-name aliases (alias → canonical), applied before validation. */
  argumentAliases?: Record<string, string>;
  /** Per-item argument aliases for array arguments (argument name → alias → canonical). */
  arrayItemArgumentAliases?: Record<string, Record<string, string>>;
  catalog?: ToolCatalogMetadata;
  policy?: ToolPolicy;
  /** When true, the tool is safe to retry once on transient failure (Read, Grep, WebFetch, etc.). */
  idempotent?: boolean;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  workspaceRoot: string;
  env: Record<string, string>;
  /** Explicit environment overrides safe to persist for opt-in persistent jobs. */
  envOverrides?: Record<string, string>;
  /** Glob patterns to ignore during file discovery (e.g. from .gitignore). */
  gitignorePatterns?: string[];
  /** Resolved sandbox settings for the Bash tool. */
  sandbox?: ResolvedSettings['sandbox'];
  /** The active AgentConfig, set by the agent loop before tool execution. */
  agentConfig?: AgentConfig;
  /** Abort signal shared with nested Task subagents. */
  signal?: AbortSignal;
  /** Stable trace identity of the tool currently executing. */
  currentToolTraceId?: string;
  /** Current model-loop turn, used for bounded skill activation frames. */
  currentTurn?: number;
  /** Observer for display-only tools invoked inside Task subagents. */
  nestedToolObserver?: NestedToolObserver;
  /**
   * Agent todo list — written by TodoWrite, read by the loop for context injection.
   * Bound to the array `SessionRuntime` owns; TodoWrite mutates it in place rather
   * than reassigning, so the runtime, the session-state render, and the plan
   * persistence writer all observe the same list.
   */
  todos?: Array<{ content: string; status: string; activeForm?: string }>;
  /** Agent task list — written by TaskCreate/TaskUpdate and shared across tool calls. */
  tasks?: AgentTask[];
  /** Background shells started by Bash(run_in_background), shared across tool calls. */
  backgroundShells?: BackgroundShellStore;
  shellManager?: import('../jobs/shell-manager.js').ShellJobManager;
  /** Runtime-only newest file observation per workspace/path. */
  fileObservationLedger?: Map<string, FileObservation>;
  /** Live permission mode for the active agent loop; tools may update this. */
  currentMode?: PermissionMode;
  /** Mode to restore after a tool-initiated plan-mode session exits. */
  previousMode?: PermissionMode;
  /** Plan text submitted by ExitPlanMode and awaiting host approval. */
  pendingPlanApproval?: { plan: string };
  /** Structured questions submitted by AskUserQuestion and awaiting the host. */
  pendingUserQuestion?: { questions: UserQuestion[] };
  /** Host interaction capability propagated into Task subagents. */
  userQuestionHandler?: UserQuestionHandler;
  /** Nested agent names from the root agent to this loop. */
  agentPath?: string[];
  /** Active definitions used to derive a child's capability intersection. */
  availableTools?: ToolDefinition[];
  /** Managed-agent runtime shared by the parent session. */
  agentManager?: AgentManager;
  /** Identity set only inside a managed child. */
  agentId?: string;
  agentRole?: AgentRole;
  /** Parent session attribution for managed agents and hooks. */
  parentSessionId?: string;
  /** Root/parent execution attribution for managed agents and evidence. */
  runContext?: AgentRunContext;
  /** Observe-only runtime sink; absent while the harness is off. */
  harnessObserver?: import('../harness/contracts.js').HarnessRuntimeObserver;
  /** Host sink for managed-agent lifecycle and evidence events. */
  onAgentEvent?: (event: AgentRuntimeEvent) => void;
  /** Host sink used by lifecycle hooks started from managed-agent tools. */
  onHookEvent?: (event: string, payload: Record<string, unknown>) => void;
  /** Per-session capability/discovery controller installed by the agent loop. */
  toolDiscovery?: ToolDiscoveryContext;
  /** Mutable resources owned by the current session, separate from configuration. */
  runtime?: SessionRuntime;
}

export interface ToolSearchMatch {
  name: string;
  description: string;
  summary: string;
  category: ToolCategory;
  namespace?: string;
  loaded: boolean;
}

export interface ToolDiscoveryContext {
  /** Return authorized catalog matches without exposing their full schemas. */
  search(
    query: string,
    category?: ToolCategory,
    namespace?: string,
    limit?: number,
  ): ToolSearchMatch[];
  /** Activate selected definitions for the next provider request. */
  activate(names: string[]): string[];
  /** Intersect the current surface with an additional command/skill capability policy. */
  restrict(rules: string[]): void;
  /** Add a scoped capability intersection and return a disposer that restores the parent surface. */
  pushRestriction(rules: string[]): () => void;
  /** Preview the authorized definitions after an additional scoped intersection. */
  previewRestriction(rules: string[]): ToolDefinition[];
  /** Whether a tool is currently visible and executable for this turn. */
  canExecute(call: ToolCall): boolean;
  /** Definitions to send to the provider for the current request. */
  activeDefinitions(): ToolDefinition[];
  /** Compact catalog text used by the system prompt. */
  catalogSummary(): string;
}

export interface ToolDiscoveryState {
  /** Monotonic access counter used for deterministic LRU eviction. */
  clock: number;
  loaded: Map<string, number>;
}
