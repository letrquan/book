import type { ToolContext, ToolDefinition, ToolResult } from '../types/tools.js';
import { AgentManagerError, getOrCreateAgentManager } from '../agents/manager.js';
import type {
  AgentStopOutcome,
  AgentTopology,
  AgentSummary,
  EvidenceKind,
  EvidenceReference,
  IssueQuality,
} from '../agents/types.js';
import { toolFailure, toolSuccess } from './result.js';
import { projectAgentResult, projectAgentSummary } from '../agents/projections.js';
import { MAX_TOOL_TIMEOUT_MS, toolTimeoutCeilingMs } from './timeouts.js';

/**
 * What a spawn actually returns, said in words.
 *
 * The result is otherwise a bare record whose only hint is `"status": "queued"`,
 * and a model reading it goes on to announce findings the child has not produced
 * -- observed in the TUI as a lead printing "Sidekick reported. Done." 1.8s into
 * a 6.1s run. The record stays machine-readable; this rides in front of it.
 */
const SPAWN_PENDING_NOTE =
  'This agent has only been queued. Its result is NOT in this response and does not exist yet. ' +
  'A completion is delivered to you when it finishes. Until that arrives, do not state, summarize, ' +
  'or imply anything it found. Call AgentWait to block on it, or continue with other work.';

function ok(
  output: unknown,
  presentation?: { summary: string; target?: string; metadata?: string[] },
  note?: string,
): ToolResult {
  const body = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  const content = note ? `${note}\n\n${body}` : body;
  return toolSuccess(content, {
    data: output,
    presentation: presentation
      ? {
          kind: 'agent',
          summary: presentation.summary,
          target: presentation.target,
          metadata: presentation.metadata,
          details: content,
        }
      : undefined,
  });
}

function compactText(value: string | undefined, fallback: string): string {
  const text = value?.split(/\r?\n/, 1)[0]?.trim();
  if (!text) return fallback;
  return text.length > 96 ? `${text.slice(0, 93).trimEnd()}...` : text;
}

export function agentStatusPresentation(agent: AgentSummary, action?: string) {
  const terminal = ['completed', 'failed', 'stopped', 'interrupted'].includes(agent.status);
  const status = agent.status.replace('_', ' ');
  const detail =
    agent.status === 'completed'
      ? compactText(agent.summary, 'Completed')
      : agent.status === 'failed'
        ? compactText(agent.error, 'Failed')
        : terminal
          ? status
          : compactText(agent.currentActivity?.label, status);
  return {
    summary: action ? `${action} ${agent.displayName}` : `${agent.displayName}: ${detail}`,
    target: agent.profile,
    metadata: action ? [status] : [agent.resolvedModel],
  };
}

function fail(error: unknown): ToolResult {
  if (error instanceof AgentManagerError) {
    return toolFailure(error.message, {
      code: error.code,
      retryable: error.retryable,
      remediation: error.remediation,
      details: error.details,
    });
  }
  return toolFailure(error instanceof Error ? error.message : String(error));
}

function manager(ctx: ToolContext) {
  // Child loops must use the parent-owned manager; root loops go through the
  // factory so cached managers refresh config, mode, and event sinks per turn.
  if (ctx.agentManager && ctx.agentId) return ctx.agentManager;
  if (!ctx.agentConfig || !ctx.availableTools) {
    throw new Error('Managed agent tools require an active root agent session.');
  }
  return getOrCreateAgentManager(ctx.agentConfig, ctx.availableTools, {
    eventSink: ctx.onAgentEvent,
    hookEventSink: ctx.onHookEvent,
    runtime: ctx.runtime,
    permissionMode: ctx.currentMode,
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
    const plan = await manager(ctx).createPlan({
      taskShape,
      rationale,
      issueQuality,
      topology,
      agentBudget: budget,
      parentSessionId: ctx.parentSessionId,
      rootRunId: ctx.runContext?.rootRunId,
      parentRunId: ctx.runContext?.runId,
    });
    return ok(plan, {
      summary: `Planned ${plan.topology.replaceAll('_', ' ')} delegation`,
      metadata: [`budget ${plan.agentBudget}`],
    });
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
      ...(ctx.peerTurnClass !== undefined ? { peerTurnClass: ctx.peerTurnClass } : {}),
      agent,
      description: typeof args.description === 'string' ? args.description.trim() : undefined,
      prompt,
      model: typeof args.model === 'string' ? args.model.trim() : undefined,
      planId: typeof args.planId === 'string' ? args.planId : undefined,
      evidenceIds: Array.isArray(args.evidenceIds)
        ? args.evidenceIds.filter((value): value is string => typeof value === 'string')
        : undefined,
      parentSessionId: ctx.parentSessionId,
      rootRunId: ctx.runContext?.rootRunId,
      parentRunId: ctx.runContext?.runId,
    });
    const summary = projectAgentSummary(record);
    return ok(summary, agentStatusPresentation(summary, 'Spawned'), SPAWN_PENDING_NOTE);
  } catch (error) {
    return fail(error);
  }
}

