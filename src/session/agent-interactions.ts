import type {
  ElicitationRequest,
  ElicitationResponse,
  PermissionDecision,
  PermissionResult,
  PlanApprovalResult,
  ToolCall,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../types/tools.js';
import { createDebugLoggerWithCounter } from '../debug-log.js';

const log = createDebugLoggerWithCounter('session:interactions');

export interface PendingPermissionRequest {
  readonly toolCall: ToolCall;
}

export interface PendingPlanApprovalRequest {
  readonly plan: string;
}

export interface PendingUserQuestionRequest {
  readonly request: UserQuestionRequest;
}

export interface PendingElicitationRequest {
  readonly request: ElicitationRequest;
}

export interface AgentInteractionSnapshot {
  readonly pendingPermission: PendingPermissionRequest | null;
  readonly pendingPlanApproval: PendingPlanApprovalRequest | null;
  readonly pendingUserQuestions: readonly PendingUserQuestionRequest[];
  readonly pendingElicitations: readonly PendingElicitationRequest[];
}

interface PendingPermission extends PendingPermissionRequest {
  resolve: (decision: PermissionResult | PermissionDecision) => void;
}

interface PendingPlanApproval extends PendingPlanApprovalRequest {
  resolve: (result: PlanApprovalResult) => void;
}

interface PendingUserQuestion extends PendingUserQuestionRequest {
  resolve: (result: UserQuestionResponse) => void;
}

interface PendingElicitation extends PendingElicitationRequest {
  resolve: (result: ElicitationResponse) => void;
}

export interface CancelInteractionResult {
  permission: boolean;
  planApproval: boolean;
  userQuestions: number;
  elicitations: number;
}

type InteractionListener = (snapshot: AgentInteractionSnapshot) => void;

function snapshotOf(
  permission: PendingPermission | null,
  planApproval: PendingPlanApproval | null,
  userQuestions: PendingUserQuestion[],
  elicitations: PendingElicitation[],
): AgentInteractionSnapshot {
  return Object.freeze({
    pendingPermission: permission ? Object.freeze({ toolCall: permission.toolCall }) : null,
    pendingPlanApproval: planApproval ? Object.freeze({ plan: planApproval.plan }) : null,
    pendingUserQuestions: Object.freeze(
      userQuestions.map((entry) => Object.freeze({ request: entry.request })),
    ),
    pendingElicitations: Object.freeze(
      elicitations.map((entry) => Object.freeze({ request: entry.request })),
    ),
  });
}

/** Owns interactive request promises independently from any UI framework. */
export class AgentInteractionController {
  private pendingPermission: PendingPermission | null = null;
  private pendingPermissionQueue: PendingPermission[] = [];
  private pendingPlanApproval: PendingPlanApproval | null = null;
  private pendingUserQuestions: PendingUserQuestion[] = [];
  private pendingElicitations: PendingElicitation[] = [];
  private snapshot = snapshotOf(null, null, [], []);
  private readonly listeners = new Set<InteractionListener>();

  getSnapshot(): AgentInteractionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: InteractionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  requestPermission(toolCall: ToolCall): Promise<PermissionResult | PermissionDecision> {
    return new Promise((resolve) => {
      const request = { toolCall, resolve };
      if (this.pendingPermission) {
        this.pendingPermissionQueue.push(request);
        log.event('permission:queued', {
          tool: toolCall.name,
          id: toolCall.id,
          queueLength: this.pendingPermissionQueue.length,
        });
      } else {
        this.pendingPermission = request;
        this.publish();
        log.event('permission:pending', { tool: toolCall.name, id: toolCall.id });
      }
    });
  }

  settlePermission(result: PermissionResult | PermissionDecision, via: string): boolean {
    const pending = this.pendingPermission;
    if (!pending) {
      log.event('permission:settled:noop', { reason: 'no-pending', result, via });
      return false;
    }
    this.pendingPermission = this.pendingPermissionQueue.shift() ?? null;
    this.publish();
    log.event('permission:settled', {
      tool: pending.toolCall.name,
      id: pending.toolCall.id,
      result,
      via,
    });
    pending.resolve(result);
    return true;
  }

  private cancelPermissions(via: string): boolean {
    const pending = [
      ...(this.pendingPermission ? [this.pendingPermission] : []),
      ...this.pendingPermissionQueue,
    ];
    if (pending.length === 0) return false;
    this.pendingPermission = null;
    this.pendingPermissionQueue = [];
    this.publish();
    for (const request of pending) request.resolve('deny');
    log.event('permission:cancelled-all', { via, count: pending.length });
    return true;
  }

  requestPlanApproval(plan: string): Promise<PlanApprovalResult> {
    if (this.pendingPlanApproval) this.settlePlanApproval('reject', 'superseded');
    return new Promise((resolve) => {
      this.pendingPlanApproval = { plan, resolve };
      this.publish();
      log.event('plan-approval:pending', { len: plan.length });
    });
  }

  settlePlanApproval(result: PlanApprovalResult, via: string): boolean {
    const pending = this.pendingPlanApproval;
    if (!pending) {
      log.event('plan-approval:settled:noop', { reason: 'no-pending', result, via });
      return false;
    }
    this.pendingPlanApproval = null;
    this.publish();
    log.event('plan-approval:settled', { result, via, len: pending.plan.length });
    pending.resolve(result);
    return true;
  }

  requestUserQuestion(request: UserQuestionRequest): Promise<UserQuestionResponse> {
    if (this.pendingUserQuestions.some((entry) => entry.request.id === request.id)) {
      return Promise.resolve({
        action: 'cancel',
        message: `Duplicate user question request: ${request.id}`,
      });
    }
    return new Promise((resolve) => {
      this.pendingUserQuestions = [...this.pendingUserQuestions, { request, resolve }];
      this.publish();
      log.event('user-question:pending', {
        id: request.id,
        count: request.questions.length,
        queueLength: this.pendingUserQuestions.length,
        source: request.source.kind,
      });
    });
  }

  settleUserQuestion(result: UserQuestionResponse, via: string, requestId?: string): boolean {
    const index = requestId
      ? this.pendingUserQuestions.findIndex((entry) => entry.request.id === requestId)
      : 0;
    if (index < 0 || this.pendingUserQuestions.length === 0) {
      log.event('user-question:settled:noop', { reason: 'no-pending', via, requestId });
      return false;
    }

    const next = [...this.pendingUserQuestions];
    const [pending] = next.splice(index, 1);
    this.pendingUserQuestions = next;
    this.publish();
    log.event('user-question:settled', {
      id: pending.request.id,
      action: result.action,
      via,
      remaining: next.length,
    });
    pending.resolve(result);
    return true;
  }

  cancelUserQuestions(via: string): number {
    const pending = this.pendingUserQuestions;
    if (pending.length === 0) return 0;
    this.pendingUserQuestions = [];
    this.publish();
    for (const entry of pending) {
      entry.resolve({ action: 'cancel', message: `Question cancelled via ${via}.` });
    }
    log.event('user-question:cancelled-all', { via, count: pending.length });
    return pending.length;
  }

  /**
   * Queue an MCP elicitation. The server request behind it stays open until
   * this settles, so every exit path must resolve it — see cancelAll.
   */
  requestElicitation(request: ElicitationRequest): Promise<ElicitationResponse> {
    if (this.pendingElicitations.some((entry) => entry.request.id === request.id)) {
      return Promise.resolve({ action: 'cancel' });
    }
    return new Promise((resolve) => {
      this.pendingElicitations = [...this.pendingElicitations, { request, resolve }];
      this.publish();
      log.event('elicitation:pending', {
        id: request.id,
        server: request.server,
        fields: request.fields.length,
        queueLength: this.pendingElicitations.length,
      });
    });
  }

  settleElicitation(result: ElicitationResponse, via: string, requestId?: string): boolean {
    const index = requestId
      ? this.pendingElicitations.findIndex((entry) => entry.request.id === requestId)
      : 0;
    if (index < 0 || this.pendingElicitations.length === 0) {
      log.event('elicitation:settled:noop', { reason: 'no-pending', via, requestId });
      return false;
    }

    const next = [...this.pendingElicitations];
    const [pending] = next.splice(index, 1);
    this.pendingElicitations = next;
    this.publish();
    log.event('elicitation:settled', {
      id: pending.request.id,
      action: result.action,
      via,
      remaining: next.length,
    });
    pending.resolve(result);
    return true;
  }

  cancelElicitations(via: string): number {
    const pending = this.pendingElicitations;
    if (pending.length === 0) return 0;
    this.pendingElicitations = [];
    this.publish();
    for (const entry of pending) entry.resolve({ action: 'cancel' });
    log.event('elicitation:cancelled-all', { via, count: pending.length });
    return pending.length;
  }

  cancelAll(via: string): CancelInteractionResult {
    return {
      permission: this.cancelPermissions(via),
      planApproval: this.settlePlanApproval('reject', via),
      userQuestions: this.cancelUserQuestions(via),
      elicitations: this.cancelElicitations(via),
    };
  }

  private publish(): void {
    this.snapshot = snapshotOf(
      this.pendingPermission,
      this.pendingPlanApproval,
      this.pendingUserQuestions,
      this.pendingElicitations,
    );
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
