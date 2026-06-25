# Book TUI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the Book agent's terminal UI to match Claude Code patterns — fixed bottom input, collapsible tool results, permission system with mode cycling, token-based theming, diff rendering, and inline permission prompts.

**Architecture:** Replace all 7 files in `src/tui/` (5 components, 2 hooks, 1 app) with 10 new files. Add 1 new hook (`useGitStatus`), rewrite `useAgent` with permission state management, update the agent loop with `onPermissionRequired` and `onTokenCount` callbacks, and extend types. The tool system, provider, context builder, config, and CLI entry remain mostly unchanged.

**Tech Stack:** Ink 6.x, React 19.x, ink-text-input 6.x, TypeScript 5.7, existing chalk/commander/fast-glob/ignore/zod dependencies.

---

### Task 1: Extend types with PermissionMode and AgentLoopCallbacks

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add PermissionMode and PermissionResult types, update AgentLoopCallbacks**

Replace `src/types.ts` entirely:

```typescript
export type PermissionMode = 'default' | 'auto' | 'plan' | 'accept-edits';

export type PermissionResult = 'allow' | 'deny' | 'always';

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

export interface AgentLoopCallbacks {
  onText: (text: string) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult) => void;
  onError: (error: string) => void;
  onTurnStart: (turn: number) => void;
  onDone: () => void;
  onPermissionRequired: (toolCall: ToolCall) => Promise<'allow' | 'deny' | 'always'>;
  onTokenCount: (count: number) => void;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS (might have errors in agent/loop.ts and tui/hooks/useAgent.ts since they reference the old `AgentLoopCallbacks` which was in loop.ts — if the plan moves it to types.ts there could be import issues. This step may fail until agent/loop.ts is updated in a later task.)

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add PermissionMode, PermissionResult types and extend AgentLoopCallbacks"
```

---

### Task 2: Create useAnimation hook with gradient spinners

**Files:**
- Modify: `src/tui/hooks/useAnimation.ts`

- [ ] **Step 1: Rewrite useAnimation.ts with gradient spinners**

Replace `src/tui/hooks/useAnimation.ts`:

```typescript
import { useState, useEffect, useRef } from 'react';

const BRAILLE_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
const DOT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function useSpinner(
  active: boolean,
  style: 'braille' | 'dots' = 'braille',
): { frame: string; colorIndex: number } {
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
  }, [active, frames.length]);

  const colorIndex = frame; // Each frame maps to a position for color cycling
  return { frame: frames[frame], colorIndex };
}

export function useTypewriter(
  text: string,
  speed: number,
  active: boolean,
): string {
  const [displayed, setDisplayed] = useState('');
  const prevTextRef = useRef(text);

  useEffect(() => {
    if (!active || !text) {
      setDisplayed(text);
      prevTextRef.current = text;
      return;
    }
    if (text !== prevTextRef.current) {
      setDisplayed('');
      prevTextRef.current = text;
    }
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(interval);
      }
    }, speed);
    return () => clearInterval(interval);
  }, [text, active, speed]);

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
  }, [active, interval]);

  return on;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS for this file, but there may be errors in consumers (Spinner.tsx) due to signature change.

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/useAnimation.ts
git commit -m "feat: add gradient spinner, improve typewriter with ref tracking"
```

---

### Task 3: Create Spinner component with gradient colors

**Files:**
- Modify: `src/tui/components/Spinner.tsx`

- [ ] **Step 1: Rewrite Spinner.tsx**

Replace `src/tui/components/Spinner.tsx`:

