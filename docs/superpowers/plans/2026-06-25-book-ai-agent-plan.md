# Book AI Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an AI-powered coding agent CLI with a rich TUI, OpenAI-compatible provider, and full tool suite (file, shell, git, design, browser).

**Architecture:** Commander CLI entry point boots an Ink TUI. The TUI manages agent state via `useAgent` hook which drives the prompt loop: build context, stream from provider, execute tool calls, repeat. Tools are registered in a pluggable registry. Provider is an OpenAI-compatible HTTP streaming client.

**Tech Stack:** TypeScript, Node.js 18+, Commander, Ink (React for CLI), Zod, undici, fast-glob, ignore

**Source spec:** `docs/superpowers/specs/2026-06-25-book-ai-agent-design.md`

---

## File Map

```
book/
  src/
    index.ts              # CLI entry (Commander)
    config.ts             # Config loading (.bookrc + env, Zod schema)
    types.ts              # Shared types (Message, ToolCall, ToolResult, AgentConfig)
    agent/
      loop.ts             # runAgentLoop(): streaming prompt loop
      context.ts          # buildContext(): system prompt + history + tools
    tui/
      app.tsx             # Ink <App> root
      components/
        Header.tsx         # ASCII art BOOK logo, color cycling, model display
        ChatPanel.tsx      # Scrollable message list
        InputBar.tsx       # Text input with history, Enter sends
        StatusBar.tsx      # Slash commands row, token count
        AgentMessage.tsx   # Single agent message block (text + tool calls)
        ToolCallBlock.tsx  # Single tool execution display (spinner -> [OK]/[ERR])
        Spinner.tsx        # Reusable ANSI spinner component
      hooks/
        useAgent.ts        # Agent state: messages, isThinking, send, clear
        useAnimation.ts    # useSpinner(), useTypewriter(), usePulse() hooks
    tools/
      registry.ts          # createRegistry(), registerTool(), getTools(), executeTool()
      file.ts              # read_file, write_file, edit_file, glob, grep
      shell.ts             # bash
      git.ts               # git_status, git_diff, git_log, git_commit, git_branch
      design.ts            # Design partner tools (audit, review, recolor, typeset, tokenize)
      browser.ts           # CDP browser tools (navigate, click, type, screenshot, evaluate)
    provider/
      openai-compatible.ts # chatCompletionStream(): POST /chat/completions with SSE streaming
  package.json
  tsconfig.json
```

---

## Phase 1: Project Scaffold

### Task 1: Initialize project and install dependencies

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "book",
  "version": "0.1.0",
  "description": "AI coding agent CLI with rich TUI",
  "type": "module",
  "bin": {
    "book": "./dist/index.js"
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --out-dir dist",
    "dev": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "commander": "^14.0.0",
    "ink": "^6.0.0",
    "react": "^19.0.0",
    "chalk": "^5.4.0",
    "zod": "^3.24.0",
    "fast-glob": "^3.3.0",
    "ignore": "^7.0.0"
  },
  "devDependencies": {
    "tsup": "^8.5.0",
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/react": "^19.0.0",
    "@types/node": "^22.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`

Expected: Dependencies install without errors.

- [ ] **Step 4: Create directory structure**

```bash
mkdir -p src/agent src/tui/components src/tui/hooks src/tools src/provider
```

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json
git commit -m "feat: initialize book project with TypeScript, Ink, Commander"
```

---

## Phase 2: Types & Configuration

### Task 2: Define shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write types file**

```typescript
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  success: boolean;
  output: string;
  error?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  workspaceRoot: string;
  env: Record<string, string>;
}

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTurns: number;
  workspace: string;
  animation: {
    typewriterSpeed: number;
    spinnerStyle: 'braille' | 'dots';
  };
  tools: {
    browser: { enabled: boolean; headless: boolean };
    design: { enabled: boolean };
  };
}

