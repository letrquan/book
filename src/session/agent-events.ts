import type { AgentRecord, AgentRuntimeEvent, EvidenceItem } from '../agents/types.js';
import type { Message, Usage } from '../types/messages.js';
import type {
  ToolCall,
  ToolResult,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../types/tools.js';

export type AgentEvent =
  | { type: 'system'; model: string; cwd: string }
  | { type: 'session'; sessionId: string }
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolCall: ToolCall }
  | { type: 'tool_result'; toolResult: ToolResult }
  | { type: 'user_question'; request: UserQuestionRequest; status: 'pending' | 'unavailable' }
  | { type: 'user_question_result'; requestId: string; response: UserQuestionResponse }
  | { type: 'agent_start'; agent: AgentRecord }
  | { type: 'agent_update'; agent: AgentRecord }
  | { type: 'agent_result'; agent: AgentRecord }
  | Extract<AgentRuntimeEvent, { type: 'agent_question' | 'agent_apply' }>
  | { type: 'evidence_update'; evidence: EvidenceItem }
  | { type: 'error'; error: string }
  | { type: 'result'; messages: Message[]; usage: Usage | null; sessionId: string }
  | { type: 'done' };

export type AgentSessionStatus = 'idle' | 'running' | 'waiting_for_user' | 'completed' | 'failed';

export interface AgentSessionSnapshot {
  status: AgentSessionStatus;
  sessionId?: string;
  model?: string;
  cwd?: string;
  assistantText: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  pendingUserQuestion?: UserQuestionRequest;
  agents: AgentRecord[];
  evidence: EvidenceItem[];
  messages: Message[];
  usage: Usage | null;
  error?: string;
}

export function createAgentSessionSnapshot(): AgentSessionSnapshot {
  return {
    status: 'idle',
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    agents: [],
    evidence: [],
    messages: [],
    usage: null,
  };
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

export function reduceAgentSessionSnapshot(
  snapshot: AgentSessionSnapshot,
  event: AgentEvent,
): AgentSessionSnapshot {
  switch (event.type) {
    case 'system':
      return { ...snapshot, status: 'running', model: event.model, cwd: event.cwd };
    case 'session':
      return { ...snapshot, sessionId: event.sessionId };
    case 'text':
      return {
        ...snapshot,
        status: 'running',
        assistantText: snapshot.assistantText + event.content,
      };
    case 'tool_use':
      return { ...snapshot, status: 'running', toolCalls: [...snapshot.toolCalls, event.toolCall] };
    case 'tool_result':
      return {
        ...snapshot,
        status: 'running',
        toolResults: [...snapshot.toolResults, event.toolResult],
      };
    case 'user_question':
      return event.status === 'pending'
        ? { ...snapshot, status: 'waiting_for_user', pendingUserQuestion: event.request }
        : snapshot;
    case 'user_question_result':
      return snapshot.pendingUserQuestion?.id === event.requestId
        ? { ...snapshot, status: 'running', pendingUserQuestion: undefined }
        : snapshot;
    case 'agent_start':
    case 'agent_update':
    case 'agent_result':
      return { ...snapshot, agents: upsertById(snapshot.agents, event.agent) };
    case 'agent_question':
    case 'agent_apply':
      return snapshot;
    case 'evidence_update':
      return { ...snapshot, evidence: upsertById(snapshot.evidence, event.evidence) };
    case 'error':
      return { ...snapshot, status: 'failed', error: event.error };
    case 'result':
      return {
        ...snapshot,
        status: 'running',
        sessionId: event.sessionId,
        messages: [...event.messages],
        usage: event.usage,
      };
    case 'done':
      return snapshot.status === 'failed' ? snapshot : { ...snapshot, status: 'completed' };
  }
}