```typescript
import { Text } from 'ink';
import { useSpinner } from '../hooks/useAnimation.js';

const GRADIENT_COLORS = ['cyan', 'magenta'];

interface SpinnerProps {
  active?: boolean;
  style?: 'braille' | 'dots';
  color?: string;
}

export function Spinner({ active = true, style = 'braille', color }: SpinnerProps) {
  const { frame } = useSpinner(active, style);
  const spinnerColor = color || GRADIENT_COLORS[active ? 0 : 0];
  return <Text color={spinnerColor}>{frame} </Text>;
}

export { GRADIENT_COLORS };
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS if no other errors; Spinner consumers still expect string from useSpinner but now it returns an object. Will be resolved when consumers are updated in later tasks.

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/Spinner.tsx
git commit -m "feat: update Spinner to work with new useSpinner return type"
```

---

### Task 4: Create useGitStatus hook

**Files:**
- Create: `src/tui/hooks/useGitStatus.ts`

- [ ] **Step 1: Write useGitStatus.ts**

Create `src/tui/hooks/useGitStatus.ts`:

```typescript
import { useState, useEffect } from 'react';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

interface GitStatus {
  branch: string;
  status: string; // '✓' clean, '+2 ~1' staged/modified
  error?: string;
}

export function useGitStatus(workspace: string): GitStatus {
  const [status, setStatus] = useState<GitStatus>({ branch: '?', status: '' });

  useEffect(() => {
    let cancelled = false;

    function check() {
      if (!existsSync(join(workspace, '.git'))) {
        if (!cancelled) setStatus({ branch: '?', status: '' });
        return;
      }

      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: workspace,
          timeout: 5000,
          encoding: 'utf-8',
        }).trim();

        const short = execSync('git status --short', {
          cwd: workspace,
          timeout: 5000,
          encoding: 'utf-8',
        }).trim();

        if (!short) {
          if (!cancelled) setStatus({ branch, status: '\u2713' });
          return;
        }

        const lines = short.split('\n').filter(Boolean);
        let staged = 0;
        let modified = 0;
        for (const line of lines) {
          const stagedChar = line[0];
          const modChar = line[1];
          if (stagedChar !== ' ' && stagedChar !== '?') staged++;
          if (modChar !== ' ') modified++;
        }

        const parts: string[] = [];
        if (staged > 0) parts.push(`+${staged}`);
        if (modified > 0) parts.push(`~${modified}`);

        if (!cancelled) setStatus({ branch, status: parts.join(' ') });
      } catch {
        if (!cancelled) setStatus({ branch: '?', status: '', error: 'git error' });
      }
    }

    check();
    const interval = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspace]);

  return status;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/useGitStatus.ts
git commit -m "feat: add useGitStatus hook for status line git info"
```

---

### Task 5: Update agent loop with permission and token callbacks

**Files:**
- Modify: `src/agent/loop.ts`

- [ ] **Step 1: Rewrite loop.ts with permission checks and token counting**

Replace `src/agent/loop.ts`:

```typescript
import type { AgentConfig, Message, ToolCall, ToolResult, ToolContext, AgentLoopCallbacks } from '../types.js';
import { chatCompletionStream } from '../provider/openai-compatible.js';
import { buildMessages } from './context.js';
import type { ToolRegistry } from '../tools/registry.js';

const PERMISSION_TOOLS = new Set(['bash', 'write_file', 'edit_file', 'git_commit']);

function needsPermission(toolName: string, mode: string): boolean {
  if (mode === 'auto') return false;
  if (mode === 'plan') return true;
  if (mode === 'accept-edits') {
    return toolName !== 'edit_file' && toolName !== 'write_file';
  }
  // default mode
  return PERMISSION_TOOLS.has(toolName);
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
  let approveAll: string[] = [];

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

    // Estimate token count from assistant content length
    const estimatedTokens = assistantContent.length > 0
      ? Math.ceil(assistantContent.length / 4)
      : 0;
    callbacks.onTokenCount(estimatedTokens);

    const toolResults: ToolResult[] = [];
    for (const call of toolCalls) {
      if (needsPermission(call.name, 'default') && !approveAll.includes(call.name)) {
        const permission = await callbacks.onPermissionRequired(call);
        if (permission === 'deny') {
          toolResults.push({
            toolCallId: call.id,
            success: false,
            output: '',
            error: 'SKIPPED: Permission denied',
          });
          continue;
        }
        if (permission === 'always') {
          approveAll.push(call.name);
        }
      }

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

export { PERMISSION_TOOLS, needsPermission };
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat: add permission checking and token count callbacks to agent loop"
```

