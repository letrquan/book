import type { ToolDefinition, ToolContext, ToolResult, ToolCall } from '../types.js';
import { fileTools } from './file.js';
import { shellTools } from './shell.js';
import { gitTools } from './git.js';
import { designTools } from './design.js';
import { browserTools } from './browser.js';

export function createRegistry() {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      tools.set(tool.name, tool);
    },

    registerAll(toolList: ToolDefinition[]): void {
      for (const t of toolList) {
        tools.set(t.name, t);
      }
    },

    getTool(name: string): ToolDefinition | undefined {
      return tools.get(name);
    },

    getDefinitions(): ToolDefinition[] {
      return Array.from(tools.values());
    },

    async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
      const tool = tools.get(call.name);
      if (!tool) {
        return {
          toolCallId: call.id,
          success: false,
          output: '',
          error: `Unknown tool: ${call.name}`,
        };
      }

      try {
        return await tool.execute(call.arguments, context);
      } catch (e) {
        return {
          toolCallId: call.id,
          success: false,
          output: '',
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}

export function createDefaultRegistry(): ReturnType<typeof createRegistry> {
  const registry = createRegistry();
  registry.registerAll([...fileTools, ...shellTools, ...gitTools, ...designTools, ...browserTools]);
  return registry;
}

export type ToolRegistry = ReturnType<typeof createRegistry>;
