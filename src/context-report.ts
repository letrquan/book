/**
 * /context helper — show what is filling the context window.
 *
 * Pure local computation from the live Message[] history. Token estimates use
 * the cheap-but-good-enough "(chars / 4)" heuristic (same family as every local
 * token estimator). The real per-turn token counts come from the provider via
 * onUsage; this is the structural breakdown the user asks for with /context.
 */
import type { CompactBoundary, Message } from './types.js';
import { estimateMessageTokens } from './agent/compact.js';

/** Rough token estimate for an arbitrary string. ~4 chars/token for English/code. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface ContextBreakdown {
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  estimatedTokens: number;
  byRole: { user: number; assistant: number };
}

/** Deterministic provider-facing footprint, including message structure and tool payloads. */
export function estimateMessageTokens(message: Message): number {
  if (!message.includeInContext || message.kind === 'local') return 0;

  let chars =
    16 +
    (message.role === 'user' ? (message.contextContent ?? message.content) : message.content)
      .length;
  for (const call of message.toolCalls ?? []) {
    chars += 24 + call.id.length + call.name.length + JSON.stringify(call.arguments ?? {}).length;
  }
  const callIds = new Set(message.toolCalls?.map((call) => call.id) ?? []);
  for (const result of message.toolResults ?? []) {
    if (!callIds.has(result.toolCallId)) continue;
    const rendered = result.success
      ? result.output
      : `ERROR: ${result.error ?? 'tool failed'}\n${result.output ?? ''}`;
    chars += 24 + result.toolCallId.length + rendered.length;
  }
  return estimateTokens('x'.repeat(chars));
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** Summarize the live history into a context-window breakdown. */
export function buildContextBreakdown(messages: Message[]): ContextBreakdown {
  let userTokens = 0;
  let assistantTokens = 0;
  let userMsgs = 0;
  let assistantMsgs = 0;
  let toolCalls = 0;
  let toolResults = 0;

  for (const m of messages) {
    if (!m.includeInContext) continue;
    const msgTokens = estimateTokens(m.contextContent ?? m.content) + 6;
    if (m.role === 'user') {
      userMsgs++;
      userTokens += msgTokens;
    } else {
      assistantMsgs++;
      assistantTokens += msgTokens;
    }
    for (const c of m.toolCalls ?? []) {
      toolCalls++;
      assistantTokens += estimateTokens(c.name) + estimateTokens(JSON.stringify(c.arguments)) + 12;
    }
    for (const r of m.toolResults ?? []) {
      toolResults++;
      // Tool result output is stored on the assistant message's toolResults (it
      // is echoed back as text content by the renderer), but the raw output
      // text contributes to tokens too — count it under assistant.
      assistantTokens += estimateTokens(r.output) + 12;
    }
  }

  return {
    totalMessages: userMsgs + assistantMsgs,
    userMessages: userMsgs,
    assistantMessages: assistantMsgs,
    toolCalls,
    toolResults,
    estimatedTokens: userTokens + assistantTokens,
    byRole: { user: userTokens, assistant: assistantTokens },
  };
}

/** Render a /context report string for the TUI. */
export function buildContextReport(
  messages: Message[],
  ambient: {
    model: string;
    maxTokens: number;
    contextHistory?: Message[];
    compactBoundaries?: CompactBoundary[];
    skillCount?: number;
    commandCount: number;
    subagentCount?: number;
    hasMemoryIndex?: boolean;
    /** Whether CLAUDE.md instructions were found for this workspace. */
    hasClaudeMdLoader: boolean;
    /** Full visible transcript when it differs from provider-facing messages. */
    transcriptMessages?: Message[];
  },
): string {
  const activeHistory = ambient.contextHistory ?? messages;
  const b = buildContextBreakdown(activeHistory);
  const visibleCount = messages.filter(
    (message) => message.kind !== 'checkpoint' && message.role !== undefined,
  ).length;
  const boundaries = ambient.compactBoundaries ?? [];
  const latestBoundary = boundaries.at(-1);
  const lines: string[] = ['Context window breakdown', ''];
  lines.push(`Visible transcript messages: ${visibleTranscript.length}`);
  lines.push(
    `Visible transcript messages: ${visibleCount}`,
    `Active provider-context messages: ${b.totalMessages} (user: ${b.userMessages}, assistant: ${b.assistantMessages})`,
    `Compact boundaries: ${boundaries.length}`,
  );
  lines.push(`Tool calls recorded: ${b.toolCalls}  •  tool results: ${b.toolResults}`);
  lines.push('');
  lines.push('Estimated tokens:');
  lines.push(`  Conversation total : ~${b.estimatedTokens.toLocaleString()}`);
  lines.push(`    user turns       : ~${b.byRole.user.toLocaleString()}`);
  lines.push(`    assistant turns  : ~${b.byRole.assistant.toLocaleString()}`);
  lines.push('');
  if (latestBoundary) {
    lines.push(
      `Most recent compact: generation ${latestBoundary.generation}` +
        (latestBoundary.preContextTokens !== undefined &&
        latestBoundary.postContextTokens !== undefined
          ? ` (~${latestBoundary.preContextTokens.toLocaleString()} → ~${latestBoundary.postContextTokens.toLocaleString()} tokens)`
          : ''),
    );
    lines.push('');
  }
  lines.push(
    `Model context budget: ${ambient.maxTokens.toLocaleString()} tokens (${ambient.model})`,
  );
  const pct =
    ambient.maxTokens > 0
      ? Math.min(100, Math.round((b.estimatedTokens / ambient.maxTokens) * 100))
      : 0;
  lines.push(`Conversation fills ~${pct}% of the window (before system prompt / tools).`);
  lines.push('');
  lines.push('Ambient context (injected per turn, not counted above):');
  lines.push(`  System prompt + tool definitions (static + dynamic sections)`);
  lines.push(`  Slash commands  : ${ambient.commandCount} discoverable`);
  if (ambient.skillCount !== undefined) {
    lines.push(`  Skills          : ${ambient.skillCount} discoverable`);
  }
  if (ambient.subagentCount !== undefined) {
    lines.push(`  Subagents       : ${ambient.subagentCount} discoverable`);
  }
  lines.push('  Git/workspace   : branch, status, OS, date');
  if (ambient.hasMemoryIndex !== undefined) {
    lines.push(
      `  Memory index    : ${ambient.hasMemoryIndex ? 'loaded (approved memory)' : 'none found'}`,
    );
  }
  if (ambient.hasClaudeMdLoader) {
    lines.push('  CLAUDE.md       : loaded (Phase 1b)');
  } else {
    lines.push('  CLAUDE.md       : none found (Phase 1b loader active)');
  }
  lines.push('');
  lines.push(
    '(Token estimates use the chars/4 heuristic. Real counts come from the provider per turn — see /usage.)',
  );
  return lines.join('\n');
}

/** Active provider-context estimate including structural and tool overhead. */
export function estimateActiveContextTokens(messages: Message[]): number {
  return messages.reduce(
    (total, message) => total + (message.includeInContext ? estimateMessageTokens(message) : 0),
    0,
  );
}