---

### Task 6: Rewrite useAgent hook with permission state management

**Files:**
- Modify: `src/tui/hooks/useAgent.ts`

- [ ] **Step 1: Rewrite useAgent.ts**

Replace `src/tui/hooks/useAgent.ts`:

```typescript
import { useState, useCallback, useRef } from 'react';
import type { Message, ToolCall, ToolResult, PermissionResult, PermissionMode } from '../../types.js';
import { runAgentLoop } from '../../agent/loop.js';
import { createDefaultRegistry } from '../../tools/registry.js';
import type { AgentConfig } from '../../types.js';

export function useAgent(config: AgentConfig) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [tokenCount, setTokenCount] = useState(0);
  const [mode, setMode] = useState<PermissionMode>('default');
  const [pendingPermission, setPendingPermission] = useState<{
    toolCall: ToolCall;
    resolve: (value: PermissionResult) => void;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (userMessage: string) => {
      if (isThinking) return;
      setIsThinking(true);
      setError(null);
      setStreamedText('');
      setCurrentTurn(0);
      setTokenCount(0);

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
          onPermissionRequired: (toolCall: ToolCall): Promise<PermissionResult> => {
            return new Promise((resolve) => {
              setPendingPermission({ toolCall, resolve });
            });
          },
          onTokenCount: (count: number) => {
            setTokenCount((prev) => prev + count);
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

  const resolvePermission = useCallback(
    (result: PermissionResult) => {
      if (pendingPermission) {
        pendingPermission.resolve(result);
        setPendingPermission(null);
      }
    },
    [pendingPermission],
  );

  const cancelPermission = useCallback(() => {
    if (pendingPermission) {
      pendingPermission.resolve('deny');
      setPendingPermission(null);
    }
  }, [pendingPermission]);

  const clear = useCallback(() => {
    setMessages([]);
    setError(null);
    setStreamedText('');
    setCurrentTurn(0);
    setTokenCount(0);
    setPendingPermission(null);
  }, []);

  const cycleMode = useCallback(() => {
    const modes: PermissionMode[] = ['default', 'auto', 'plan', 'accept-edits'];
    setMode((prev) => {
      const idx = modes.indexOf(prev);
      return modes[(idx + 1) % modes.length];
    });
  }, []);

  return {
    messages,
    isThinking,
    streamedText,
    error,
    currentTurn,
    tokenCount,
    mode,
    pendingPermission,
    send,
    clear,
    resolvePermission,
    cancelPermission,
    cycleMode,
  };
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS (AgentLoopCallbacks now comes from types.ts)

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/useAgent.ts
git commit -m "feat: add permission state management and mode cycling to useAgent"
```

---

### Task 7: Create UserMessage component

**Files:**
- Create: `src/tui/components/UserMessage.tsx`

- [ ] **Step 1: Write UserMessage.tsx**

Create `src/tui/components/UserMessage.tsx`:

```typescript
import { Box, Text } from 'ink';

interface UserMessageProps {
  content: string;
}

export function UserMessage({ content }: UserMessageProps) {
  return (
    <Box marginY={1} paddingLeft={1}>
      <Box marginRight={1}>
        <Text color="cyan" bold>You</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color="white">{content}</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/UserMessage.tsx
git commit -m "feat: add UserMessage component with 'You' label"
```

---

### Task 8: Create ToolCallBlock with collapsible state

**Files:**
- Modify: `src/tui/components/ToolCallBlock.tsx`

- [ ] **Step 1: Rewrite ToolCallBlock.tsx with expand/collapse**

