import type { ToolDefinition, ToolContext, ToolResult, ToolCall } from '../types.js';
import { fileTools } from './file.js';
import { shellTools } from './shell.js';
import { gitTools } from './git.js';
import { todoTools } from './todo.js';
import { webTools } from './web.js';
import { skillsTool } from './skills-tool.js';
import { taskTool } from './task-tool.js';
import { TOOL_ALIASES } from './aliases.js';

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
      return tools.get(TOOL_ALIASES[name] ?? name);
    },

    getDefinitions(): ToolDefinition[] {
      return Array.from(tools.values());
    },

    async execute(call: ToolCall, context: ToolContext, maxRetries: number = 0): Promise<ToolResult> {
      const tool = tools.get(TOOL_ALIASES[call.name] ?? call.name);
      if (!tool) {
        return {
          toolCallId: call.id,
          success: false,
          output: '',
          error: `Unknown tool: ${call.name}`,
        };
      }

      // Default tool timeout: 120s, falling back to per-tool or explicit timeout.
      const toolTimeoutMs = (call.arguments.timeout as number)
        ?? (context.env?.BOOK_TOOL_TIMEOUT_MS ? Number(context.env.BOOK_TOOL_TIMEOUT_MS) : 120_000);

      // Only retry idempotent tools.
      const retries = tool.idempotent ? maxRetries : 0;

      let lastResult: ToolResult | null = null;

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const result = await Promise.race([
            tool.execute(call.arguments, context),
            new Promise<ToolResult>((resolve) => {
              setTimeout(() => {
                resolve({
                  toolCallId: call.id,
                  success: false,
                  output: '',
                  error: `Tool timeout: ${tool.name} exceeded ${toolTimeoutMs}ms`,
                });
              }, toolTimeoutMs);
            }),
          ]);

          if (result.success) {
            if (attempt > 0) {
              result.retryAttempt = attempt + 1;
            }
            return result;
          }

          // Don't retry on SKIPPED results (permission/hook blocks).
          if (result.error?.startsWith('SKIPPED')) {
            return result;
          }

          lastResult = result;
          // Fall through to retry if attempts remain.
        } catch (e) {
          lastResult = {
            toolCallId: call.id,
            success: false,
            output: '',
            error: e instanceof Error ? e.message : String(e),
          };
          // Fall through to retry if attempts remain.
        }

        // Small fixed delay before retry with jitter.
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
        }
      }

      return lastResult!;
    },
  };
}

export function createDefaultRegistry(): ReturnType<typeof createRegistry> {
  const registry = createRegistry();
  registry.registerAll([...fileTools, ...shellTools, ...gitTools, ...todoTools, ...webTools, ...skillsTool, ...taskTool]);
  return registry;
}

export type ToolRegistry = ReturnType<typeof createRegistry>;
