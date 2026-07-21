import type { AgentRuntimeEvent } from '../agents/types.js';
import { runAgentLoop } from '../agent/loop.js';
import type { ToolRegistry } from '../tools/registry.js';
import type {
  AgentConfig,
  AgentLoopCallbacks,
  Message,
  PermissionMode,
  ToolCall,
  ToolResult,
  Usage,
  UserQuestionResponse,
} from '../types.js';
import { AgentInteractionController } from './agent-interactions.js';
import {
  AgentSessionOperations,
  type AgentSessionOperation,
  type CancelOperationResult,
} from './agent-session-operations.js';
import type { AgentEvent } from './agent-events.js';

export type AgentLoopRunner = typeof runAgentLoop;
type AgentLoopOptions = NonNullable<Parameters<AgentLoopRunner>[6]>;

export interface AgentSessionRunCallbacks {
  onEvent: (event: AgentEvent) => void;
  onTurnStart: AgentLoopCallbacks['onTurnStart'];
  onDone?: AgentLoopCallbacks['onDone'];
  onUsage?: AgentLoopCallbacks['onUsage'];
  onModeChange?: AgentLoopCallbacks['onModeChange'];
  onCompact?: AgentLoopCallbacks['onCompact'];
  onAssistantMessageComplete?: AgentLoopCallbacks['onAssistantMessageComplete'];
  onTodos?: AgentLoopCallbacks['onTodos'];
  onRetry?: AgentLoopCallbacks['onRetry'];
  onStreamStall?: AgentLoopCallbacks['onStreamStall'];
  onStreamResume?: AgentLoopCallbacks['onStreamResume'];
  onPersistPermissionRule?: AgentLoopCallbacks['onPersistPermissionRule'];
  onHookEvent?: AgentLoopCallbacks['onHookEvent'];
}

export interface AgentSessionRunRequest {
  config: AgentConfig;
  registry: ToolRegistry;
  prompt: string;
  history: Message[];
  mode?: PermissionMode;
  sessionId: string;
  callbacks: AgentSessionRunCallbacks;
  options?: Omit<AgentLoopOptions, 'signal'>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export interface AgentSessionCancelResult {
  operation: CancelOperationResult;
  interactions: ReturnType<AgentInteractionController['cancelAll']>;
}

export interface AgentSessionDependencies {
  runLoop?: AgentLoopRunner;
}

/** Shared owner for agent-loop execution, interaction promises, and operation lifetime. */
export class AgentSession {
  readonly interactions = new AgentInteractionController();
  readonly operations = new AgentSessionOperations();
  private readonly runLoop: AgentLoopRunner;

  constructor(dependencies: AgentSessionDependencies = {}) {
    this.runLoop = dependencies.runLoop ?? runAgentLoop;
  }

  startSend(): AgentSessionOperation | null {
    return this.operations.tryStart('send', true);
  }

  cancel(via: string): AgentSessionCancelResult {
    return {
      operation: this.operations.cancel(),
      interactions: this.interactions.cancelAll(via),
    };
  }

  reset(via: string): void {
    this.interactions.cancelAll(via);
    this.operations.reset();
  }

  async run(request: AgentSessionRunRequest): Promise<Message[]> {
    const { callbacks } = request;
    let usage: Usage | null = null;
    let emittedError: string | undefined;
    const emit = callbacks.onEvent;

    try {
      const messages = await this.runLoop(
        request.config,
        request.registry,
        request.prompt,
        request.history,
        {
          onText: (content: string) => emit({ type: 'text', content }),
          onToolCall: (toolCall: ToolCall) => emit({ type: 'tool_use', toolCall }),
          onToolResult: (toolResult: ToolResult) => emit({ type: 'tool_result', toolResult }),
          onError: (error: string) => {
            emittedError = error;
            emit({ type: 'error', error });
          },
          onTurnStart: callbacks.onTurnStart,
          onDone: callbacks.onDone ?? (() => {}),
          onPermissionRequired: (toolCall) =>
            request.isCurrent?.() === false
              ? Promise.resolve('deny')
              : this.interactions.requestPermission(toolCall),
          onPlanApprovalRequired: (plan) =>
            request.isCurrent?.() === false
              ? Promise.resolve('reject')
              : this.interactions.requestPlanApproval(plan),
          onUserQuestionRequired: async (question): Promise<UserQuestionResponse> => {
            if (request.isCurrent?.() === false) {
              return { action: 'cancel', message: 'Session changed.' };
            }
            emit({ type: 'user_question', request: question, status: 'pending' });
            const response = await this.interactions.requestUserQuestion(question);
            emit({ type: 'user_question_result', requestId: question.id, response });
            return response;
          },
          onUsage: (nextUsage) => {
            usage = nextUsage;
            callbacks.onUsage?.(nextUsage);
          },
          onModeChange: callbacks.onModeChange,
          onCompact: callbacks.onCompact,
          onAssistantMessageComplete: callbacks.onAssistantMessageComplete,
          onTodos: callbacks.onTodos,
          onRetry: callbacks.onRetry,
          onStreamStall: callbacks.onStreamStall,
          onStreamResume: callbacks.onStreamResume,
          onPersistPermissionRule: callbacks.onPersistPermissionRule,
          onHookEvent: callbacks.onHookEvent,
          onAgentEvent: (event: AgentRuntimeEvent) => emit(event),
        },
        request.mode,
        { ...request.options, signal: request.signal },
      );
      emit({ type: 'result', messages, usage, sessionId: request.sessionId });
      return messages;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (emittedError !== message) emit({ type: 'error', error: message });
      throw error;
    } finally {
      emit({ type: 'done' });
    }
  }
}