Replace `src/tui/components/ToolCallBlock.tsx`:

```typescript
import { Text, Box } from 'ink';
import { useState } from 'react';
import { Spinner } from './Spinner.js';
import type { ToolResult } from '../../types.js';

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  isExpanded: boolean;
  onToggle: () => void;
  isPending?: boolean;
}

function getPrimaryArg(args: Record<string, unknown>): string {
  if (typeof args.filePath === 'string') return args.filePath;
  if (typeof args.command === 'string') return args.command.split('\n')[0];
  if (typeof args.pattern === 'string') return args.pattern;
  if (typeof args.message === 'string') return args.message;
  if (typeof args.old_string === 'string') return args.old_string.slice(0, 60);
  const keys = Object.keys(args);
  if (keys.length > 0) {
    const firstVal = args[keys[0]];
    return typeof firstVal === 'string' ? firstVal.slice(0, 60) : '';
  }
  return '';
}

function getResultLabel(result?: ToolResult): { label: string; color: string } {
  if (!result) return { label: '', color: 'gray' };
  if (result.error?.startsWith('SKIPPED')) return { label: '[SKIPPED]', color: 'yellow' };
  if (!result.success) return { label: '[ERR]', color: 'red' };
  const lines = result.output.split('\n').length;
  return { label: '[OK]', color: 'green' };
}

function renderDiff(output: string): Array<{ text: string; bgColor?: string }> {
  const lines = output.split('\n');
  return lines.map((line) => {
    if (line.startsWith('+')) return { text: line, bgColor: 'green' };
    if (line.startsWith('-')) return { text: line, bgColor: 'red' };
    return { text: line };
  });
}

function isDiffOutput(toolName: string, result: ToolResult | undefined): boolean {
  if (!result?.success) return false;
  if (toolName !== 'edit_file' && toolName !== 'write_file') return false;
  const output = result.output;
  if (!output) return false;
  const plusLines = output.split('\n').filter((l) => l.startsWith('+')).length;
  const minusLines = output.split('\n').filter((l) => l.startsWith('-')).length;
  return plusLines > 0 || minusLines > 0;
}

export function ToolCallBlock({ name, args, result, isExpanded, onToggle, isPending }: ToolCallBlockProps) {
  const isRunning = !result && !isPending;
  const primaryArg = getPrimaryArg(args);
  const { label, color } = getResultLabel(result);

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color="magenta">
          {isExpanded ? '\u25bc' : '\u25b6'}{' '}
        </Text>
        {isRunning ? (
          <Spinner active style="dots" />
        ) : (
          <Text color={color}>{label} </Text>
        )}
        <Text color="magenta">{name}</Text>
        {primaryArg ? (
          <Text color="gray"> {primaryArg.slice(0, 60)}</Text>
        ) : null}
      </Box>
      {isExpanded && result && isDiffOutput(name, result) ? (
        renderDiff(result.output).map((line, i) => (
          <Box key={i} marginLeft={2}>
            <Text
              color={line.bgColor === 'green' ? 'green' : line.bgColor === 'red' ? 'red' : 'gray'}
            >
              {'\u2502'} {line.text.slice(0, 120)}
            </Text>
          </Box>
        ))
      ) : isExpanded && result?.output ? (
        result.output.split('\n').slice(0, 20).map((line, i) => (
          <Box key={i} marginLeft={2}>
            <Text color="gray">{'\u2502'} {line.slice(0, 120)}</Text>
          </Box>
        ))
      ) : null}
      {isExpanded && result?.error && !result.error.startsWith('SKIPPED') ? (
        <Box marginLeft={2}>
          <Text color="red">{'\u2502'} {result.error.slice(0, 120)}</Text>
        </Box>
      ) : null}
      {isPending ? (
        <Box marginLeft={2}>
          <Text color="yellow">[needs approval]</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export { isDiffOutput, getPrimaryArg, getResultLabel, renderDiff };
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/ToolCallBlock.tsx
git commit -m "feat: add collapsible ToolCallBlock with diff rendering"
```

