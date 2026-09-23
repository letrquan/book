import type { PermissionMode } from '../types/runtime.js';
import type {
  PlanApprovalResult,
  PlanNotAppliedReason,
  ToolContext,
  ToolDefinition,
  ToolResult,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../types/tools.js';
import { validateUserQuestionResponse } from './ask-user-question.js';
import { toolFailure, toolSuccess } from './result.js';

export const READ_ONLY_PLAN_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'GitStatus',
  'GitDiff',
  'GitLog',
  'GitBranch',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'TaskList',
  'TaskGet',
  'BashOutput',
  'SessionHistorySearch',
  'SessionHistoryRead',
  'ToolSearch',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'AgentList',
  'AgentGet',
  'AgentRead',
  'AgentWait',
  'AgentPlan',
  'AgentSpawn',
  'AgentSend',
  'AgentStop',
]);

/** Read-only network calls remain available in plan mode but still require approval. */
export const PLAN_PERMISSION_REQUIRED_TOOLS = new Set(['WebFetch', 'WebSearch']);

function ok(output: string): ToolResult {
  return toolSuccess(output);
}

function fail(error: string): ToolResult {
  return toolFailure(error);
}

function currentMode(ctx: ToolContext): PermissionMode {
  return ctx.currentMode ?? 'default';
}

async function enterPlanMode(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const mode = currentMode(ctx);
  if (mode === 'plan') {
    return ok(
      'Already in plan mode. Read-only tools are auto-approved and mutating tools are blocked.',
    );
  }

  ctx.previousMode = mode;
  ctx.currentMode = 'plan';
  ctx.pendingPlanApproval = undefined;
  return ok(
    'Plan mode activated. Read-only tools are auto-approved. Mutating tools are blocked until ExitPlanMode submits a plan and the user approves it.',
  );
}

async function exitPlanMode(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const plan = typeof args.plan === 'string' ? args.plan.trim() : '';
  if (!plan) return fail('plan must be a non-empty string');

  ctx.pendingPlanApproval = { plan };
  return ok(
    'Plan submitted for user approval. Wait for the approval result before making changes.',
  );
}

/**
 * Plan approval in a non-interactive host.
 *
 * A host without an approver (print/headless/SDK with no handler) cannot answer
 * "may I apply this plan?". Rejecting is wrong there: the model revises and
 * resubmits until the turn budget is gone. These helpers express the plan
 * decision as a regular AskUserQuestion request so a programmatic host answers
 * it through the one handler it already supplies, and give hosts with no
 * handler a single terminal `stop` decision instead.
 */
export const PLAN_APPROVAL_QUESTION_PREFIX =
  'Approve this plan and apply the changes it describes?';
export const PLAN_APPROVAL_APPROVE_LABEL = 'Approve';
export const PLAN_APPROVAL_REJECT_LABEL = 'Reject';
/** Keeps the rendered question inside the 500-character AskUserQuestion limit. */
const PLAN_APPROVAL_SUMMARY_LIMIT = 400;

/** One question, one non-empty answer: the plan-approval spelling of the user-question contract. */
export function buildPlanApprovalQuestion(plan: string, id: string): UserQuestionRequest {
  const trimmed = plan.trim();
  const summary =
    trimmed.length > PLAN_APPROVAL_SUMMARY_LIMIT
      ? `${trimmed.slice(0, PLAN_APPROVAL_SUMMARY_LIMIT)}…`
      : trimmed;
  return {
    id,
    questions: [
      {
        question: summary
          ? `${PLAN_APPROVAL_QUESTION_PREFIX}\n\n${summary}`
          : PLAN_APPROVAL_QUESTION_PREFIX,
        header: 'Plan',
        options: [
          {
            label: PLAN_APPROVAL_APPROVE_LABEL,
            description: 'Leave plan mode and apply this plan.',
          },
          {
            label: PLAN_APPROVAL_REJECT_LABEL,
            description:
              'Do not apply this plan. The agent revises it and submits a new plan for approval.',
          },
        ],
        multiSelect: false,
      },
    ],
    source: { kind: 'root' },
  };
}

export function planNotAppliedMessage(reason: PlanNotAppliedReason, detail?: string): string {
  const base =
    reason === 'approval_unavailable'
      ? 'No changes were applied: the plan could not be approved because this non-interactive host has no plan approver.'
      : reason === 'approval_declined'
        ? 'No changes were applied: the host declined to approve the plan.'
        : reason === 'approval_cancelled'
          ? 'No changes were applied: plan approval was cancelled before a decision was made.'
          : 'No changes were applied: the plan approval response did not follow the user-question contract.';
  return detail ? `${base} (${detail})` : base;
}

export function planStopDecision(
  reason: PlanNotAppliedReason,
  detail?: string,
): Extract<PlanApprovalResult, { decision: 'stop' }> {
  return { decision: 'stop', reason, message: planNotAppliedMessage(reason, detail) };
}

/**
 * Map a UserQuestionResponse onto a plan decision. `decline`/`cancel`/invalid
 * responses are terminal on purpose — a host that will not decide must not put
 * the agent into an ExitPlanMode retry loop.
 */
export function planApprovalFromUserQuestionResponse(
  request: UserQuestionRequest,
  response: UserQuestionResponse,
): PlanApprovalResult {
  if (response.action === 'decline') return planStopDecision('approval_declined', response.message);
  if (response.action === 'cancel') return planStopDecision('approval_cancelled', response.message);

  const invalid = validateUserQuestionResponse(request, response);
  if (invalid) return planStopDecision('invalid_approval_response', invalid);

  // Validation above guarantees a single non-empty string for this question.
  const raw = response.answers[request.questions[0]?.question ?? ''];
  const answer = typeof raw === 'string' ? raw.trim() : '';
  if (!answer) return planStopDecision('invalid_approval_response', 'empty answer');
  const normalized = answer.toLocaleLowerCase();
  if (normalized === PLAN_APPROVAL_APPROVE_LABEL.toLocaleLowerCase()) return 'approve';
  if (normalized === PLAN_APPROVAL_REJECT_LABEL.toLocaleLowerCase()) return 'reject';
  // Free-text ("Other") answers are the host's revision feedback.
  return { decision: 'revise', feedback: answer };
}

export const planModeTools: ToolDefinition[] = [
  {
    name: 'EnterPlanMode',
    description:
      'Enter plan mode. In plan mode, read-only tools are auto-approved and mutating tools are blocked until a plan is approved.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Optional reason for entering plan mode' },
      },
      required: [],
    },
    execute: enterPlanMode,
  },
  {
    name: 'ExitPlanMode',
    description:
      'Submit the current implementation plan for user approval and leave plan mode only if the user approves it.',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'The plan to present for user approval' },
      },
      required: ['plan'],
    },
    execute: exitPlanMode,
  },
];
