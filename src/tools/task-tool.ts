import type { ToolDefinition, ToolContext, ToolResult, AgentConfig } from '../types.js';
import { discoverAgents, runSubagent } from '../subagent.js';
import { createDefaultRegistry } from './registry.js';

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

  const agents = discoverAgents(ctx.workspaceRoot);
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `  - **${a.name}**: ${a.description}`).join('\n');
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `Subagent not found: "${agentName}".\nAvailable agents:\n${available || '  (none)'}`,
    };
  }

  if (!ctx.agentConfig) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error:
        'Task tool requires an active agent session. Use from within a tool execution context.',
    };
  }

  const registry = createDefaultRegistry();
  const { content, error } = await runSubagent(agent, prompt, ctx.agentConfig, registry, {
    signal: ctx.signal,
    parentToolTraceId: ctx.currentToolTraceId,
    nestedToolObserver: ctx.nestedToolObserver,
  });

  if (error) {
    return {
      toolCallId: '',
      success: false,
      output: content || '',
      error: `Subagent failed: ${error}`,
    };
  }

  return {
    toolCallId: '',
    success: true,
    output: `## Subagent result: ${agent.name}\n\n${content || '(no output)'}`,
  };
}

export const taskTool: ToolDefinition[] = [
  {
    name: 'Task',
    description:
      'Launch a subagent to handle a bounded subtask with isolated context. The subagent has its own tool allowlist and turn budget. Returns only the final result to the model; hosts may display its internal tool activity without adding it to the main conversation. Use this for focused investigations, code review, or multi-step work that should not pollute the main conversation.',
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
