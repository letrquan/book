import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { getOrCreateAgentManager } from '../agents/manager.js';

async function task(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const agentName = args.agent as string;
  const prompt = args.prompt as string;

  if (!agentName) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: "Missing required 'agent' argument",
    };
  }
  if (!prompt) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: "Missing required 'prompt' argument",
    };
  }

  if (!ctx.agentConfig || !ctx.availableTools) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error:
        'Task tool requires an active agent session. Use from within a tool execution context.',
    };
  }

  if (ctx.agentId) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: 'Task is unavailable inside managed child agents.',
    };
  }

  try {
    const manager = getOrCreateAgentManager(ctx.agentConfig, ctx.availableTools, {
      eventSink: ctx.onAgentEvent,
      hookEventSink: ctx.onHookEvent,
    });
    const spawned = await manager.spawn({
      agent: agentName,
      prompt,
      parentSessionId: ctx.parentSessionId,
    });
    const completed = await manager.wait(spawned.id);
    if (completed.status !== 'completed') {
      return {
        toolCallId: '',
        success: false,
        output: completed.result ?? '',
        error: completed.error ?? `Subagent ended with status ${completed.status}`,
      };
    }
    return {
      toolCallId: '',
      success: true,
      output: `## Subagent result: ${completed.name}\n\n${completed.result || '(no output)'}`,
    };
  } catch (error) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
    };
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
