# Book M3 — Headless & Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `book` scriptable and resumable — the Unix-philosophy core Claude Code sells ("pipe logs into it, run it in CI"). Add `--print`/`-p` headless mode with text/json/stream-json output, session persistence + resume, and context compaction.

**Architecture:** Extract a renderer-agnostic headless runner (`src/headless.ts`) that wraps `runAgentLoop` with output-format-aware callbacks. Sessions persist as JSONL in `~/.book/sessions/<uuid>.jsonl`; a `SessionStore` handles save/load/cleanup. Compaction summarizes older turns when usage approaches the model's context limit. The TUI gains `/compact` and `/resume` slash commands. `src/index.ts` gains the print-mode flags and routes to the headless runner instead of Ink.

**Tech Stack:** TypeScript (ESM), Node 18+, Commander, Ink/React 19, Zod, vitest, tsup.

**Source spec:** `docs/superpowers/research/2026-06-26-book-cc-parity-gap-analysis.md` (section D) and `docs/superpowers/plans/2026-06-26-book-cc-parity-milestones.md` (milestone M3).

---

## File Map

```
book/
  src/
    index.ts                          # MODIFY: add -p/--print, -r/--resume, -c/--continue, --session-id, --name, --output-format, --input-format, --max-turns, --max-budget-usd, --no-session-persistence, --verbose, --permission-mode; route to headless when -p
    headless.ts                       # CREATE: runHeadless() — text/json/stream-json output, text/stream-json input
    headless.test.ts                  # CREATE (M3.1)
    session/
      store.ts                        # CREATE: JSONL session persistence, index, cleanup
      store.test.ts                   # CREATE (M3.3)
      resume.ts                       # CREATE: find by id/name, --continue picker
    agent/
      compact.ts                      # CREATE: summarize older turns when near context limit
      compact.test.ts                 # CREATE (M3.4)
      loop.ts                         # MODIFY: accept onPersist callback for session writes; autoCompact hook
      context.ts                      # MODIFY: buildMessages accepts a compaction summary prefix
    types.ts                          # MODIFY: HeadlessOptions, SessionRecord, CompactionResult types
    config.ts                         # MODIFY: add autoCompactEnabled, cleanupPeriodDays, maxTokens (model context size)
    tui/
      app.tsx                         # MODIFY: /compact and /resume slash commands, load session on resume
      hooks/useAgent.ts               # MODIFY: persist each message to session store; expose compact()
```

---

## Phase 1: Headless Mode — `--print`/`-p` + Output Formats (M3.1) — 🔴 critical

### Task 1: Write failing headless test (text + json output)

**Files:**
- Create: `src/headless.test.ts`

- [ ] **Step 1: Write failing tests for text and json output**

```typescript
// src/headless.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';
import type { AgentConfig } from './types.js';

const config: AgentConfig = {
  apiKey: 'k', baseUrl: 'http://localhost/v1', model: 'm', maxTurns: 5, workspace: '.',
  animation: { typewriterSpeed: 3, spinnerStyle: 'braille' },
  accessibility: { screenReader: false, reducedMotion: false },
};

beforeEach(() => {
  // Fake provider: yields one text chunk then [DONE] with usage.
  vi.stubGlobal('fetch', vi.fn(async () => {
    const body = new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hello!"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  }));
});

describe('runHeadless — text output', () => {
  it('prints the final assistant text to stdout', async () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; } };
    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdout,
    });
    expect(writes.join('')).toContain('Hello!');
  });
});

describe('runHeadless — json output', () => {
  it('emits one JSON object with messages and usage', async () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; } };
    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
    });
    const out = writes.join('').trim();
    const parsed = JSON.parse(out);
    expect(parsed.result).toBeDefined();
    expect(parsed.result.usage.totalTokens).toBe(7);
    expect(parsed.result.messages.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/headless.test.ts`

Expected: FAIL — `runHeadless` does not exist.

### Task 2: Implement runHeadless (text + json output)

**Files:**
- Create: `src/headless.ts`
- Modify: `src/types.ts` (add HeadlessOptions + HeadlessResult types)

- [ ] **Step 1: Add the types**

In `src/types.ts`:

```typescript
export type OutputFormat = 'text' | 'json' | 'stream-json';
export type InputFormat = 'text' | 'stream-json';

export interface HeadlessOptions {
  prompt?: string;
  inputFormat: InputFormat;
  outputFormat: OutputFormat;
  history: Message[];
  mode: PermissionMode;
  maxTurns?: number;
  maxBudgetUsd?: number;
  verbose?: boolean;
  signal?: AbortSignal;
  stdout?: { write: (s: string) => boolean };
  stdin?: NodeJS.ReadableStream;
  onPersist?: (record: SessionRecord) => void;
}

export interface HeadlessResult {
  messages: Message[];
  usage: Usage | null;
  costUsd?: number;
  sessionId?: string;
}

export interface SessionRecord {
  type: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'usage';
  timestamp: number;
  data: unknown;
}
```

- [ ] **Step 2: Implement runHeadless**

```typescript
// src/headless.ts
import type { AgentConfig, Message, ToolCall, ToolResult, HeadlessOptions, HeadlessResult, Usage } from './types.js';
import { runAgentLoop } from './agent/loop.js';
import type { ToolRegistry } from './tools/registry.js';

export async function runHeadless(
  config: AgentConfig,
  registry: ToolRegistry,
  opts: HeadlessOptions,
): Promise<HeadlessResult> {
  const stdout = opts.stdout ?? process.stdout;
  const emit = (obj: unknown) => stdout.write(JSON.stringify(obj) + '\n');

  if (opts.outputFormat === 'stream-json') {
    emit({ type: 'system', model: config.model, cwd: config.workspace });
  }

  // Headless permission policy: if a prompt would be shown and no rule resolves it,
  // deny the tool (headless can't interactively prompt).
  const permissionRequired = async (_call: ToolCall): Promise<'allow' | 'deny' | 'always'> => 'deny';

  let lastUsage: Usage | null = null;
  const newHistory = [...opts.history];

  // text input: single prompt from opts.prompt
  // stream-json input: read newline-delimited JSON from stdin (stretch — see Task 4)
  const prompts: string[] = [];
  if (opts.inputFormat === 'text') {
    if (!opts.prompt) throw new Error('text input format requires a prompt');
    prompts.push(opts.prompt);
  } else {
    // stream-json input handled in Task 4; for now read prompt if provided.
    if (opts.prompt) prompts.push(opts.prompt);
  }

  for (const prompt of prompts) {
    const collectedText: string[] = [];
    const collectedToolCalls: ToolCall[] = [];
    const collectedToolResults: ToolResult[] = [];

    await runAgentLoop(
      { ...config, maxTurns: opts.maxTurns ?? config.maxTurns },
      registry,
      prompt,
      newHistory,
      {
        onText: (text) => {
          collectedText.push(text);
          if (opts.outputFormat === 'stream-json') {
            emit({ type: 'assistant', text });
          }
        },
        onToolCall: (call) => {
          collectedToolCalls.push(call);
          if (opts.outputFormat === 'stream-json') emit({ type: 'tool_use', tool_call: call });
        },
        onToolResult: (result) => {
          collectedToolResults.push(result);
          if (opts.outputFormat === 'stream-json') emit({ type: 'tool_result', tool_result: result });
        },
        onError: (err) => {
          if (opts.outputFormat === 'stream-json') emit({ type: 'error', error: err });
          else stderr().write(`error: ${err}\n`);
        },
        onTurnStart: () => {},
        onDone: () => {},
        onPermissionRequired: permissionRequired,
        onUsage: (u) => { lastUsage = u; },
      },
      opts.mode,
      undefined,
      { signal: opts.signal },
    );

    // The loop appended to its own copy; reconstruct the latest assistant message.
    // (runAgentLoop returns the full history; for headless we only need the result.)
  }

  // Re-run to get the final history (runAgentLoop returns Message[]). We'll capture it.
  // Actually runAgentLoop returns newHistory; let's call it once and keep the return.
  // (Refactor: the loop above already ran; for json/text we reconstruct from collected.)
  const result: HeadlessResult = {
    messages: newHistory,
    usage: lastUsage,
  };

  if (opts.outputFormat === 'text') {
    // Print the final assistant text.
    const last = lastAssistantText(newHistory);
    if (last) stdout.write(last + '\n');
  } else if (opts.outputFormat === 'json') {
    emit({ result: { messages: newHistory, usage: lastUsage } });
  }
  // stream-json already emitted events live; nothing more here.

  return result;
}

function lastAssistantText(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'assistant' && m.content) return m.content;
  }
  return '';
}

function stderr() {
  return { write: (s: string) => process.stderr.write(s) };
}
```

