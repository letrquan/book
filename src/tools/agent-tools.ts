import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { getOrCreateAgentManager } from '../agents/manager.js';
import type {
  AgentTopology,
  EvidenceKind,
  EvidenceReference,
  IssueQuality,
} from '../agents/types.js';

function ok(output: unknown): ToolResult {
  return {
    toolCallId: '',
    success: true,
    output: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
  };
}

function fail(error: unknown): ToolResult {
  return {
    toolCallId: '',
    success: false,
    output: '',
    error: error instanceof Error ? error.message : String(error),
  };
}

function manager(ctx: ToolContext) {
  if (!ctx.agentConfig || !ctx.availableTools) {
    throw new Error('Managed agent tools require an active root agent session.');
  }
  return getOrCreateAgentManager(ctx.agentConfig, ctx.availableTools, {
    eventSink: ctx.onAgentEvent,
    hookEventSink: ctx.onHookEvent,
  });
}

function requireRoot(ctx: ToolContext): void {
  if (ctx.agentId) throw new Error('Managed child agents cannot access lifecycle tools.');
}

async function agentPlan(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    const taskShape = typeof args.taskShape === 'string' ? args.taskShape.trim() : '';
    const rationale = typeof args.rationale === 'string' ? args.rationale.trim() : '';
    if (!taskShape || !rationale) throw new Error('taskShape and rationale are required.');
    const issueQuality = args.issueQuality as IssueQuality;
    const topology = args.topology as AgentTopology;
    if (!['clear', 'ambiguous', 'unknown'].includes(issueQuality)) {
      throw new Error('issueQuality must be clear, ambiguous, or unknown.');
    }
    if (
      !['single', 'parallel_research', 'explore_then_patch', 'patch_validate'].includes(topology)
    ) {
      throw new Error('topology is invalid.');
    }
    const budget = typeof args.agentBudget === 'number' ? args.agentBudget : 1;
    return ok(
      await manager(ctx).createPlan({
        taskShape,
        rationale,
        issueQuality,
        topology,
        agentBudget: budget,
        parentSessionId: ctx.parentSessionId,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

async function agentSpawn(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    const agent = typeof args.agent === 'string' ? args.agent.trim() : '';
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!agent || !prompt) throw new Error('agent and prompt are required.');
    const record = await manager(ctx).spawn({
      agent,
      prompt,
      planId: typeof args.planId === 'string' ? args.planId : undefined,
      evidenceIds: Array.isArray(args.evidenceIds)
        ? args.evidenceIds.filter((value): value is string => typeof value === 'string')
        : undefined,
      parentSessionId: ctx.parentSessionId,
    });
    return ok({ agentId: record.id, status: record.status, role: record.role });
  } catch (error) {
    return fail(error);
  }
}

async function agentList(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    return ok(await manager(ctx).list());
  } catch (error) {
    return fail(error);
  }
}

async function agentGet(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    const id = typeof args.agentId === 'string' ? args.agentId : '';
    const record = await manager(ctx).get(id);
    if (!record) throw new Error(`Agent ${id} was not found.`);
    return ok(record);
  } catch (error) {
    return fail(error);
  }
}

async function agentSend(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    return ok(
      await manager(ctx).send(
        typeof args.agentId === 'string' ? args.agentId : '',
        typeof args.message === 'string' ? args.message : '',
        Array.isArray(args.evidenceIds)
          ? args.evidenceIds.filter((value): value is string => typeof value === 'string')
          : [],
      ),
    );
  } catch (error) {
    return fail(error);
  }
}

async function agentWait(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    return ok(
      await manager(ctx).wait(
        typeof args.agentId === 'string' ? args.agentId : '',
        typeof args.timeoutMs === 'number' ? args.timeoutMs : 0,
      ),
    );
  } catch (error) {
    return fail(error);
  }
}

async function agentStop(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    return ok(
      await manager(ctx).stop(
        typeof args.agentId === 'string' ? args.agentId : '',
        typeof args.reason === 'string' ? args.reason : 'requested',
      ),
    );
  } catch (error) {
    return fail(error);
  }
}

async function agentApply(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    if (ctx.currentMode === 'plan') throw new Error('AgentApply is unavailable in plan mode.');
    return ok(
      await manager(ctx).apply(
        typeof args.agentId === 'string' ? args.agentId : '',
        typeof args.evidenceId === 'string' ? args.evidenceId : undefined,
      ),
    );
  } catch (error) {
    return fail(error);
  }
}