---

### Task 9: Create PermissionButtons component

**Files:**
- Create: `src/tui/components/PermissionButtons.tsx`

- [ ] **Step 1: Write PermissionButtons.tsx**

Create `src/tui/components/PermissionButtons.tsx`:

```typescript
import { Box, Text } from 'ink';
import { useState } from 'react';
import { useInput } from 'ink';
import type { PermissionResult, ToolCall } from '../../types.js';

interface PermissionButtonsProps {
  toolCall: ToolCall;
  onResolve: (result: PermissionResult) => void;
}

const BUTTONS: { label: string; value: PermissionResult }[] = [
  { label: 'Run', value: 'allow' },
  { label: 'Skip', value: 'deny' },
  { label: 'Always allow', value: 'always' },
];

export function PermissionButtons({ toolCall, onResolve }: PermissionButtonsProps) {
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.leftArrow) {
      setSelected((s) => (s - 1 + BUTTONS.length) % BUTTONS.length);
    } else if (key.rightArrow) {
      setSelected((s) => (s + 1) % BUTTONS.length);
    } else if (key.return) {
      onResolve(BUTTONS[selected].value);
    } else if (key.escape) {
      onResolve('deny');
    }
  });

  return (
    <Box marginLeft={2} marginY={1}>
      {BUTTONS.map((btn, i) => (
        <Box key={btn.label} marginRight={1}>
          <Text
            backgroundColor={i === selected ? 'white' : undefined}
            color={i === selected ? 'black' : 'white'}
          >
            [{btn.label}]
          </Text>
        </Box>
      ))}
    </Box>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/PermissionButtons.tsx
git commit -m "feat: add PermissionButtons with arrow key navigation"
```

---

### Task 10: Create AgentMessage component with Book label

**Files:**
- Modify: `src/tui/components/AgentMessage.tsx`

- [ ] **Step 1: Rewrite AgentMessage.tsx**

Replace `src/tui/components/AgentMessage.tsx`:

```typescript
import { Text, Box } from 'ink';
import { Spinner } from './Spinner.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { PermissionButtons } from './PermissionButtons.js';
import { usePulse } from '../hooks/useAnimation.js';
import type { Message, ToolCall, PermissionResult } from '../../types.js';

interface PendingPermission {
  toolCall: ToolCall;
  resolve: (value: PermissionResult) => void;
}

interface AgentMessageProps {
  message: Message;
  isStreaming: boolean;
  streamedText: string;
  pendingPermission?: PendingPermission | null;
  onResolvePermission?: (result: PermissionResult) => void;
  activeToolCallId?: string | null;
}

export function AgentMessage({
  message,
  isStreaming,
  streamedText,
  pendingPermission,
  onResolvePermission,
  activeToolCallId,
}: AgentMessageProps) {
  const isPulse = usePulse(isStreaming && !message.content && !message.toolCalls?.length, 500);
  const displayContent = isStreaming ? streamedText : message.content;

  return (
    <Box flexDirection="column" marginY={1}>
      <Box paddingLeft={1} marginBottom={1}>
        <Text color="cyan" bold>Book</Text>
      </Box>
      <Box flexDirection="column">
        {isStreaming && !displayContent && !message.toolCalls?.length ? (
          <Box marginLeft={2}>
            <Spinner active style="braille" />
            <Text color="gray">Thinking...</Text>
          </Box>
        ) : null}
        {displayContent ? (
          <Box marginLeft={2}>
            {isStreaming && <Spinner active style="braille" />}
            <Text color="white">{displayContent}</Text>
          </Box>
        ) : null}
        {message.toolCalls?.map((tc, i) => {
          const result = message.toolResults?.find((r) => r.toolCallId === tc.id);
          const isPending = pendingPermission?.toolCall.id === tc.id;
          return (
            <Box key={tc.id || i} flexDirection="column">
              <ToolCallBlock
                name={tc.name}
                args={tc.arguments}
                result={result}
                isExpanded={activeToolCallId === tc.id}
                onToggle={() => {}}
                isPending={isPending}
              />
              {isPending && onResolvePermission ? (
                <PermissionButtons
                  toolCall={tc}
                  onResolve={onResolvePermission}
                />
              ) : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/AgentMessage.tsx
git commit -m "feat: update AgentMessage with Book label, permission integration"
```