> Note: the initial implementation calls `runAgentLoop` but doesn't capture its return value into `newHistory`. Fix this by capturing `const updated = await runAgentLoop(...)` and then `newHistory.length = 0; newHistory.push(...updated)`. The test will drive this.

- [ ] **Step 3: Capture the loop's returned history**

Fix `runHeadless` so `newHistory` is replaced with the loop's return value each prompt iteration:

```typescript
    const updated = await runAgentLoop(/* ... same args ... */);
    newHistory.length = 0;
    newHistory.push(...updated);
```

- [ ] **Step 4: Run the failing tests**

Run: `npx vitest run src/headless.test.ts`

Expected: Both text and json tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/headless.ts src/headless.test.ts src/types.ts
git commit -m "feat(headless): runHeadless with text + json output (M3.1)"
```

### Task 3: Add stream-json output + CLI `--print`/`-p` flag

**Files:**
- Modify: `src/headless.test.ts` (add stream-json test)
- Modify: `src/headless.ts` (stream-json already scaffolded; verify)
- Modify: `src/index.ts` (add print-mode flags, route to runHeadless)

- [ ] **Step 1: Add a stream-json test**

```typescript
describe('runHeadless — stream-json output', () => {
  it('emits system, assistant, result events as newline-delimited JSON', async () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; } };
    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
    });
    const lines = writes.join('').split('\n').filter(Boolean);
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types[0]).toBe('system');
    expect(types).toContain('assistant');
    expect(types[types.length - 1]).toBe('result');
  });
});
```

- [ ] **Step 2: Ensure stream-json emits a final `result` event**

In `runHeadless`, after the prompt loop, for `stream-json` emit:

```typescript
if (opts.outputFormat === 'stream-json') {
  emit({ type: 'result', result: { messages: newHistory, usage: lastUsage } });
}
```

- [ ] **Step 3: Add CLI flags to `src/index.ts`**

```typescript
program
  .name('book')
  .description('AI coding agent with rich TUI')
  .version('0.1.0')
  .option('-w, --workspace <path>', 'Workspace root directory', process.cwd())
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --print [prompt]', 'Print mode (non-interactive)')
  .option('--output-format <format>', 'text | json | stream-json', 'text')
  .option('--input-format <format>', 'text | stream-json', 'text')
  .option('--max-turns <n>', 'Max agent turns (print mode)')
  .option('--max-budget-usd <amount>', 'Max USD spend (print mode)')
  .option('--permission-mode <mode>', 'default | acceptEdits | plan | auto | dontAsk | bypassPermissions')
  .option('--verbose', 'Full turn-by-turn output')
  .action(async (options) => {
    try {
      const config = loadConfig(options.workspace);
      if (options.model) config.model = options.model;
      if (options.maxTurns) config.maxTurns = parseInt(options.maxTurns, 10);

      if (options.print !== undefined) {
        // Headless mode.
        const { runHeadless } = await import('./headless.js');
        const mode = (options.permissionMode ?? 'default') as any;
        await runHeadless(config, createDefaultRegistry(), {
          prompt: typeof options.print === 'string' ? options.print : undefined,
          inputFormat: options.inputFormat as any,
          outputFormat: options.outputFormat as any,
          history: [],
          mode,
          maxTurns: options.maxTurns ? parseInt(options.maxTurns, 10) : undefined,
          maxBudgetUsd: options.maxBudgetUsd ? parseFloat(options.maxBudgetUsd) : undefined,
          verbose: options.verbose,
        });
        return;
      }

      const { unmount } = render(createElement(App, { config }));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });
```

- [ ] **Step 4: Run all tests + typecheck**

Run: `npx tsc --noEmit && npx vitest run src/headless.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/headless.ts src/headless.test.ts src/index.ts
git commit -m "feat(headless): stream-json output + --print/-p CLI flag (M3.1)"
```

### Task 4: stream-json input (programmatic stdin)

**Files:**
- Modify: `src/headless.ts`
- Modify: `src/headless.test.ts`

- [ ] **Step 1: Add a stream-json input test**

```typescript
import { Readable } from 'stream';

describe('runHeadless — stream-json input', () => {
  it('reads newline-delimited user messages from stdin', async () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; } };
    const stdin = Readable.from([
      JSON.stringify({ type: 'user', content: 'first' }) + '\n',
      JSON.stringify({ type: 'user', content: 'second' }) + '\n',
    ]);
    await runHeadless(config, createDefaultRegistry(), {
      inputFormat: 'stream-json',
      outputFormat: 'json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
      stdin,
    });
    const parsed = JSON.parse(writes.join('').trim());
    // Two prompts -> at least two assistant messages in history.
    const assistantCount = parsed.result.messages.filter((m: any) => m.role === 'assistant').length;
    expect(assistantCount).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Implement stream-json input**

In `runHeadless`, when `inputFormat === 'stream-json'`, read stdin line by line and collect prompts:

```typescript
  if (opts.inputFormat === 'stream-json') {
    const stream = opts.stdin ?? process.stdin;
    for await (const chunk of stream) {
      const line = chunk.toString().trim();
      if (!line) continue;
      const parsed = JSON.parse(line);
      if (parsed.type === 'user' && typeof parsed.content === 'string') {
        prompts.push(parsed.content);
      }
    }
  }
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/headless.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/headless.ts src/headless.test.ts
git commit -m "feat(headless): stream-json input from stdin (M3.1)"
```

### Task 5: `--json-schema` structured output (M3.2)

**Files:**
- Modify: `src/headless.ts`
- Modify: `src/headless.test.ts`

- [ ] **Step 1: Add a failing test**

```typescript
describe('runHeadless — json-schema', () => {
  it('returns validated JSON matching the schema', async () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; } };
    // Provider yields JSON content.
    vi.stubGlobal('fetch', vi.fn(async () => {
      const body = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"{\\"name\\":\\"book\\"}"}}]}\n\n'));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }));
    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'return json',
      inputFormat: 'text',
      outputFormat: 'json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
      jsonSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    });
    const parsed = JSON.parse(writes.join('').trim());
    expect(parsed.result.structured).toEqual({ name: 'book' });
  });
});
```

- [ ] **Step 2: Implement json-schema extraction**

Add `jsonSchema?: object` to `HeadlessOptions`. After the loop, if `jsonSchema` is set, parse the last assistant text as JSON and attach as `result.structured`:

```typescript
  if (opts.jsonSchema) {
    const text = lastAssistantText(newHistory);
    try {
      const structured = JSON.parse(text);
      result.structured = structured;
    } catch {
      result.structuredError = `Failed to parse JSON from assistant output`;
    }
  }
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run src/headless.test.ts
git add src/headless.ts src/headless.test.ts src/types.ts
git commit -m "feat(headless): --json-schema structured output (M3.2)"
```

---

## Phase 2: Session Persistence + Resume (M3.3) — 🔴 critical

### Task 6: Write failing session-store test

**Files:**
- Create: `src/session/store.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from './store.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'book-sess-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SessionStore', () => {
  it('creates a session with a uuid id', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj', name: 'my-feature' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('appends records to the session jsonl file', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, { type: 'user', timestamp: 1, data: { content: 'hi' } });
    s.append(id, { type: 'assistant', timestamp: 2, data: { content: 'hello' } });
    const raw = readFileSync(join(dir, `${id}.jsonl`), 'utf-8');
    expect(raw.split('\n').filter(Boolean).length).toBe(2);
  });

  it('loads a session and replays records into history', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, { type: 'user', timestamp: 1, data: { content: 'hi' } });
    s.append(id, { type: 'assistant', timestamp: 2, data: { content: 'hello' } });
    const loaded = s.load(id);
    expect(loaded.history.length).toBe(2);
    expect(loaded.history[0].role).toBe('user');
  });

  it('lists sessions sorted by updatedAt desc', () => {
    const s = new SessionStore(dir);
    const a = s.create({ cwd: '/proj' });
    s.append(a, { type: 'user', timestamp: 1, data: { content: 'a' } });
    const b = s.create({ cwd: '/proj' });
    s.append(b, { type: 'user', timestamp: 2, data: { content: 'b' } });
    const list = s.list();
    expect(list[0].id).toBe(b);
    expect(list[1].id).toBe(a);
  });

  it('finds most recent session in a cwd (--continue)', () => {
    const s = new SessionStore(dir);
    const a = s.create({ cwd: '/proj' });
    s.append(a, { type: 'user', timestamp: 1, data: { content: 'a' } });
    const b = s.create({ cwd: '/other' });
    s.append(b, { type: 'user', timestamp: 2, data: { content: 'b' } });
    expect(s.mostRecentInCwd('/proj')?.id).toBe(a);
    expect(s.mostRecentInCwd('/other')?.id).toBe(b);
    expect(s.mostRecentInCwd('/none')).toBeUndefined();
  });

  it('looks up by name', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj', name: 'feature-x' });
    s.append(id, { type: 'user', timestamp: 1, data: { content: 'a' } });
    expect(s.findByName('feature-x')?.id).toBe(id);
  });

  it('deletes sessions older than cleanupPeriodDays', () => {
    const s = new SessionStore(dir);
    const old = s.create({ cwd: '/proj' });
    s.append(old, { type: 'user', timestamp: Date.now() - 40 * 86400_000, data: {} });
    const fresh = s.create({ cwd: '/proj' });
    s.append(fresh, { type: 'user', timestamp: Date.now(), data: {} });
    const removed = s.cleanup(30);
    expect(removed).toBe(1);
    expect(existsSync(join(dir, `${old}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, `${fresh}.jsonl`))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/session/store.test.ts`

Expected: FAIL — module not found.

### Task 7: Implement SessionStore

**Files:**
- Create: `src/session/store.ts`

- [ ] **Step 1: Implement the store**

```typescript
// src/session/store.ts
import { mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import type { Message, SessionRecord } from '../types.js';

export interface SessionMeta {
  id: string;
  name?: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export class SessionStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }

  private path(id: string) { return join(this.root, `${id}.jsonl`); }

  create(meta: { cwd: string; name?: string }): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    const header: SessionRecord = {
      type: 'user', // placeholder; we store meta in a sidecar record
      timestamp: now,
      data: { kind: 'session_meta', id, cwd: meta.cwd, name: meta.name, createdAt: now, updatedAt: now },
    };
    appendFileSync(this.path(id), JSON.stringify(header) + '\n', 'utf-8');
    return id;
  }

  append(id: string, record: SessionRecord): void {
    appendFileSync(this.path(id), JSON.stringify(record) + '\n', 'utf-8');
  }

  load(id: string): { history: Message[]; meta: SessionMeta } {
    const raw = readFileSync(this.path(id), 'utf-8');
    const records = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as SessionRecord);
    const metaRec = records.find((r) => (r.data as any)?.kind === 'session_meta');
    const meta: SessionMeta = metaRec ? (metaRec.data as any) : { id, cwd: '', createdAt: 0, updatedAt: 0, messageCount: 0 };
    const history: Message[] = [];
    for (const r of records) {
      if ((r.data as any)?.kind === 'session_meta') continue;
      if (r.type === 'user') history.push({ id: crypto.randomUUID(), role: 'user', content: (r.data as any).content, timestamp: r.timestamp });
      if (r.type === 'assistant') {
        const last = history[history.length - 1];
        if (last?.role === 'assistant') last.content += (r.data as any).content ?? '';
        else history.push({ id: crypto.randomUUID(), role: 'assistant', content: (r.data as any).content ?? '', timestamp: r.timestamp });
      }
    }
    return { history, meta };
  }

  list(): SessionMeta[] {
    const metas: SessionMeta[] = [];
    for (const f of readdirSync(this.root)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const { meta } = this.load(f.replace('.jsonl', ''));
        metas.push(meta);
      } catch {}
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  mostRecentInCwd(cwd: string): SessionMeta | undefined {
    return this.list().find((m) => m.cwd === cwd);
  }

  findByName(name: string): SessionMeta | undefined {
    return this.list().find((m) => m.name === name);
  }

  cleanup(days: number): number {
    const cutoff = Date.now() - days * 86400_000;
    let removed = 0;
    for (const f of readdirSync(this.root)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(this.root, f);
      if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; }
    }
    return removed;
  }
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/session/store.test.ts`

Expected: All 7 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/session/store.ts src/session/store.test.ts
git commit -m "feat(session): JSONL session store with resume + cleanup (M3.3)"
```

