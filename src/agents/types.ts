import type { Message, Usage } from '../types/messages.js';
import type { UserQuestionRequest } from '../types/tools.js';

export type AgentMode = 'adaptive' | 'manual' | 'off';
export type AgentRole = 'explorer' | 'patcher' | 'validator' | 'custom';
export type AgentStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';
export type AgentApplicationStatus = 'not_applied' | 'applied' | 'conflicted';
export type AgentTopology =
  'single' | 'parallel_research' | 'explore_then_patch' | 'patch_validate';
export type IssueQuality = 'clear' | 'ambiguous' | 'unknown';

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
  name: string;
  role: AgentRole;
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
  transcript: Message[];
  pendingMessages: string[];
  pendingQuestion?: UserQuestionRequest;
  result?: string;
  error?: string;
  stopReason?: string;
  patchCandidate?: PatchCandidate;
  usage?: Usage;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  finishedAt?: number;
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
  | { type: 'agent_start'; agent: AgentRecord; snapshot?: Pick<AgentSnapshot, 'id' | 'manifest'> }
  | { type: 'agent_update'; agent: AgentRecord }
  | { type: 'agent_result'; agent: AgentRecord }
  | { type: 'agent_question'; agentId: string; request: UserQuestionRequest }
  | { type: 'evidence_update'; evidence: EvidenceItem }
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
  prompt: string;
  planId?: string;
  evidenceIds?: string[];
  parentSessionId?: string;
}

export interface AgentApplyResult {
  status: AgentApplicationStatus;
  commit?: string;
  error?: string;
}