---

### Task 11: Create ChatPanel with flexGrow layout

**Files:**
- Modify: `src/tui/components/ChatPanel.tsx`

- [ ] **Step 1: Rewrite ChatPanel.tsx**

Replace `src/tui/components/ChatPanel.tsx`:

```typescript
import { Box, Text } from 'ink';
import type { Message, ToolCall, PermissionResult } from '../../types.js';
import { AgentMessage } from './AgentMessage.js';
import { UserMessage } from './UserMessage.js';

interface PendingPermission {
  toolCall: ToolCall;
  resolve: (value: PermissionResult) => void;
}

interface ChatPanelProps {
  messages: Message[];
  streamingMessage?: Message;
  streamedText: string;
  pendingPermission?: PendingPermission | null;
  onResolvePermission?: (result: PermissionResult) => void;
  activeToolCallId?: string | null;
}

export function ChatPanel({
  messages,
  streamingMessage,
  streamedText,
  pendingPermission,
  onResolvePermission,
  activeToolCallId,
}: ChatPanelProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg) => {
        if (msg.role === 'user') {
          return <UserMessage key={msg.id} content={msg.content} />;
        }
        return (
          <AgentMessage
            key={msg.id}
            message={msg}
            isStreaming={msg === streamingMessage}
            streamedText={streamedText}
            pendingPermission={pendingPermission}
            onResolvePermission={onResolvePermission}
            activeToolCallId={activeToolCallId}
          />
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/ChatPanel.tsx
git commit -m "feat: update ChatPanel with flexGrow layout and permission pass-through"
```

---

### Task 12: Create StatusLine component

**Files:**
- Create: `src/tui/components/StatusLine.tsx`

- [ ] **Step 1: Write StatusLine.tsx**

Create `src/tui/components/StatusLine.tsx`:

```typescript
import { Box, Text } from 'ink';
import { usePulse } from '../hooks/useAnimation.js';
import { useGitStatus } from '../hooks/useGitStatus.js';

interface StatusLineProps {
  model: string;
  currentTurn: number;
  maxTurns: number;
  tokenCount: number;
  maxTokens?: number;
  workspace: string;
}

export function StatusLine({ model, currentTurn, maxTurns, tokenCount, maxTokens = 128000, workspace }: StatusLineProps) {
  const gitStatus = useGitStatus(workspace);
  const nearLimit = maxTokens > 0 && tokenCount > maxTokens * 0.8;
  const blink = usePulse(nearLimit && tokenCount > 0, 500);

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="gray">model: </Text>
      <Text color="white">{model}</Text>
      <Text color="gray"> {'\u2502'} turn </Text>
      <Text color="white">{currentTurn}/{maxTurns}</Text>
      <Text color="gray"> {'\u2502'} tokens </Text>
      <Text color={nearLimit && blink ? 'red' : 'white'}>
        {(tokenCount / 1000).toFixed(1)}k/{maxTokens > 0 ? `${(maxTokens / 1000).toFixed(0)}k` : '?'}
      </Text>
      <Text color="gray"> {'\u2502'} </Text>
      <Text color="white">{gitStatus.branch}</Text>
      <Text color="gray"> {gitStatus.status}</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/StatusLine.tsx
git commit -m "feat: add StatusLine with model, turn, token, git info"
```

---