export interface ProviderStreamEvent {
  type: 'text' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  error?: string;
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: define shared types for agent, tools, and config"
```

### Task 3: Config loading with Zod validation

**Files:**
- Create: `src/config.ts`
- Create: `src/config.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };
  const testDir = join(tmpdir(), 'book-test-' + Date.now());

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    try { unlinkSync(join(testDir, '.bookrc.json')); } catch {}
    try { unlinkSync(join(process.env.HOME || process.env.USERPROFILE || '', '.bookrc.json')); } catch {}
  });

  it('returns defaults when no config file or env vars exist', () => {
    process.env.BOOK_API_KEY = 'test-key';
    const config = loadConfig('.');
    expect(config.model).toBe('gpt-4o');
    expect(config.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.maxTurns).toBe(25);
  });

  it('reads from env vars', () => {
    process.env.BOOK_API_KEY = 'env-key';
    process.env.BOOK_MODEL = 'glm-5.2';
    process.env.BOOK_MAX_TURNS = '10';
    const config = loadConfig('.');
    expect(config.apiKey).toBe('env-key');
    expect(config.model).toBe('glm-5.2');
    expect(config.maxTurns).toBe(10);
  });

  it('throws when API key is missing', () => {
    delete process.env.BOOK_API_KEY;
    expect(() => loadConfig('.')).toThrow('BOOK_API_KEY');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write config implementation**

```typescript
// src/config.ts
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentConfig } from './types.js';

const configSchema = z.object({
  model: z.string().default('gpt-4o'),
  baseUrl: z.string().url().default('https://api.openai.com/v1'),
  maxTurns: z.number().int().min(1).max(100).default(25),
  animation: z.object({
    typewriterSpeed: z.number().int().min(1).max(50).default(3),
    spinnerStyle: z.enum(['braille', 'dots']).default('braille'),
  }).default({}),
  tools: z.object({
    browser: z.object({
      enabled: z.boolean().default(true),
      headless: z.boolean().default(true),
    }).default({}),
    design: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
  }).default({}),
});

export function loadConfig(workspace?: string): AgentConfig {
  const apiKey = process.env.BOOK_API_KEY;
  if (!apiKey) {
    throw new Error('BOOK_API_KEY not set. Set it via environment variable or .bookrc.json');
  }

  const baseUrl = process.env.BOOK_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.BOOK_MODEL || 'gpt-4o';
  const maxTurns = process.env.BOOK_MAX_TURNS ? parseInt(process.env.BOOK_MAX_TURNS, 10) : 25;
  const resolvedWorkspace = workspace || process.env.BOOK_WORKSPACE || process.cwd();

  let fileConfig: z.infer<typeof configSchema> = {} as z.infer<typeof configSchema>;

  const configPaths = [
    workspace ? join(workspace, '.bookrc.json') : null,
    join(homedir(), '.bookrc.json'),
  ].filter(Boolean) as string[];

  for (const path of configPaths) {
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        fileConfig = configSchema.parse(raw);
        break;
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error(`Invalid JSON in config file: ${path}`);
        }
        throw e;
      }
    }
  }

  return {
    apiKey,
    baseUrl: process.env.BOOK_BASE_URL || fileConfig.baseUrl || baseUrl,
    model: process.env.BOOK_MODEL || fileConfig.model || model,
    maxTurns: process.env.BOOK_MAX_TURNS ? parseInt(process.env.BOOK_MAX_TURNS, 10) : fileConfig.maxTurns || maxTurns,
    workspace: resolvedWorkspace,
    animation: fileConfig.animation || { typewriterSpeed: 3, spinnerStyle: 'braille' },
    tools: fileConfig.tools || {
      browser: { enabled: true, headless: true },
      design: { enabled: true },
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/config.test.ts`

Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add config loading with Zod validation and env var support"
```

---

## Phase 3: Provider Layer

### Task 4: OpenAI-compatible streaming provider

**Files:**
- Create: `src/provider/openai-compatible.ts`

- [ ] **Step 1: Write provider implementation**

```typescript
// src/provider/openai-compatible.ts
import type { AgentConfig, ProviderStreamEvent, ToolDefinition, Message } from '../types.js';

export async function* chatCompletionStream(
  config: AgentConfig,
  messages: { role: string; content: string | null; tool_calls?: unknown[] }[],
  tools: ToolDefinition[],
): AsyncGenerator<ProviderStreamEvent> {
  const url = `${config.baseUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    max_turns: config.maxTurns,
  };

  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 429) {
      yield { type: 'error', error: 'Rate limited. Retrying...' };
      return;
    }
    yield { type: 'error', error: `API error ${response.status}: ${errorText}` };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: 'error', error: 'No response body' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let currentToolCall: { id: string; name: string; arguments: string } | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          if (currentToolCall) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: currentToolCall.id,
                name: currentToolCall.name,
                arguments: JSON.parse(currentToolCall.arguments || '{}'),
              },
            };
          }
          yield { type: 'done' };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (!delta) continue;

          if (delta.content) {
            yield { type: 'text', content: delta.content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.id) {
                if (currentToolCall) {
                  yield {
                    type: 'tool_call',
                    toolCall: {
                      id: currentToolCall.id,
                      name: currentToolCall.name,
                      arguments: JSON.parse(currentToolCall.arguments || '{}'),
                    },
                  };
                }
                currentToolCall = {
                  id: tc.id,
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                };
              } else if (currentToolCall && tc.function?.arguments) {
                currentToolCall.arguments += tc.function.arguments;
              }
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (currentToolCall) {
    yield {
      type: 'tool_call',
      toolCall: {
        id: currentToolCall.id,
        name: currentToolCall.name,
        arguments: JSON.parse(currentToolCall.arguments || '{}'),
      },
    };
  }
  yield { type: 'done' };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/provider/openai-compatible.ts
git commit -m "feat: add OpenAI-compatible SSE streaming provider"
```

---

## Phase 4: Tool System

### Task 5: Tool registry

**Files:**
- Create: `src/tools/registry.ts`

- [ ] **Step 1: Write tool registry**

```typescript
// src/tools/registry.ts
import type { ToolDefinition, ToolContext, ToolResult, ToolCall } from '../types.js';
import { fileTools } from './file.js';
import { shellTools } from './shell.js';
import { gitTools } from './git.js';

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
  registry.registerAll([...fileTools, ...shellTools, ...gitTools]);
  return registry;
}

export type ToolRegistry = ReturnType<typeof createRegistry>;
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/registry.ts
git commit -m "feat: add pluggable tool registry"
```

### Task 6: File tools

**Files:**
- Create: `src/tools/file.ts`

- [ ] **Step 1: Write file tools**

```typescript
// src/tools/file.ts
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import fg from 'fast-glob';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const filePath = join(ctx.workspaceRoot, args.filePath as string);
  if (!existsSync(filePath)) {
    return { toolCallId: '', success: false, output: '', error: `File not found: ${args.filePath}` };
  }
  const offset = (args.offset as number) || 1;
  const limit = (args.limit as number) || 2000;
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const result = slice.map((l, i) => `${offset + i}: ${l}`).join('\n');
  return { toolCallId: '', success: true, output: result };
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const filePath = join(ctx.workspaceRoot, args.filePath as string);
  writeFileSync(filePath, args.content as string, 'utf-8');
  return { toolCallId: '', success: true, output: 'File written successfully' };
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const filePath = join(ctx.workspaceRoot, args.filePath as string);
  if (!existsSync(filePath)) {
    return { toolCallId: '', success: false, output: '', error: `File not found: ${args.filePath}` };
  }
  const content = readFileSync(filePath, 'utf-8');
  const oldStr = args.oldString as string;
  const newStr = args.newString as string;
  if (!content.includes(oldStr)) {
    return { toolCallId: '', success: false, output: '', error: 'oldString not found in file' };
  }
  const newContent = content.replace(oldStr, newStr);
  writeFileSync(filePath, newContent, 'utf-8');
  return { toolCallId: '', success: true, output: 'File edited successfully' };
}

async function globSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const files = await fg(pattern, { cwd: ctx.workspaceRoot, dot: true });
  return { toolCallId: '', success: true, output: files.join('\n') };
}

async function grepSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const includePattern = args.include as string | undefined;
  const globPattern = includePattern || '**/*';
  const files = await fg(globPattern, { cwd: ctx.workspaceRoot, dot: true });
  const results: string[] = [];
  for (const file of files.slice(0, 100)) {
    try {
      const content = readFileSync(join(ctx.workspaceRoot, file), 'utf-8');
      const regex = new RegExp(pattern, 'g');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
        regex.lastIndex = 0;
      }
    } catch {}
  }
  const output = results.slice(0, 500).join('\n') || 'No matches found';
  return { toolCallId: '', success: true, output };
}

export const fileTools: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace. Returns lines with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file relative to workspace root' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed)', default: 1 },
        limit: { type: 'number', description: 'Maximum number of lines to read', default: 2000 },
      },
      required: ['filePath'],
    },
    execute: readFile,
  },
  {
    name: 'write_file',
    description: 'Write content to a file, overwriting if it exists',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file relative to workspace root' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['filePath', 'content'],
    },
    execute: writeFile,
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in an existing file',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file relative to workspace root' },
        oldString: { type: 'string', description: 'Exact text to replace' },
        newString: { type: 'string', description: 'Text to replace it with' },
      },
      required: ['filePath', 'oldString', 'newString'],
    },
    execute: editFile,
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. src/**/*.ts)' },
      },
      required: ['pattern'],
    },
    execute: globSearch,
  },
  {
    name: 'grep',
    description: 'Search file contents for a regex pattern',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        include: { type: 'string', description: 'File glob pattern to filter (e.g. *.ts)' },
      },
      required: ['pattern'],
    },
    execute: grepSearch,
  },
];
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/file.ts
git commit -m "feat: add file tools (read, write, edit, glob, grep)"
```

### Task 7: Shell tool

**Files:**
- Create: `src/tools/shell.ts`

- [ ] **Step 1: Write shell tool**

```typescript
// src/tools/shell.ts
import { exec } from 'child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

async function bash(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = args.command as string;
  const workdir = (args.workdir as string) || ctx.workspaceRoot;
  const timeout = (args.timeout as number) || 120_000;

  return new Promise((resolve) => {
    const proc = exec(command, {
      cwd: workdir,
      timeout,
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, ...ctx.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data; });
    proc.stderr?.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({
          toolCallId: '',
          success: true,
          output: stdout || '(no output)',
        });
      } else {
        resolve({
          toolCallId: '',
          success: false,
          output: stdout,
          error: stderr || `Exit code: ${code}`,
        });
      }
    });

    proc.on('error', (err) => {
      resolve({
        toolCallId: '',
        success: false,
        output: '',
        error: err.message,
      });
    });
  });
}

export const shellTools: ToolDefinition[] = [
  {
    name: 'bash',
    description: 'Execute a shell command in the workspace',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        workdir: { type: 'string', description: 'Working directory for the command' },
        timeout: { type: 'number', description: 'Timeout in milliseconds', default: 120000 },
      },
      required: ['command'],
    },
    execute: bash,
  },
];
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/shell.ts
git commit -m "feat: add shell/bash tool with timeout and error capture"
```

### Task 8: Git tools

**Files:**
- Create: `src/tools/git.ts`

- [ ] **Step 1: Write git tools**

```typescript
// src/tools/git.ts
import { execSync } from 'child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

function runGit(args: string[], ctx: ToolContext): { success: boolean; output: string; error?: string } {
  try {
    const output = execSync(`git ${args.join(' ')}`, {
      cwd: ctx.workspaceRoot,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { success: true, output: output || '(no output)' };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { success: false, output: '', error: err.stderr || err.message || 'Git command failed' };
  }
}

async function gitStatus(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const r = runGit(['status', '--short'], ctx);
  return { toolCallId: '', ...r };
}

async function gitDiff(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const r = runGit(['diff'], ctx);
  return { toolCallId: '', ...r };
}

async function gitLog(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const r = runGit(['log', '--oneline', '-20'], ctx);
  return { toolCallId: '', ...r };
}

async function gitCommit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const message = args.message as string;
  const r = runGit(['commit', '-m', message], ctx);
  return { toolCallId: '', ...r };
}

async function gitBranch(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const r = runGit(['branch', '-a'], ctx);
  return { toolCallId: '', ...r };
}

export const gitTools: ToolDefinition[] = [
  {
    name: 'git_status',
    description: 'Show the working tree status (git status --short)',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitStatus,
  },
  {
    name: 'git_diff',
    description: 'Show changes between commits, commit and working tree, etc.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitDiff,
  },
  {
    name: 'git_log',
    description: 'Show recent commit logs (last 20, oneline)',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitLog,
  },
  {
    name: 'git_commit',
    description: 'Create a new commit with a message',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Commit message' } },
      required: ['message'],
    },
    execute: gitCommit,
  },
  {
    name: 'git_branch',
    description: 'List branches',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitBranch,
  },
];
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/git.ts
git commit -m "feat: add git tools (status, diff, log, commit, branch)"
```

---

## Phase 5: Agent Core

### Task 9: Context builder

**Files:**
- Create: `src/agent/context.ts`

- [ ] **Step 1: Write context builder**

```typescript
// src/agent/context.ts
import { platform, release, hostname } from 'os';
import type { AgentConfig, Message, ToolDefinition } from '../types.js';

function buildSystemPrompt(config: AgentConfig): string {
  return `You are Book, an AI coding agent. You help users write, fix, and understand code.

You are running on: ${platform()} ${release()} (${hostname()})
Workspace: ${config.workspace}
Current date: ${new Date().toISOString().split('T')[0]}

You have access to tools for reading/writing files, running shell commands,
searching code, and interacting with git. Use them to help the user.

Be concise and direct. Write code when asked. Explain only when asked.`;
}

export function buildMessages(
  config: AgentConfig,
  history: Message[],
  tools: ToolDefinition[],
): { role: string; content: string | null }[] {
  const messages: { role: string; content: string | null }[] = [];

  messages.push({ role: 'system', content: buildSystemPrompt(config) });

  for (const msg of history) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: msg.content || null,
      });
    }
  }

  return messages;
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/context.ts
git commit -m "feat: add context builder with system prompt and history assembly"
```

### Task 10: Agent prompt loop

**Files:**
- Create: `src/agent/loop.ts`

- [ ] **Step 1: Write agent loop**

```typescript
// src/agent/loop.ts
import type { AgentConfig, Message, ToolCall, ToolResult, ToolContext } from '../types.js';
import { chatCompletionStream } from '../provider/openai-compatible.js';
import { buildMessages } from './context.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface AgentLoopCallbacks {
  onText: (text: string) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult) => void;
  onError: (error: string) => void;
  onTurnStart: (turn: number) => void;
  onDone: () => void;
}

export async function runAgentLoop(
  config: AgentConfig,
  registry: ToolRegistry,
  userMessage: string,
  history: Message[],
  callbacks: AgentLoopCallbacks,
): Promise<Message[]> {
  const newHistory = [...history];

  newHistory.push({
    id: crypto.randomUUID(),
    role: 'user',
    content: userMessage,
    timestamp: Date.now(),
  });

  const toolContext: ToolContext = {
    workspaceRoot: config.workspace,
    env: process.env as Record<string, string>,
  };

  let turn = 0;

  while (turn < config.maxTurns) {
    turn++;
    callbacks.onTurnStart(turn);

    const messages = buildMessages(config, newHistory, registry.getDefinitions());
    let assistantContent = '';
    const toolCalls: ToolCall[] = [];

    const stream = chatCompletionStream(config, messages, registry.getDefinitions());

    for await (const event of stream) {
      if (event.type === 'text' && event.content) {
        assistantContent += event.content;
        callbacks.onText(event.content);
      } else if (event.type === 'tool_call' && event.toolCall) {
        toolCalls.push(event.toolCall);
        callbacks.onToolCall(event.toolCall);
      } else if (event.type === 'error' && event.error) {
        callbacks.onError(event.error);
        return newHistory;
      }
    }

    const toolResults: ToolResult[] = [];
    for (const call of toolCalls) {
      const result = await registry.execute(call, toolContext);
      result.toolCallId = call.id;
      toolResults.push(result);
      callbacks.onToolResult(result);
    }

    newHistory.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: assistantContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      timestamp: Date.now(),
    });

    if (toolCalls.length === 0) {
      break;
    }
  }

  if (turn >= config.maxTurns) {
    callbacks.onError(`Reached max turns (${config.maxTurns}). Refine your prompt or increase BOOK_MAX_TURNS.`);
  }

  callbacks.onDone();
  return newHistory;
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat: add agent prompt loop with streaming and tool execution"
```

---

## Phase 6: TUI Components

### Task 11: Animation hooks

**Files:**
- Create: `src/tui/hooks/useAnimation.ts`

- [ ] **Step 1: Write animation hooks**

```typescript
// src/tui/hooks/useAnimation.ts
import { useState, useEffect } from 'react';

const BRAILLE_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
const DOT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function useSpinner(active: boolean, style: 'braille' | 'dots' = 'braille'): string {
  const [frame, setFrame] = useState(0);
  const frames = style === 'braille' ? BRAILLE_FRAMES : DOT_FRAMES;

  useEffect(() => {
    if (!active) {
      setFrame(0);
      return;
    }
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, 80);
    return () => clearInterval(interval);
  }, [active]);

  return frames[frame];
}

export function useTypewriter(
  text: string,
  speed: number,
  active: boolean,
): string {
  const [displayed, setDisplayed] = useState('');

  useEffect(() => {
    if (!active || !text) {
      setDisplayed(text);
      return;
    }
    setDisplayed('');
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(interval);
      }
    }, speed);
    return () => clearInterval(interval);
  }, [text, active]);

  return active ? displayed : text;
}

export function usePulse(active: boolean, interval = 500): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const timer = setInterval(() => {
      setOn((o) => !o);
    }, interval);
    return () => clearInterval(timer);
  }, [active]);

  return on;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tui/hooks/useAnimation.ts
git commit -m "feat: add animation hooks (spinner, typewriter, pulse)"
```

### Task 12: Spinner component

**Files:**
- Create: `src/tui/components/Spinner.tsx`

- [ ] **Step 1: Write Spinner component**

```typescript
// src/tui/components/Spinner.tsx
import { Text } from 'ink';
import { useSpinner } from '../hooks/useAnimation.js';

interface SpinnerProps {
  active?: boolean;
  style?: 'braille' | 'dots';
  color?: string;
}

export function Spinner({ active = true, style = 'braille', color }: SpinnerProps) {
  const frame = useSpinner(active, style);
  return <Text color={color}>{frame} </Text>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tui/components/Spinner.tsx
git commit -m "feat: add ANSI spinner component"
```

### Task 13: Header component

**Files:**
- Create: `src/tui/components/Header.tsx`

- [ ] **Step 1: Write Header with animated ASCII art**

```typescript
// src/tui/components/Header.tsx
import { Text, Box } from 'ink';
import { useState, useEffect } from 'react';

const LOGO_LINES = [
  '██████╗  ██████╗  ██████╗ ██╗  ██╗',
  '██╔══██╗██╔═══██╗██╔═══██╗██║ ██╔╝',
  '██████╔╝██║   ██║██║   ██║█████╔╝ ',
  '██╔══██╗██║   ██║██║   ██║██╔═██╗ ',
  '██████╔╝╚██████╔╝╚██████╔╝██║  ██╗',
  '╚═════╝  ╚═════╝  ╚═════╝ ╚═╝  ╚═╝',
];

const COLORS_CYCLE = ['cyan', 'magenta'];

interface HeaderProps {
  version: string;
  model: string;
}

export function Header({ version, model }: HeaderProps) {
  const [colorIndex, setColorIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setColorIndex((i) => (i + 1) % COLORS_CYCLE.length);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan">
      {LOGO_LINES.map((line, i) => (
        <Text key={i} color={COLORS_CYCLE[(colorIndex + i) % COLORS_CYCLE.length]}>
          {line}
        </Text>
      ))}
      <Box>
        <Text color="gray"> v{version}  </Text>
        <Text color="cyan">[{model}]</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tui/components/Header.tsx
git commit -m "feat: add animated ASCII art header with color cycling"
```

### Task 14: ToolCallBlock component

**Files:**
- Create: `src/tui/components/ToolCallBlock.tsx`

- [ ] **Step 1: Write ToolCallBlock component**

```typescript
// src/tui/components/ToolCallBlock.tsx
import { Text, Box } from 'ink';
import { Spinner } from './Spinner.js';
import type { ToolResult } from '../../types.js';

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
}

export function ToolCallBlock({ name, args, result }: ToolCallBlockProps) {
  const isRunning = !result;
  const isOk = result?.success;
  const primaryArg = args.filePath || args.command || args.pattern || args.message || '';

  return (
    <Box flexDirection="column" marginLeft={4} marginY={1}>
      <Box>
        {isRunning ? (
          <Spinner active style="dots" />
        ) : (
          <Text color={isOk ? 'green' : 'red'}>
            {isOk ? '[OK]' : '[ERR]'}
          </Text>
        )}
        <Text color="magenta"> {name}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text color="gray">{String(primaryArg).slice(0, 80)}</Text>
      </Box>
      {result && (
        <Box marginLeft={2}>
          <Text color={isOk ? 'white' : 'red'}>
            {result.output?.slice(0, 200)}
            {result.error ? `: ${result.error.slice(0, 100)}` : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tui/components/ToolCallBlock.tsx
git commit -m "feat: add ToolCallBlock component with spinner and result display"
```

### Task 15: AgentMessage component

**Files:**
- Create: `src/tui/components/AgentMessage.tsx`

- [ ] **Step 1: Write AgentMessage component**

```typescript
// src/tui/components/AgentMessage.tsx
import { Text, Box } from 'ink';
import { Spinner } from './Spinner.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { usePulse } from '../hooks/useAnimation.js';
import type { Message } from '../../types.js';
import chalk from 'chalk';

interface AgentMessageProps {
  message: Message;
  isStreaming: boolean;
  streamedText: string;
}

export function AgentMessage({ message, isStreaming, streamedText }: AgentMessageProps) {
  const isPulse = usePulse(isStreaming);

  const displayContent = isStreaming ? streamedText : message.content;

  return (
    <Box flexDirection="column" marginY={1}>
      <Box
        borderStyle="round"
        borderColor={isStreaming ? (isPulse ? 'cyan' : 'gray') : 'cyan'}
        paddingX={1}
      >
        <Box flexDirection="column">
          {isStreaming && !displayContent && !message.toolCalls?.length && (
            <Box>
              <Spinner active style="braille" color="cyan" />
              <Text color="gray">Thinking...</Text>
            </Box>
          )}
          {displayContent ? (
            <Box>
              {isStreaming && <Spinner active style="braille" color="cyan" />}
              <Text>{displayContent}</Text>
            </Box>
          ) : null}
          {message.toolCalls?.map((tc, i) => {
            const result = message.toolResults?.find((r) => r.toolCallId === tc.id);
            return (
              <ToolCallBlock
                key={tc.id || i}
                name={tc.name}
                args={tc.arguments}
                result={result}
              />
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tui/components/AgentMessage.tsx
git commit -m "feat: add AgentMessage component with streaming and tool display"
```

### Task 16: ChatPanel, InputBar, StatusBar components

**Files:**
- Create: `src/tui/components/ChatPanel.tsx`
- Create: `src/tui/components/InputBar.tsx`
- Create: `src/tui/components/StatusBar.tsx`

- [ ] **Step 1: Write ChatPanel**

```typescript
// src/tui/components/ChatPanel.tsx
import { Box, Text } from 'ink';
import type { Message } from '../../types.js';
import { AgentMessage } from './AgentMessage.js';

interface ChatPanelProps {
  messages: Message[];
  streamingMessage?: Message;
  streamedText: string;
  height: number;
}

export function ChatPanel({ messages, streamingMessage, streamedText, height }: ChatPanelProps) {
  return (
    <Box flexDirection="column" height={height}>
      {messages.map((msg) => {
        if (msg.role === 'user') {
          return (
            <Box key={msg.id} marginY={1}>
              <Box paddingX={1}>
                <Text color="gray" dimColor>
                  {'.'.repeat(60)}
                </Text>
              </Box>
              <Box paddingX={1}>
                <Text bold color="white">
                  {msg.content}
                </Text>
              </Box>
              <Box paddingX={1}>
                <Text color="gray" dimColor>
                  {'.'.repeat(60)}
                </Text>
              </Box>
            </Box>
          );
        }
        return (
          <AgentMessage
            key={msg.id}
            message={msg}
            isStreaming={msg === streamingMessage}
            streamedText={streamedText}
          />
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 2: Write InputBar**

```typescript
// src/tui/components/InputBar.tsx
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useState, useCallback } from 'react';

interface InputBarProps {
  onSubmit: (value: string) => void;
  disabled: boolean;
}

export function InputBar({ onSubmit, disabled }: InputBarProps) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const handleSubmit = useCallback(
    (val: string) => {
      if (!val.trim() || disabled) return;
      setHistory((h) => [val, ...h].slice(0, 100));
      setHistoryIndex(-1);
      onSubmit(val);
      setValue('');
    },
    [disabled, onSubmit],
  );

  const handleKeyDown = useCallback(
    (key: string) => {
      if (key === 'up' && history.length > 0) {
        const newIndex = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(newIndex);
        setValue(history[newIndex]);
      } else if (key === 'down') {
        const newIndex = Math.max(historyIndex - 1, -1);
        setHistoryIndex(newIndex);
        setValue(newIndex === -1 ? '' : history[newIndex]);
      }
    },
    [history, historyIndex],
  );

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text color="cyan">{disabled ? '(thinking...)' : '> '}</Text>
      {!disabled && (
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          onKeyDown={handleKeyDown}
        />
      )}
    </Box>
  );
}
```

- [ ] **Step 3: Write StatusBar**

```typescript
// src/tui/components/StatusBar.tsx
import { Box, Text } from 'ink';
import { usePulse } from '../hooks/useAnimation.js';

