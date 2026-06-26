import type { ToolDefinition, ToolContext, ToolResult, ToolCall } from '../types.js';
import { fileTools } from './file.js';
import { shellTools } from './shell.js';
import { gitTools } from './git.js';

/** Legacy tool-name aliases, resolved to their canonical CC-style names at execute time. */
const ALIASES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  multi_edit: 'MultiEdit',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
};

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
      return tools.get(ALIASES[name] ?? name);
    },

    getDefinitions(): ToolDefinition[] {
      return Array.from(tools.values());
    },

    async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
      const tool = tools.get(ALIASES[call.name] ?? call.name);
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
  registry.registerAll([...fileTools, ...shellTools, ...gitTools]);
  return registry;
}

export type ToolRegistry = ReturnType<typeof createRegistry>;