async function agentList(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    const agents = (await manager(ctx).list()).map(projectAgentSummary);
    return ok(agents, {
      summary: `Listed ${agents.length} managed ${agents.length === 1 ? 'agent' : 'agents'}`,
    });
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
    const result = projectAgentResult(record);
    return ok(result, agentStatusPresentation(result));
  } catch (error) {
    return fail(error);
  }
}

async function agentRead(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    const id = typeof args.agentId === 'string' ? args.agentId : '';
    const record = await manager(ctx).get(id);
    if (!record) throw new Error(`Agent ${id} was not found.`);
    const field = args.field === 'error' ? 'error' : 'summary';
    const value = field === 'error' ? (record.error ?? '') : (record.result ?? '');
    const offset = Math.max(0, Math.floor(typeof args.offset === 'number' ? args.offset : 0));
    const requestedLimit = Math.floor(typeof args.limit === 'number' ? args.limit : 16 * 1024);
    const limit = Math.max(1, Math.min(requestedLimit, 50 * 1024));
    const text = value.slice(offset, offset + limit);
    const nextOffset = offset + text.length < value.length ? offset + text.length : undefined;
    const output = {
      agentId: record.id,
      field,
      text,
      offset,
      nextOffset,
      totalCharacters: value.length,
      truncated: nextOffset !== undefined,
    };
    return ok(output, {
      summary: `Read ${field} from ${record.displayName ?? record.name}`,
      metadata: [`${offset}-${offset + text.length} of ${value.length}`],
    });
  } catch (error) {
    return fail(error);
  }
}

async function agentSend(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    const summary = projectAgentSummary(
      await manager(ctx).send(
        typeof args.agentId === 'string' ? args.agentId : '',
        typeof args.message === 'string' ? args.message : '',
        Array.isArray(args.evidenceIds)
          ? args.evidenceIds.filter((value): value is string => typeof value === 'string')
          : [],
        ctx.runContext,
      ),
    );
    return ok(summary, agentStatusPresentation(summary, 'Sent follow-up to'));
  } catch (error) {
    return fail(error);
  }
}

async function agentWait(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    const requested = typeof args.timeoutMs === 'number' ? args.timeoutMs : 0;
    // The wait must end before the registry's backstop does, or a long wait lands as a
    // contentless tool_timeout instead of the agent's current status (#423). Refused rather
    // than clamped above the ceiling, as BashOutput refuses an over-limit wait_ms.
    const ceiling = toolTimeoutCeilingMs(ctx.env);
    if (requested > ceiling) {
      return toolFailure(
        `timeoutMs ${requested}ms exceeds the ${ceiling}ms limit in force here (BOOK_TOOL_TIMEOUT_MS). ` +
          `Re-run with a timeoutMs at or below ${ceiling}ms.`,
      );
    }
    const managed = manager(ctx);
    const waited = await managed.wait(
      typeof args.agentId === 'string' ? args.agentId : '',
      // Omitted or 0 means "until it finishes", which the ceiling bounds.
      requested > 0 ? requested : ceiling,
      ctx.signal,
    );
    if (['completed', 'failed', 'stopped', 'interrupted'].includes(waited.status)) {
      await managed.acknowledgeCompletion(`${waited.id}:${waited.completionSequence ?? 0}`);
    }
    const result = projectAgentResult(waited);
    return ok(result, agentStatusPresentation(result));
  } catch (error) {
    return fail(error);
  }
}