### Task 13: Create InputBar with mode badge and cycling

**Files:**
- Modify: `src/tui/components/InputBar.tsx`

- [ ] **Step 1: Rewrite InputBar.tsx**

Replace `src/tui/components/InputBar.tsx`:

```typescript
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useState, useCallback } from 'react';
import { useInput } from 'ink';
import type { PermissionMode } from '../../types.js';

const MODE_BORDER_COLORS: Record<PermissionMode, string> = {
  default: 'cyan',
  auto: 'yellow',
  plan: 'magenta',
  'accept-edits': 'green',
};

interface InputBarProps {
  onSubmit: (value: string) => void;
  disabled: boolean;
  mode: PermissionMode;
  onCycleMode: () => void;
}

export function InputBar({ onSubmit, disabled, mode, onCycleMode }: InputBarProps) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);

  useInput((_input, key) => {
    if (key.shift && key.tab) {
      onCycleMode();
    }
  });

  const handleSubmit = useCallback(
    (val: string) => {
      if (!val.trim() || disabled) return;
      setHistory((h) => [val, ...h].slice(0, 100));
      onSubmit(val);
      setValue('');
    },
    [disabled, onSubmit],
  );

  return (
    <Box borderStyle="round" borderColor={MODE_BORDER_COLORS[mode]} paddingX={1}>
      {disabled ? (
        <Text color="gray">(thinking...)</Text>
      ) : (
        <>
          <Text color={MODE_BORDER_COLORS[mode]}>{'> '}</Text>
          <Box flexGrow={1}>
            <TextInput
              value={value}
              onChange={setValue}
              onSubmit={handleSubmit}
            />
          </Box>
        </>
      )}
      <Box marginLeft={1}>
        <Text color={MODE_BORDER_COLORS[mode]}>[{mode}]</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/InputBar.tsx
git commit -m "feat: update InputBar with mode badge, Shift+Tab cycling"
```

---

### Task 14: Rewrite App component with new layout

**Files:**
- Modify: `src/tui/app.tsx`
- Delete: `src/tui/components/Header.tsx`
- Delete: `src/tui/components/StatusBar.tsx`

- [ ] **Step 1: Rewrite app.tsx**

Replace `src/tui/app.tsx`:

```typescript
import { Box, Text, useInput } from 'ink';
import { useState, useCallback } from 'react';
import { ChatPanel } from './components/ChatPanel.js';
import { InputBar } from './components/InputBar.js';
import { StatusLine } from './components/StatusLine.js';
import { useAgent } from './hooks/useAgent.js';
import type { AgentConfig } from '../types.js';

interface AppProps {
  config: AgentConfig;
}

export function App({ config }: AppProps) {
  const {
    messages,
    isThinking,
    streamedText,
    error,
    currentTurn,
    tokenCount,
    mode,
    pendingPermission,
    send,
    clear,
    resolvePermission,
    cancelPermission,
    cycleMode,
  } = useAgent(config);

  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);

  const streamingMessage = isThinking
    ? messages[messages.length - 1]
    : undefined;

  useInput((_input, key) => {
    if (key.escape && pendingPermission) {
      cancelPermission();
    }
  });

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
    <Box flexDirection="column" padding={1} height={process.stdout.rows}>
      <ChatPanel
        messages={messages}
        streamingMessage={streamingMessage}
        streamedText={streamedText}
        pendingPermission={pendingPermission}
        onResolvePermission={resolvePermission}
        activeToolCallId={expandedToolId}
      />
      {error && (
        <Box>
          <Text color="red">{error}</Text>
        </Box>
      )}
      <StatusLine
        model={config.model}
        currentTurn={currentTurn}
        maxTurns={config.maxTurns}
        tokenCount={tokenCount}
        workspace={config.workspace}
      />
      <InputBar
        onSubmit={handleSubmit}
        disabled={isThinking || pendingPermission !== null}
        mode={mode}
        onCycleMode={cycleMode}
      />
    </Box>
  );
}
```