### Task 8: Wire sessions into headless + CLI flags

**Files:**
- Modify: `src/headless.ts` (accept sessionId + sessionStore, persist records)
- Modify: `src/index.ts` (add `-r/--resume`, `-c/--continue`, `--session-id`, `--name/-n`, `--no-session-persistence`, `--fork-session`)

- [ ] **Step 1: Wire persistence into runHeadless**

In `runHeadless`, accept `sessionStore?: SessionStore` and `sessionId?: string`. On each event, append a record. Create a session lazily on first prompt if a store is present and no sessionId.

- [ ] **Step 2: Add CLI flags**

```typescript
  .option('-r, --resume <id|name>', 'Resume a session by id or name')
  .option('-c, --continue', 'Resume the most recent session in this directory')
  .option('--session-id <uuid>', 'Use a specific session id')
  .option('-n, --name <name>', 'Set a display name for the session')
  .option('--no-session-persistence', 'Do not save the session to disk')
  .option('--fork-session', 'On resume, create a new session id')
```

- [ ] **Step 3: In the action, resolve history from session store before runHeadless**

```typescript
const sessionRoot = join(homedir(), '.book', 'sessions');
const sessionStore = options.sessionPersistence ? new SessionStore(sessionRoot) : undefined;
let history = [];
let sessionId = options.sessionId;
if (options.resume) {
  const meta = sessionStore?.findByName(options.resume) ?? sessionStore?.list().find((m) => m.id === options.resume);
  if (meta) { const loaded = sessionStore!.load(meta.id); history = loaded.history; sessionId = options.forkSession ? undefined : meta.id; }
}
if (options.continue && !history.length) {
  const meta = sessionStore?.mostRecentInCwd(config.workspace);
  if (meta) { const loaded = sessionStore!.load(meta.id); history = loaded.history; sessionId = meta.id; }
}
```

