import type { PermissionMode, ToolContext, ToolDefinition, ToolResult } from '../types.js';
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
  'AgentWait',
  'AgentPlan',
  'AgentSpawn',
  'AgentSend',
  'AgentStop',
]);

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