/** What a model's stop did with the applies of the agent that were running, said in words. */
function appliesNote(outcome: AgentStopOutcome): string | undefined {
  // One id per apply, and two applies of one candidate name it twice: each is named once, with the
  // count of applies saying how they divide where it does not match the ids named.
  const evidence = (ids: string[]) => {
    const unique = Array.from(new Set(ids));
    if (unique.length === ids.length) return `(evidence ${unique.join(', ')})`;
    if (unique.length === 1) {
      return `(${ids.length === 2 ? 'both' : `all ${ids.length}`} of evidence ${unique[0]})`;
    }
    return `(${ids.length} applies across evidence ${unique.join(', ')})`;
  };
  const notes: string[] = [];
  const stopped = outcome.stoppedApplies;
  if (stopped.length === 1) {
    notes.push(
      `Stopped the AgentApply apply of this agent's result that was running ${evidence(stopped)}; it has ended.`,
    );
  } else if (stopped.length > 1) {
    notes.push(
      `Stopped the ${stopped.length} AgentApply applies of this agent's result that were running ${evidence(stopped)}; they have ended.`,
    );
  }
  const kept = outcome.keptUserApplies;
  if (kept.length === 1) {
    notes.push(
      `A user-started apply of this agent's result ${evidence(kept)} is still running on this agent and was not stopped: only the user can stop it.`,
    );
  } else if (kept.length > 1) {
    notes.push(
      `${kept.length} user-started applies of this agent's result ${evidence(kept)} are still running on this agent and were not stopped: only the user can stop them.`,
    );
  }
  return notes.length > 0 ? notes.join('\n') : undefined;
}

async function agentStop(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    requireRoot(ctx);
    // The model's stop leaves running an apply the user started (#527).
    const outcome = await manager(ctx).stop(
      typeof args.agentId === 'string' ? args.agentId : '',
      typeof args.reason === 'string' ? args.reason : 'requested',
      { keepUserApplies: true },
    );
    const summary = projectAgentSummary(outcome.agent);
    return ok(summary, agentStatusPresentation(summary, 'Stopped'), appliesNote(outcome));
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
        { signal: ctx.signal, startedBy: 'model' },
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
      'Queue an isolated managed agent and return immediately. Do not add a prose narration after calling this tool; the host renders the activity and delivers its compact result automatically. Use AgentWait only when an explicit synchronization barrier is needed.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        description: {
          type: 'string',
          description: 'Concise 3-6 word purpose name for this run',
        },
        prompt: {
          type: 'string',
          description:
            'Self-contained task with one objective, narrow scope, and an explicit concise deliverable.',
        },
        model: { type: 'string' },
        planId: { type: 'string' },
        evidenceIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['agent', 'description', 'prompt'],
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
      'Inspect compact managed-agent status or completion metadata. Child transcripts remain host-only.',
    parameters: {
      type: 'object',
      properties: { agentId: agentIdParameter },
      required: ['agentId'],
    },
    execute: agentGet,
  },
  {
    name: 'AgentRead',
    description:
      'Read a bounded chunk of a managed agent final summary or error. Use when AgentGet reports truncated output.',
    parameters: {
      type: 'object',
      properties: {
        agentId: agentIdParameter,
        field: {
          type: 'string',
          enum: ['summary', 'error'],
          description: 'Terminal field to read. Defaults to summary.',
        },
        offset: {
          type: 'number',
          minimum: 0,
          description: 'Zero-based character offset. Defaults to 0.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 51200,
          description: 'Maximum characters to return. Defaults to 16384 and is capped at 51200.',
        },
      },
      required: ['agentId'],
    },
    execute: agentRead,
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
    description:
      'Wait for a managed agent to finish or until timeoutMs elapses. Completion delivery is automatic; use this only as an explicit synchronization barrier.',
    // The wait is this tool's own deadline, so the registry's backstop sits
    // SELF_TIMEOUT_GRACE_MS behind it, as for BashOutput's wait_ms.
    timeoutMs: MAX_TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: {
        agentId: agentIdParameter,
        timeoutMs: {
          type: 'number',
          minimum: 0,
          maximum: MAX_TOOL_TIMEOUT_MS,
          description: `How long to wait, in milliseconds (maximum ${MAX_TOOL_TIMEOUT_MS}). Omit it to wait until the agent finishes, up to that limit. A wait that ends before the agent does returns its current status.`,
        },
      },
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
