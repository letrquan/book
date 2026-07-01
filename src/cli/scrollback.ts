import { createInterface } from 'node:readline/promises';
import type { AgentConfig, AgentLoopCallbacks, Message, PermissionMode, ToolCall, ToolResult } from '../types.js';
import { runAgentLoop } from '../agent/loop.js';
import { createDefaultRegistry, type ToolRegistry } from '../tools/registry.js';
import { getPrimaryArg } from '../tools/primary-arg.js';

export interface ScrollbackOptions {
  mode: PermissionMode;
  input?: NodeJS.ReadableStream;
  output?: { write: (s: string) => boolean | void };
  readPrompt?: () => Promise<string | null>;
  runLoop?: typeof runAgentLoop;
  registry?: ToolRegistry;
}

export function formatToolCall(call: ToolCall): string {
  const primary = getPrimaryArg(call.arguments);
  return `\n[tool] ${call.name}${primary ? ` ${primary}` : ''}\n`;
}

export function formatToolResult(result: ToolResult, call?: ToolCall): string {
  const label = result.success ? '[OK]' : '[ERR]';
  const name = call?.name ?? 'tool';
  const primary = call ? getPrimaryArg(call.arguments) : '';
  const detail = result.success ? result.output : result.error ?? '';
  return `${label} ${name}${primary ? ` ${primary}` : ''}${detail ? `\n${detail.trimEnd()}` : ''}\n`;
}

export async function runScrollbackSession(
  config: AgentConfig,
  options: ScrollbackOptions,
): Promise<Message[]> {
  const output = options.output ?? process.stdout;
  const registry = options.registry ?? createDefaultRegistry();
  const runLoop = options.runLoop ?? runAgentLoop;
  const history: Message[] = [];
  const toolCalls = new Map<string, ToolCall>();
  const close = createPromptReader(options);

  output.write('Book scrollback mode. Terminal scrollback owns history. Type /exit to quit.\n\n');

  try {
    while (true) {
      const prompt = await close.read('You> ');
      if (prompt === null) break;
      const trimmed = prompt.trim();
      if (!trimmed) continue;
      if (trimmed === '/exit') break;
      if (trimmed === '/clear') {
        history.length = 0;
        output.write('[cleared]\n');
        continue;
      }

      output.write('\nBook\n');
      const updated = await runLoop(config, registry, prompt, history, {
        onText: (text) => output.write(text),
        onToolCall: (call) => {
          toolCalls.set(call.id, call);
          output.write(formatToolCall(call));
        },
        onToolResult: (result) => output.write(formatToolResult(result, toolCalls.get(result.toolCallId))),
        onError: (error) => output.write(`\n[error] ${error}\n`),
        onTurnStart: (turn) => {
          if (turn > 1) output.write(`\nBook turn ${turn}\n`);
        },
        onDone: () => output.write('\n'),
        onPermissionRequired: (call) => askPermission(call, close.read, output),
        onUsage: () => {},
      } satisfies AgentLoopCallbacks, options.mode);

      history.length = 0;
      history.push(...updated);
      output.write('\n');
    }
  } finally {
    close.close();
  }

  return history;
}

function createPromptReader(options: ScrollbackOptions): {
  read: (prompt?: string) => Promise<string | null>;
  close: () => void;
} {
  if (options.readPrompt) return { read: () => options.readPrompt?.() ?? Promise.resolve(null), close: () => {} };

  const rl = createInterface({
    input: options.input ?? process.stdin,
    output: process.stdout,
  });

  return {
    read: (prompt = 'You> ') => rl.question(prompt),
    close: () => rl.close(),
  };
}

async function askPermission(
  call: ToolCall,
  read: (prompt?: string) => Promise<string | null>,
  output: { write: (s: string) => boolean | void },
): Promise<'allow' | 'deny' | 'always'> {
  output.write(`[permission] ${call.name}${getPrimaryArg(call.arguments) ? ` ${getPrimaryArg(call.arguments)}` : ''}\nAllow? [y]es/[n]o/[a]lways: `);
  const answer = (await read(''))?.trim().toLowerCase();
  if (answer === 'a' || answer === 'always') return 'always';
  if (answer === 'y' || answer === 'yes') return 'allow';
  return 'deny';
}
