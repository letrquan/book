import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { AgentManagerError, getOrCreateAgentManager } from '../agents/manager.js';
import { toolFailure, toolSuccess } from './result.js';
import { deriveAgentDisplayName } from '../agents/naming.js';
import { projectAgentCompletion } from '../agents/projections.js';

/**
 * Wall-clock breakdown of one foreground delegation round trip.
 *
 * `overheadMs` is the part the harness owns — admission, profile resolution,
 * store writes, isolation setup and the wait plumbing — as distinct from the
 * child's own run. It is the number that decides whether a lead/sidekick split
 * is affordable interactively, and the one no vendor publishes.
 */
function delegationTiming(
  requestedAt: number,
  spawnedAt: number,
  settledAt: number,
  completed: { startedAt?: number; finishedAt?: number },
): {
  requestedAt: number;
  spawnMs: number;
  queuedMs: number;
  childRunMs: number;
  roundTripMs: number;
  overheadMs: number;
} {
  const roundTripMs = Math.max(0, settledAt - requestedAt);
  const spawnMs = Math.max(0, spawnedAt - requestedAt);
  const childStart = completed.startedAt ?? spawnedAt;
  const childEnd = completed.finishedAt ?? settledAt;
  const queuedMs = Math.max(0, childStart - spawnedAt);
  const childRunMs = Math.max(0, childEnd - childStart);
  return {
    requestedAt,
    spawnMs,
    queuedMs,
    childRunMs,
    roundTripMs,
    overheadMs: Math.max(0, roundTripMs - childRunMs),
  };
}

async function task(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const agentName = args.agent as string;
  const prompt = args.prompt as string;

  if (!agentName) {
    return toolFailure("Missing required 'agent' argument");
  }
  if (!prompt) {
    return toolFailure("Missing required 'prompt' argument");
  }

  if (!ctx.agentConfig || !ctx.availableTools) {
    return toolFailure(
      'Task tool requires an active agent session. Use from within a tool execution context.',
    );
  }

  if (ctx.agentId) {
    return toolFailure('Task is unavailable inside managed child agents.', {
      code: 'child_agent_unavailable',
      status: 'blocked',
    });
  }

  try {
    const manager = getOrCreateAgentManager(ctx.agentConfig, ctx.availableTools, {
      eventSink: ctx.onAgentEvent,
      hookEventSink: ctx.onHookEvent,
      runtime: ctx.runtime,
      permissionMode: ctx.currentMode,
    });
    const requestedAt = Date.now();
    const spawned = await manager.spawn({
      agent: agentName,
      description: deriveAgentDisplayName(prompt, agentName),
      prompt,
      parentSessionId: ctx.parentSessionId,
      rootRunId: ctx.runContext?.rootRunId,
      parentRunId: ctx.runContext?.runId,
      // Publish the link before blocking. `wait` below does not return until the
      // child is finished, so this is the only moment at which the transcript can
      // learn which child this row is waiting on.
      parentToolCallId: ctx.currentToolTraceId,
    });
    const spawnedAt = Date.now();
    const completed = await manager.wait(spawned.id);
    const settledAt = Date.now();
    if (['completed', 'failed', 'stopped', 'interrupted'].includes(completed.status)) {
      await manager.acknowledgeCompletion(`${completed.id}:${completed.completionSequence ?? 0}`);
    }
    const projection = projectAgentCompletion(completed);
    const resultField = completed.status === 'completed' || !completed.error ? 'summary' : 'error';
    const resultText =
      resultField === 'summary' ? projection.summary : (projection.error ?? projection.summary);
    const resultTruncated =
      resultField === 'summary'
        ? projection.summaryTruncated
        : (projection.errorTruncated ?? projection.summaryTruncated);
    const resultCharacters =
      resultField === 'summary'
        ? projection.summaryCharacters
        : (projection.errorCharacters ?? projection.summaryCharacters);
    const recovery = resultTruncated
      ? `\n\n[Result truncated at ${resultText?.length ?? 0} of ${resultCharacters} characters. Use AgentRead with agentId ${completed.id} and field ${resultField}.]`
      : '';
    if (completed.status !== 'completed') {
      return toolFailure(resultText ?? `Subagent ended with status ${completed.status}`, {
        content: `${resultText ?? ''}${recovery}`,
        code: 'subagent_failed',
        data: projection,
      });
    }
    return toolSuccess(
      `## Subagent result: ${completed.displayName ?? completed.name}\n\n${resultText || '(no output)'}${recovery}`,
      {
        data: {
          ...projection,
          delegation: delegationTiming(requestedAt, spawnedAt, settledAt, completed),
        },
      },
    );
  } catch (error) {
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
}

export const taskTool: ToolDefinition[] = [
  {
    name: 'Task',
    description:
      'Deprecated synchronous adapter for AgentSpawn followed by AgentWait. Prefer the managed agent lifecycle tools.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description:
            'Name of the subagent definition to invoke (from .book/agents/ or ~/.book/agents/)',
        },
        prompt: {
          type: 'string',
          description: 'The task prompt for the subagent',
        },
      },
      required: ['agent', 'prompt'],
    },
    execute: task,
  },
];
