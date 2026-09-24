import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import type { Message } from '../types/messages.js';
import type { AgentRecord } from '../agents/types.js';
import { AgentManagerError, getOrCreateAgentManager } from '../agents/manager.js';
import { toolFailure, toolSuccess } from './result.js';
import { deriveAgentDisplayName } from '../agents/naming.js';
import { projectAgentCompletion } from '../agents/projections.js';
import { resolveToolTimeoutMs } from './timeouts.js';

/**
 * Default ceiling on a foreground delegation. The registry's 120 s default
 * assumes a fast model; on a route where one max-effort turn takes minutes the
 * child was cut off mid-survey, its result discarded, and — because nothing
 * stopped it — it ran and billed for an hour afterwards (#215).
 * `BOOK_TOOL_TIMEOUT_MS` and `agents.taskTimeoutMs` still override it.
 */
const TASK_DEFAULT_TIMEOUT_MS = 1_800_000;

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);

function lastAssistantText(transcript: Message[]): string {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const message = transcript[index];
    if (message.role === 'assistant' && message.content) {
      return message.content.trim().slice(0, 4000);
    }
  }
  return '';
}

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
      // Task hands the child's result back as its own tool result, so a
      // completion notification only made the parent run another turn to re-read
      // it. A stopped child (ceiling or parent cancel) also opens a second
      // terminal generation as it unwinds, after any acknowledgement Task could
      // make. `/review` suppresses delivery the same way.
      notifyParentOnCompletion: false,
    });
    const spawnedAt = Date.now();
    const timeoutMs = resolveToolTimeoutMs({
      configured: ctx.agentConfig?.settings.agents?.taskTimeoutMs,
      env: ctx.env,
      fallback: TASK_DEFAULT_TIMEOUT_MS,
    });
    const onParentAbort = () => {
      void manager.stop(spawned.id, 'parent cancelled').catch(() => undefined);
    };
    // A cancel that landed while `spawn` was still running has already fired; a
    // listener added now would never run, and the child would go on to the ceiling.
    if (ctx.signal?.aborted) onParentAbort();
    else ctx.signal?.addEventListener('abort', onParentAbort, { once: true });
    let completed: AgentRecord;
    try {
      completed = await manager.wait(spawned.id, timeoutMs);
    } finally {
      ctx.signal?.removeEventListener('abort', onParentAbort);
    }
    if (!TERMINAL_TASK_STATUSES.has(completed.status)) {
      // The ceiling passed with the child still running. Stop it — a child nobody
      // is waiting for keeps running and billing otherwise — and hand the parent
      // what exists so far, so the work is continued rather than redone.
      completed = await manager.stop(spawned.id, `Task ceiling of ${timeoutMs}ms reached`);
      const partial = projectAgentCompletion(completed);
      const lastText = lastAssistantText(completed.transcript);
      return toolFailure(
        `Subagent ${completed.displayName ?? completed.name} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`,
        {
          code: 'subagent_timeout',
          content: [
            `Partial result (the child was stopped; nothing below is final):`,
            lastText ? `\nLast assistant text:\n${lastText}` : '',
            partial.summary ? `\nSummary so far:\n${partial.summary}` : '',
            `\nUse AgentRead with agentId ${completed.id} for the summary or error the child recorded when it stopped; raise agents.taskTimeoutMs or BOOK_TOOL_TIMEOUT_MS for a slower model.`,
          ]
            .filter(Boolean)
            .join('\n'),
          data: partial,
        },
      );
    }
    const settledAt = Date.now();
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
    timeoutMs: (ctx) =>
      resolveToolTimeoutMs({
        configured: ctx.agentConfig?.settings.agents?.taskTimeoutMs,
        env: ctx.env,
        fallback: TASK_DEFAULT_TIMEOUT_MS,
      }),
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