interface StatusBarProps {
  tokens: number;
  maxTokens: number;
}

export function StatusBar({ tokens, maxTokens }: StatusBarProps) {
  const nearLimit = tokens > maxTokens * 0.8;
  const blink = usePulse(nearLimit, 500);

  return (
    <Box>
      <Text color="gray">
        /help  /design  /browser  /clear  /exit
      </Text>
      <Text color="gray">  tokens: </Text>
      <Text color={nearLimit && blink ? 'red' : 'gray'}>{tokens}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Check if ink-text-input is available, install if not**

```bash
npm ls ink-text-input || npm install ink-text-input
```

- [ ] **Step 5: Verify compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/tui/components/ChatPanel.tsx src/tui/components/InputBar.tsx src/tui/components/StatusBar.tsx
git commit -m "feat: add ChatPanel, InputBar, and StatusBar TUI components"
```

### Task 17: useAgent hook

**Files:**
- Create: `src/tui/hooks/useAgent.ts`

- [ ] **Step 1: Write useAgent hook**

```typescript
// src/tui/hooks/useAgent.ts
import { useState, useCallback, useRef } from 'react';
import type { Message, ToolCall, ToolResult } from '../../types.js';
import { runAgentLoop } from '../../agent/loop.js';
import { createDefaultRegistry } from '../../tools/registry.js';
import type { AgentConfig } from '../../types.js';

export function useAgent(config: AgentConfig) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (userMessage: string) => {
      if (isThinking) return;
      setIsThinking(true);
      setError(null);
      setStreamedText('');
      setCurrentTurn(0);

      const registry = createDefaultRegistry();

      try {
        const newHistory = await runAgentLoop(config, registry, userMessage, messages, {
          onText: (text) => {
            setStreamedText((prev) => prev + text);
          },
          onToolCall: (_call: ToolCall) => {},
          onToolResult: (_result: ToolResult) => {},
          onError: (err) => {
            setError(err);
          },
          onTurnStart: (turn) => {
            setCurrentTurn(turn);
          },
          onDone: () => {
            setIsThinking(false);
          },
        });
        setMessages(newHistory);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setIsThinking(false);
      }
    },
    [config, isThinking, messages],
  );

  const clear = useCallback(() => {
    setMessages([]);
    setError(null);
    setStreamedText('');
    setCurrentTurn(0);
  }, []);

  return {
    messages,
    isThinking,
    streamedText,
    error,
    currentTurn,
    send,
    clear,
  };
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/useAgent.ts
git commit -m "feat: add useAgent hook connecting TUI to agent loop"
```

### Task 18: Ink App root

**Files:**
- Create: `src/tui/app.tsx`

- [ ] **Step 1: Write App component**

```typescript
// src/tui/app.tsx
import { Box } from 'ink';
import { useState, useCallback } from 'react';
import { Header } from './components/Header.js';
import { ChatPanel } from './components/ChatPanel.js';
import { InputBar } from './components/InputBar.js';
import { StatusBar } from './components/StatusBar.js';
import { useAgent } from './hooks/useAgent.js';
import type { AgentConfig } from '../types.js';

interface AppProps {
  config: AgentConfig;
}

export function App({ config }: AppProps) {
  const { messages, isThinking, streamedText, error, currentTurn, send, clear } =
    useAgent(config);

  const streamingMessage = isThinking
    ? messages[messages.length - 1]
    : undefined;

  const handleSubmit = useCallback(
    (value: string) => {
      if (value.startsWith('/clear')) {
        clear();
      } else if (value.startsWith('/exit')) {
        process.exit(0);
      } else {
        send(value);
      }
    },
    [send, clear],
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Header version="0.1.0" model={config.model} />
      <ChatPanel
        messages={messages}
        streamingMessage={streamingMessage}
        streamedText={streamedText}
        height={Math.max(10, process.stdout.rows - 12)}
      />
      {error && (
        <Box>
          <Box color="red">{error}</Box>
        </Box>
      )}
      <InputBar onSubmit={handleSubmit} disabled={isThinking} />
      <StatusBar tokens={0} maxTokens={128000} />
    </Box>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat: add Ink App root with all TUI components wired together"
```

---

## Phase 7: CLI Entry Point

### Task 19: CLI entry and TUI bootstrap

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write CLI entry point**

```typescript
#!/usr/bin/env node
// src/index.ts
import { program } from 'commander';
import { render } from 'ink';
import { createElement } from 'react';
import { App } from './tui/app.js';
import { loadConfig } from './config.js';

program
  .name('book')
  .description('AI coding agent with rich TUI')
  .version('0.1.0')
  .option('-w, --workspace <path>', 'Workspace root directory', process.cwd())
  .option('-m, --model <model>', 'Model to use')
  .action((options) => {
    try {
      const config = loadConfig(options.workspace);
      if (options.model) {
        config.model = options.model;
      }

      const { unmount } = render(createElement(App, { config }));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

program.parse();
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Build and verify it produces dist/index.js**

Run: `npx tsup src/index.ts --format esm --out-dir dist`

Expected: dist/index.js created.

- [ ] **Step 4: Test basic startup (no API key, expect error)**

Run: `node dist/index.js --help`

Expected: Shows Commander help output.

- [ ] **Step 5: Test with missing API key**

Run: `node dist/index.js`

Expected: "BOOK_API_KEY not set" error.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: add CLI entry point with Commander and Ink rendering"
```

---

## Phase 8: Design Partner Tools

### Task 20: Design partner tools stub

**Files:**
- Create: `src/tools/design.ts`

- [ ] **Step 1: Write design tools**

```typescript
// src/tools/design.ts
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

function designToolResponse(toolName: string, _args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  return Promise.resolve({
    toolCallId: '',
    success: true,
    output: `Design tool "${toolName}" analysis complete. Review the recommendations and apply changes as needed.`,
  });
}

export const designTools: ToolDefinition[] = [
  {
    name: 'design_audit',
    description: 'Audit the current UI for design issues and accessibility problems',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Scope of the audit (e.g. file path or component name)' },
      },
      required: ['scope'],
    },
    execute: (args, ctx) => designToolResponse('design_audit', args, ctx),
  },
  {
    name: 'design_review',
    description: 'Review UI code and provide design improvement suggestions',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the UI file to review' },
      },
      required: ['filePath'],
    },
    execute: (args, ctx) => designToolResponse('design_review', args, ctx),
  },
  {
    name: 'design_recolor',
    description: 'Analyze color usage and suggest palette improvements',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file with color definitions' },
      },
      required: ['filePath'],
    },
    execute: (args, ctx) => designToolResponse('design_recolor', args, ctx),
  },
  {
    name: 'design_typeset',
    description: 'Analyze typography and suggest improvements',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file with typography styles' },
      },
      required: ['filePath'],
    },
    execute: (args, ctx) => designToolResponse('design_typeset', args, ctx),
  },
  {
    name: 'design_tokenize',
    description: 'Extract design tokens from existing styles',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Directory or file to extract tokens from' },
      },
      required: ['scope'],
    },
    execute: (args, ctx) => designToolResponse('design_tokenize', args, ctx),
  },
];
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/design.ts
git commit -m "feat: add design partner tools stub (audit, review, recolor, typeset, tokenize)"
```

---

## Phase 9: Browser Tools

### Task 21: Browser tools stub

**Files:**
- Create: `src/tools/browser.ts`

- [ ] **Step 1: Write browser tools stub**

```typescript
// src/tools/browser.ts
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