- [ ] **Step 2: Delete Header.tsx and StatusBar.tsx**

```bash
rm src/tui/components/Header.tsx src/tui/components/StatusBar.tsx
```

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat: rewrite App with ChatPanel, StatusLine, InputBar layout"
```

---

### Task 15: Add mode parameter to agent loop permission check

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/tui/hooks/useAgent.ts`

- [ ] **Step 1: Add mode parameter to runAgentLoop**

Edit `src/agent/loop.ts` — change the function signature to accept a `mode` parameter:

Find:
```typescript
export async function runAgentLoop(
  config: AgentConfig,
  registry: ToolRegistry,
  userMessage: string,
  history: Message[],
  callbacks: AgentLoopCallbacks,
): Promise<Message[]> {
```

Replace with:
```typescript
export async function runAgentLoop(
  config: AgentConfig,
  registry: ToolRegistry,
  userMessage: string,
  history: Message[],
  callbacks: AgentLoopCallbacks,
  mode: string = 'default',
): Promise<Message[]> {
```

Then find the permission check line:
```typescript
      if (needsPermission(call.name, 'default') && !approveAll.includes(call.name)) {
```

Replace with:
```typescript
      if (needsPermission(call.name, mode) && !approveAll.includes(call.name)) {
```

- [ ] **Step 2: Update useAgent to pass mode as 6th argument**

In `src/tui/hooks/useAgent.ts`, the current call is:
```typescript
        const newHistory = await runAgentLoop(config, registry, userMessage, messages, {
          onText: ...
          ...
        });
```

Add `mode` as the 6th argument (after the callbacks object). Find:
```typescript
          onTokenCount: (count: number) => {
            setTokenCount((prev) => prev + count);
          },
        });
```

Replace with:
```typescript
          onTokenCount: (count: number) => {
            setTokenCount((prev) => prev + count);
          },
        }, mode);
```

Add `mode` to the dependency array. Find:
```typescript
    [config, isThinking, messages],
```

Replace with:
```typescript
    [config, isThinking, messages, mode],
```

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/agent/loop.ts src/tui/hooks/useAgent.ts
git commit -m "feat: pass permission mode from TUI to agent loop"
```

---

### Task 16: Add bgColor support for diff rendering in App

**Files:**
- Modify: `src/tui/app.tsx`

- [ ] **Step 1: Add auto-expand latest tool call logic**

In `src/tui/app.tsx`, add a `useEffect` to auto-expand the latest tool call when a new tool is executing. Add this after the state declarations, before the render:

Currently the app has `const [expandedToolId, setExpandedToolId] = useState<string | null>(null);` but no logic to auto-set it.

Find:
```typescript
import { Box, Text, useInput } from 'ink';
import { useState, useCallback } from 'react';
```

Replace with:
```typescript
import { Box, Text, useInput } from 'ink';
import { useState, useCallback, useEffect } from 'react';
```

After the `useInput` block, find:
```typescript
  const handleSubmit = useCallback(
```

Add before `handleSubmit`:
```typescript
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'assistant' && lastMsg.toolCalls?.length) {
      const latestTool = lastMsg.toolCalls[lastMsg.toolCalls.length - 1];
      if (!lastMsg.toolResults?.find(r => r.toolCallId === latestTool.id)) {
        setExpandedToolId(latestTool.id);
      }
    } else {
      setExpandedToolId(null);
    }
  }, [messages]);
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat: auto-expand current tool call, collapse previous ones"
```

---

### Task 17: Final integration — fix import paths and test full build

**Files:**
- Check all files for correct imports

- [ ] **Step 1: Run typecheck and fix any issues**

```bash
npx tsc --noEmit
```

Expected: PASS with zero errors. If any import errors, fix them.

- [ ] **Step 2: Run build**

```bash
npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: final integration fixes, remove unused files"
```