async function evidencePublish(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    if (!ctx.agentId) throw new Error('EvidencePublish is available only inside a managed agent.');
    const kind = args.kind as EvidenceKind;
    if (!['finding', 'hypothesis', 'test_result', 'patch_candidate', 'blocker'].includes(kind)) {
      throw new Error('kind is invalid.');
    }
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (!summary) throw new Error('summary is required.');
    const references = Array.isArray(args.references)
      ? args.references.filter(
          (value): value is EvidenceReference =>
            typeof value === 'object' &&
            value !== null &&
            typeof (value as EvidenceReference).type === 'string' &&
            typeof (value as EvidenceReference).value === 'string',
        )
      : [];
    return ok(
      await manager(ctx).publishEvidence(ctx.agentId, {
        kind,
        summary,
        confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
        references,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

async function evidenceList(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    return ok(
      await manager(ctx).listEvidence({
        requesterAgentId: ctx.agentId,
        includeUnverified: args.includeUnverified === true,
        ids: Array.isArray(args.ids)
          ? args.ids.filter((value): value is string => typeof value === 'string')
          : undefined,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

async function evidenceReview(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    if (!ctx.agentId) throw new Error('EvidenceReview is available only inside a managed agent.');
    if (!['pass', 'fail', 'inconclusive'].includes(args.verdict as string)) {
      throw new Error('verdict must be pass, fail, or inconclusive.');
    }
    return ok(
      await manager(ctx).reviewEvidence(
        ctx.agentId,
        typeof args.evidenceId === 'string' ? args.evidenceId : '',
        args.verdict as 'pass' | 'fail' | 'inconclusive',
        typeof args.notes === 'string' ? args.notes : undefined,
      ),
    );
  } catch (error) {
    return fail(error);
  }
}

const agentIdParameter = { type: 'string', description: 'Managed agent ID' };

export const agentLifecycleTools: ToolDefinition[] = [
  {
    name: 'AgentPlan',
    description:
      "Record the parent model's delegation route, issue quality, rationale, and bounded agent budget before spawning.",
    parameters: {
      type: 'object',
      properties: {
        taskShape: { type: 'string' },
        issueQuality: { type: 'string', enum: ['clear', 'ambiguous', 'unknown'] },
        topology: {
          type: 'string',
          enum: ['single', 'parallel_research', 'explore_then_patch', 'patch_validate'],
        },
        rationale: { type: 'string' },
        agentBudget: { type: 'number', minimum: 0 },
      },
      required: ['taskShape', 'issueQuality', 'topology', 'rationale', 'agentBudget'],
    },
    execute: agentPlan,
  },
  {
    name: 'AgentSpawn',
    description:
      'Queue an isolated managed agent and return immediately. Use AgentWait or AgentGet to collect results.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        prompt: { type: 'string' },
        planId: { type: 'string' },
        evidenceIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['agent', 'prompt'],
    },
    execute: agentSpawn,
  },
  {
    name: 'AgentList',
    description: 'List managed agents for the current repository.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: agentList,
  },
  {
    name: 'AgentGet',
    description:
      'Inspect a managed agent, including transcript, evidence references, and patch state.',
    parameters: {
      type: 'object',
      properties: { agentId: agentIdParameter },
      required: ['agentId'],
    },
    execute: agentGet,
  },
  {
    name: 'AgentSend',
    description:
      'Queue a follow-up, answer a pending question, or resume an interrupted managed agent.',
    parameters: {
      type: 'object',
      properties: {
        agentId: agentIdParameter,
        message: { type: 'string' },
        evidenceIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['agentId', 'message'],
    },
    execute: agentSend,
  },
  {
    name: 'AgentWait',
    description: 'Wait for a managed agent to finish or until timeoutMs elapses.',
    parameters: {
      type: 'object',
      properties: { agentId: agentIdParameter, timeoutMs: { type: 'number', minimum: 0 } },
      required: ['agentId'],
    },
    execute: agentWait,
  },
  {
    name: 'AgentStop',
    description: 'Stop a queued or running managed agent without stopping other agents.',
    parameters: {
      type: 'object',
      properties: { agentId: agentIdParameter, reason: { type: 'string' } },
      required: ['agentId'],
    },
    execute: agentStop,
  },
  {
    name: 'AgentApply',
    description:
      'Apply an exact patch candidate only after a distinct validator passes it. Unavailable in plan mode and child agents.',
    parameters: {
      type: 'object',
      properties: { agentId: agentIdParameter, evidenceId: { type: 'string' } },
      required: ['agentId'],
    },
    execute: agentApply,
  },
];

export const evidenceTools: ToolDefinition[] = [
  {
    name: 'EvidencePublish',
    description:
      'Publish a typed, referenced evidence item to the managed repository evidence store.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['finding', 'hypothesis', 'test_result', 'patch_candidate', 'blocker'],
        },
        summary: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        references: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['file', 'command', 'diff', 'commit'] },
              value: { type: 'string' },
            },
            required: ['type', 'value'],
          },
        },
      },
      required: ['kind', 'summary'],
    },
    execute: evidencePublish,
  },
  {
    name: 'EvidenceList',
    description:
      'List verified evidence, or explicitly requested unverified evidence for validators.',
    parameters: {
      type: 'object',
      properties: {
        includeUnverified: { type: 'boolean' },
        ids: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
    execute: evidenceList,
  },
  {
    name: 'EvidenceReview',
    description:
      "As a distinct validator, record pass, fail, or inconclusive for another agent's evidence.",
    parameters: {
      type: 'object',
      properties: {
        evidenceId: { type: 'string' },
        verdict: { type: 'string', enum: ['pass', 'fail', 'inconclusive'] },
        notes: { type: 'string' },
      },
      required: ['evidenceId', 'verdict'],
    },
    execute: evidenceReview,
  },
];