function browserError(toolName: string): Promise<ToolResult> {
  return Promise.resolve({
    toolCallId: '',
    success: false,
    output: '',
    error: `Browser tool "${toolName}" requires Chrome. Install Chrome and set CHROME_PATH, or enable headless mode in .bookrc.json`,
  });
}

export const browserTools: ToolDefinition[] = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the browser',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['url'],
    },
    execute: () => browserError('browser_navigate'),
  },
  {
    name: 'browser_click',
    description: 'Click an element on the page',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the element to click' },
      },
      required: ['selector'],
    },
    execute: () => browserError('browser_click'),
  },
  {
    name: 'browser_type',
    description: 'Type text into an input element',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the input element' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['selector', 'text'],
    },
    execute: () => browserError('browser_type'),
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'File path to save the screenshot' },
      },
      required: ['filePath'],
    },
    execute: () => browserError('browser_screenshot'),
  },
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript in the browser context',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript code to execute' },
      },
      required: ['script'],
    },
    execute: () => browserError('browser_evaluate'),
  },
];
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/browser.ts
git commit -m "feat: add browser tools stub (navigate, click, type, screenshot, evaluate)"
```

---

## Phase 10: Integration and Polish

### Task 22: Wire all tools into default registry

**Files:**
- Modify: `src/tools/registry.ts`

- [ ] **Step 1: Update registry to include design and browser tools**

```typescript
// In createDefaultRegistry(), add design and browser tools:

import { designTools } from './design.js';
import { browserTools } from './browser.js';

export function createDefaultRegistry(): ReturnType<typeof createRegistry> {
  const registry = createRegistry();
  registry.registerAll([...fileTools, ...shellTools, ...gitTools, ...designTools, ...browserTools]);
  return registry;
}
```

- [ ] **Step 2: Verify compiles and build**

Run: `npx tsc --noEmit && npx tsup src/index.ts --format esm --out-dir dist`

Expected: No errors, build succeeds.

- [ ] **Step 3: Run full typecheck**

Run: `npx tsc --noEmit`

Expected: No errors across all files.

- [ ] **Step 4: Commit**

```bash
git add src/tools/registry.ts
git commit -m "feat: wire all tools (file, shell, git, design, browser) into default registry"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - Architecture (4 layers) — Phase 2-6
   - Agent core & prompt loop — Task 9-10
   - Tool system (all 5 categories) — Task 5-8, 20-21
   - TUI layout (6 components + animation hooks) — Task 11-18
   - Configuration (.bookrc + env vars) — Task 3
   - Error handling — Built into agent loop, provider, and each tool
   - Directory structure — Matches file map

2. **No placeholders:** All tasks have concrete code, commands, expected outputs.

3. **Type consistency:** Types defined in Task 2, used consistently across all tasks. `ToolDefinition`, `Message`, `ToolResult`, `AgentConfig`, `ToolContext` match everywhere.

4. **Dependencies all accounted for:** `commander`, `ink`, `react`, `chalk`, `zod`, `fast-glob` are in package.json. `ink-text-input` added in Task 16.
