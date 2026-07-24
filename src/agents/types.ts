import type { Message, Usage } from '../types/messages.js';
import type { ToolResult, UserQuestionRequest } from '../types/tools.js';

export type AgentMode = 'adaptive' | 'manual' | 'off';
export type AgentRole = 'explorer' | 'patcher' | 'validator' | 'custom';
export type AgentStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';
export type AgentApplicationStatus = 'not_applied' | 'applied' | 'conflicted';
export type AgentTopology =
  'single' | 'parallel_research' | 'explore_then_patch' | 'patch_validate';
export type IssueQuality = 'clear' | 'ambiguous' | 'unknown';
export type AgentIsolation = 'workspace-readonly' | 'worktree';

export interface AgentProfile {
  name: string;
  role: AgentRole;
  description: string;
  allowedTools: string[];
  model?: string;
  maxTurns?: number;
  effort?: string;
  isolation: AgentIsolation;
  color?: string;
}

export interface AgentActivitySummary {
  kind: 'thinking' | 'tool' | 'waiting' | 'compacting';
  label: string;
  toolName?: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
}

export interface AgentActivity extends AgentActivitySummary {
  id: string;
  /** Full live tool call used by hosts to render nested child activity. */
  toolCall?: import('../types/tools.js').ToolCall;
  /** Bounded, display-only result projection for realtime host rendering. */
  result?: ToolResult;
  finishedAt?: number;
}

export interface AgentPlanRecord {
  id: string;
  parentSessionId?: string;
  taskShape: string;
  issueQuality: IssueQuality;
  topology: AgentTopology;
  rationale: string;
  agentBudget: number;
  createdAt: number;
}

export interface AgentRunMetrics {
  toolCalls: number;
  compactions: number;
  retries: number;
}

export interface AgentSnapshot {
  id: string;
  repoRoot: string;
  repoHash: string;
  baseHead: string;
  commit: string;
  tree: string;
  ref: string;
  fingerprint: string;
  dirty: boolean;
  includeUntracked: boolean;
  manifest: Array<{ status: string; path: string }>;
  createdAt: number;
}

export interface PatchCandidate {
  baseCommit: string;
  headCommit: string;
  branch: string;
  agentId: string;
}

export interface AgentRecord {
  id: string;
  profile?: string;
  displayName?: string;
  profileDescription?: string;
  purpose?: string;
  requestedModel?: string;
  resolvedModel?: string;
  provider?: string;
  effort?: string;
  isolation?: AgentIsolation;
  currentActivity?: AgentActivitySummary;
  /** @deprecated Use profile. Retained for persisted version 1 compatibility. */
  name: string;
  role: AgentRole;
  /** @deprecated Use profileDescription. */
  description: string;
  parentSessionId?: string;
  planId?: string;
  status: AgentStatus;
  applicationStatus: AgentApplicationStatus;
  worktree?: string;
  branch?: string;
  snapshotId?: string;
  prompt: string;
  referencedEvidenceIds: string[];
  /** Evidence published by this agent, kept separate from supplied inputs. */
  producedEvidenceIds?: string[];
  transcript: Message[];
  pendingMessages: string[];
  pendingQuestion?: UserQuestionRequest;
  pendingQuestionCreatedAt?: number;
  pendingPermission?: AgentPermissionRequest;
  result?: string;
  error?: string;
  stopReason?: string;
  patchCandidate?: PatchCandidate;
  usage?: Usage;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  finishedAt?: number;
  /** Monotonic terminal-result generation used for durable parent delivery. */
  completionSequence?: number;
  /** Latest completion generation durably accepted by the parent host. */
  completionDeliveredSequence?: number;
  /** Monotonic execution generation for resumed/follow-up runs. */
  runSequence?: number;
  /** Start and usage for the current execution generation. */
  runStartedAt?: number;
  runUsage?: Usage;
  runMetrics?: AgentRunMetrics;
  /** Runtime-only warning when the latest state is waiting for durable storage. */
  durabilityWarning?: string;
}

export interface AgentSummary {
  agentId: string;
  displayName: string;
  profile: string;
  status: AgentStatus;
  resolvedModel: string;
  isolation: AgentIsolation;
  currentActivity?: AgentActivitySummary;
  summary?: string;
  summaryCharacters?: number;
  summaryTruncated?: boolean;
  error?: string;
  errorCharacters?: number;
  errorTruncated?: boolean;
  usage?: Usage;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  finishedAt?: number;
  durabilityWarning?: string;
}

export interface AgentCompletion extends AgentSummary {
  evidenceIds: string[];
  applicationStatus?: AgentApplicationStatus;
}

export interface AgentCompletionNotification {
  deliveryId: string;
  sequence: number;
  completion: AgentCompletion;
  parentSessionId?: string;
}

export type EvidenceKind = 'finding' | 'hypothesis' | 'test_result' | 'patch_candidate' | 'blocker';
export type EvidenceVerificationState = 'unverified' | 'verified' | 'rejected' | 'inconclusive';

export interface EvidenceReference {
  type: 'file' | 'command' | 'diff' | 'commit';
  value: string;
}

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  sourceAgentId: string;
  summary: string;
  confidence: number;
  references: EvidenceReference[];
  verificationState: EvidenceVerificationState;
  patchCandidate?: PatchCandidate;
  reviewerAgentId?: string;
  verdict?: 'pass' | 'fail' | 'inconclusive';
  reviewNotes?: string;
  createdAt: number;
  reviewedAt?: number;
  updatedAt: number;
}

export type AgentRuntimeEvent =
  | { type: 'agent_status'; agent: AgentSummary; parentSessionId?: string }
  | { type: 'agent_activity'; agentId: string; activity: AgentActivity }
  | { type: 'agent_text_delta'; agentId: string; text: string }
  | { type: 'agent_message'; agentId: string; message: Message }
  | { type: 'agent_permission'; agentId: string; request: AgentPermissionRequest }
  | { type: 'agent_start'; agent: AgentRecord; snapshot?: Pick<AgentSnapshot, 'id' | 'manifest'> }
  | { type: 'agent_update'; agent: AgentRecord }
  | { type: 'agent_completion'; notification: AgentCompletionNotification }
  | { type: 'agent_result'; agent: AgentRecord }
  | { type: 'agent_question'; agentId: string; request: UserQuestionRequest }
  | { type: 'evidence_update'; evidence: EvidenceItem }
  | {
      type: 'agent_persistence';
      state: 'degraded' | 'recovered';
      reason: 'busy' | 'unavailable';
      errorCode?: string;
      message: string;
      agentId?: string;
      retrying: boolean;
      timestamp: number;
    }
  | {
      type: 'agent_apply';
      agentId: string;
      evidenceId: string;
      status: AgentApplicationStatus;
      commit?: string;
      error?: string;
    };

export interface AgentSpawnRequest {
  agent: string;
  description?: string;
  prompt: string;
  model?: string;
  planId?: string;
  evidenceIds?: string[];
  parentSessionId?: string;
}

export interface AgentPermissionRequest {
  id: string;
  agentId: string;
  displayName: string;
  toolName: string;
  toolCall: import('../types/tools.js').ToolCall;
  createdAt: number;
}

export interface AgentApplyResult {
  status: AgentApplicationStatus;
  commit?: string;
  error?: string;
}
