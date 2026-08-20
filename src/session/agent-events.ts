import type { AgentRecord, AgentRuntimeEvent, EvidenceItem } from '../agents/types.js';
import type { HostCommandResult } from '../types/commands.js';
import type { Message, Usage } from '../types/messages.js';
import type { AgentRunAmbientSnapshot, AgentRunContext, AgentRunResult } from '../types/runs.js';
import type { ShellJobEvent } from '../jobs/shell-manager.js';
import { isTerminalStatus, type AgentTerminalOutcome } from '../types/terminal.js';
import type {
  ToolCall,
  ToolResult,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../types/tools.js';

export type AgentEvent =
  | { type: 'run_started'; context: AgentRunContext; ambient: AgentRunAmbientSnapshot }
  | { type: 'system'; model: string; cwd: string }
  | { type: 'session'; sessionId: string }
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_use'; toolCall: ToolCall }
  | { type: 'tool_result'; toolResult: ToolResult }
  | { type: 'user_question'; request: UserQuestionRequest; status: 'pending' | 'unavailable' }
  | { type: 'user_question_result'; requestId: string; response: UserQuestionResponse }
  | ShellJobEvent
  | { type: 'agent_start'; agent: AgentRecord }
  | { type: 'agent_update'; agent: AgentRecord }
  | { type: 'agent_result'; agent: AgentRecord }
  | Extract<
      AgentRuntimeEvent,
      {
        type:
          | 'agent_question'
          | 'agent_apply'
          | 'agent_status'
          | 'agent_activity'
          | 'agent_text_delta'
          | 'agent_message'
          | 'agent_completion'
          | 'agent_permission'
          | 'agent_persistence'
          | 'skill_lifecycle';
      }
    >
  | { type: 'evidence_update'; evidence: EvidenceItem }
  | { type: 'error'; error: string }
  | {
      type: 'result';
      messages: Message[];
      usage: Usage | null;
      sessionId: string;
      outcome?: AgentTerminalOutcome;
      runContext?: AgentRunContext;
      runs?: AgentRunResult[];
      /**
       * Slash commands the host performed itself rather than sending to the
       * model. Present for SDK callers, whose stdout is a discard sink and who
       * would otherwise have no way to read a `/review` they paid for.
       */
      commandResults?: HostCommandResult[];
    }
  | { type: 'terminal'; outcome: AgentTerminalOutcome; runContext?: AgentRunContext }
  | { type: 'done' };

export type AgentSessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted';

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
  terminal?: AgentTerminalOutcome;
  runContext?: AgentRunContext;
  ambient?: AgentRunAmbientSnapshot;
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
  if (isTerminalStatus(snapshot.status) && event.type !== 'terminal') return snapshot;

  switch (event.type) {
    case 'run_started':
      return {
        ...snapshot,
        status: 'running',
        runContext: event.context,
        ambient: event.ambient,
      };
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
    case 'reasoning':
      return { ...snapshot, status: 'running' };
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
    case 'agent_status':
    case 'agent_activity':
    case 'agent_text_delta':
    case 'agent_message':
    case 'agent_completion':
    case 'agent_permission':
    case 'agent_persistence':
    case 'skill_lifecycle':
    case 'background_job_start':
    case 'background_job_update':
    case 'background_job_output':
    case 'background_job_result':
    case 'background_job_dismiss':
      return snapshot;
    case 'evidence_update':
      return { ...snapshot, evidence: upsertById(snapshot.evidence, event.evidence) };
    case 'error':
      return { ...snapshot, error: event.error };
    case 'result':
      return {
        ...snapshot,
        sessionId: event.sessionId,
        messages: [...event.messages],
        usage: event.usage,
        runContext: event.runContext ?? snapshot.runContext,
      };
    case 'terminal':
      if (isTerminalStatus(snapshot.status)) return snapshot;
      return {
        ...snapshot,
        status: event.outcome.status,
        terminal: event.outcome,
        runContext: event.runContext ?? snapshot.runContext,
        error:
          event.outcome.status === 'failed' || event.outcome.status === 'timed_out'
            ? event.outcome.message
            : snapshot.error,
      };
    case 'done':
      return isTerminalStatus(snapshot.status)
        ? snapshot
        : {
            ...snapshot,
            status: 'interrupted',
            terminal: {
              status: 'interrupted',
              reason: 'missing_terminal',
              partialOutput: snapshot.assistantText.length > 0 || snapshot.messages.length > 0,
            },
          };
  }
}