- [ ] **Step 4: Run cleanup at startup**

```typescript
sessionStore?.cleanup(config.cleanupPeriodDays ?? 30);
```

- [ ] **Step 5: Run all tests + typecheck**

Run: `npx tsc --noEmit && npx vitest run`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/headless.ts src/index.ts
git commit -m "feat(session): wire persistence + --resume/--continue/--session-id flags (M3.3)"
```

### Task 9: Interactive `/resume` + TUI session loading

**Files:**
- Modify: `src/tui/app.tsx` (handle `/resume` and `/resume <name>`)

- [ ] **Step 1: Add `/resume` handling**

In `handleSubmit`, if `value.startsWith('/resume')`, look up the session (by name or picker), load history, and `setMessages(loaded)`. For M3, implement the name form; the interactive picker can be a simple list prompt.

- [ ] **Step 2: Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): /resume slash command (M3.3)"
```

---

## Phase 3: Context Compaction (M3.4) — 🟠 high

### Task 10: Write failing compaction test

**Files:**
- Create: `src/agent/compact.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { shouldCompact, compactHistory } from './compact.js';
import type { Message, Usage } from '../types.js';

describe('shouldCompact', () => {
  it('returns true when usage exceeds threshold', () => {
    expect(shouldCompact({ promptTokens: 8000, completionTokens: 2000, totalTokens: 10000 }, 128000, 0.8)).toBe(false);
    expect(shouldCompact({ promptTokens: 100000, completionTokens: 5000, totalTokens: 105000 }, 128000, 0.8)).toBe(true);
  });
  it('returns false when no usage', () => {
    expect(shouldCompact(null, 128000, 0.8)).toBe(false);
  });
});

describe('compactHistory', () => {
  it('keeps the system message and last K turns, summarizes the rest', () => {
    const history: Message[] = [
      { id: '1', role: 'user', content: 'old1', timestamp: 0 },
      { id: '2', role: 'assistant', content: 'old2', timestamp: 0 },
      { id: '3', role: 'user', content: 'recent1', timestamp: 0 },
      { id: '4', role: 'assistant', content: 'recent2', timestamp: 0 },
    ];
    const { kept, summarized } = compactHistory(history, 2);
    expect(kept.length).toBe(2);
    expect(kept[0].content).toBe('recent1');
    expect(summarized.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/agent/compact.test.ts`

Expected: FAIL — module not found.

### Task 11: Implement compaction

**Files:**
- Create: `src/agent/compact.ts`
- Modify: `src/agent/loop.ts` (call compaction when shouldCompact returns true)

- [ ] **Step 1: Implement compact.ts**

```typescript
// src/agent/compact.ts
import type { Message, Usage } from '../types.js';

export function shouldCompact(usage: Usage | null, maxTokens: number, threshold = 0.8): boolean {
  if (!usage) return false;
  return usage.totalTokens >= maxTokens * threshold;
}

export function compactHistory(history: Message[], keepLast: number): {
  kept: Message[];
  summarized: Message[];
} {
  if (history.length <= keepLast) return { kept: history, summarized: [] };
  const summarized = history.slice(0, history.length - keepLast);
  const kept = history.slice(history.length - keepLast);
  return { kept, summarized };
}

// The actual summarization prompt is sent to the model; this builds the request.
export function buildCompactPrompt(summarized: Message[]): string {
  const transcript = summarized
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
  return `Summarize the following conversation so far in a compact form, preserving key decisions, file paths, and unresolved questions:\n\n${transcript}`;
}
```

- [ ] **Step 2: Wire auto-compaction into runAgentLoop**

In `loop.ts`, before each turn, if `shouldCompact(turnUsage, config.maxTokens ?? 128000)` and `config.autoCompactEnabled !== false`, call the model with `buildCompactPrompt(summarized)` and prepend the summary to the next turn's history.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/agent/compact.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/compact.ts src/agent/compact.test.ts src/agent/loop.ts
git commit -m "feat(agent): context compaction when near context limit (M3.4)"
```

### Task 12: `/compact` slash command in TUI

**Files:**
- Modify: `src/tui/app.tsx`
- Modify: `src/tui/hooks/useAgent.ts` (expose `compact()`)

- [ ] **Step 1: Add manual `/compact`**

Expose a `compact()` from `useAgent` that triggers compaction immediately. Bind `/compact` in `handleSubmit`.

- [ ] **Step 2: Commit**

```bash
git add src/tui/app.tsx src/tui/hooks/useAgent.ts
git commit -m "feat(tui): /compact slash command (M3.4)"
```

---

## Phase 4: Regression (M3)

### Task 13: Full regression + smoke

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`

Expected: All tests PASS.

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: `dist/index.js` produced.

- [ ] **Step 4: Smoke test — print mode**

Run: `BOOK_API_KEY=test node dist/index.js -p "What is 2+2?" --output-format json`

Expected: A JSON object with `result.messages` and `result.usage` printed to stdout.

- [ ] **Step 5: Smoke test — session resume**

Run two commands: first `node dist/index.js -p "remember the number 42"`, then `node dist/index.js -c -p "what number did I tell you?"`. Verify the second recalls 42.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore(m3): headless + sessions + compaction complete"
```

---

## M3 Definition of Done

- [ ] `book -p "query"` prints a result and exits (text/json/stream-json).
- [ ] `--input-format stream-json` reads newline-delimited user messages from stdin.
- [ ] `--json-schema` returns validated structured output.
- [ ] Sessions persist to `~/.book/sessions/<uuid>.jsonl`.
- [ ] `book -r <id|name>` and `book -c` resume sessions; `--fork-session` creates a new id.
- [ ] `--no-session-persistence` skips saving; `cleanupPeriodDays` purges old sessions.
- [ ] Context auto-compacts when usage exceeds 80% of `maxTokens`; `/compact` triggers it manually.
- [ ] `tsc --noEmit`, `vitest run`, and `npm run build` all succeed.
