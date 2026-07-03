/**
 * /context helper — show what is filling the context window.
 *
 * Pure local computation from the live Message[] history. Token estimates use
 * the cheap-but-good-enough "(chars / 4)" heuristic (same family as every local
 * token estimator). The real per-turn token counts come from the provider via
 * onUsage; this is the structural breakdown the user asks for with /context.
 */
import type { Message } from './types.js';

/** Rough token estimate for an arbitrary string. ~4 chars/token for English/code. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

interface ContextBreakdown {
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  estimatedTokens: number;
  byRole: { user: number; assistant: number };
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
    const msgTokens = estimateTokens(m.content);
    if (m.role === 'user') {
      userMsgs++;
      userTokens += msgTokens;
    } else {
      assistantMsgs++;
      assistantTokens += msgTokens;
    }
    for (const c of m.toolCalls ?? []) toolCalls++;
    for (const r of m.toolResults ?? []) {
      toolResults++;
      // Tool result output is stored on the assistant message's toolResults (it
      // is echoed back as text content by the renderer), but the raw output
      // text contributes to tokens too — count it under assistant.
      assistantTokens += estimateTokens(r.output);
    }
  }

  return {
    totalMessages: messages.length,
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
    skillCount?: number;
    commandCount: number;
    /** Whether CLAUDE.md loader is wired (Phase 1b) — surfaced honestly. */
    hasClaudeMdLoader: boolean;
  },
): string {
  const b = buildContextBreakdown(messages);
  const lines: string[] = ['Context window breakdown', ''];
  lines.push(
    `Conversation messages: ${b.totalMessages} (user: ${b.userMessages}, assistant: ${b.assistantMessages})`,
  );
  lines.push(`Tool calls recorded: ${b.toolCalls}  •  tool results: ${b.toolResults}`);
  lines.push('');
  lines.push('Estimated tokens:');
  lines.push(`  Conversation total : ~${b.estimatedTokens.toLocaleString()}`);
  lines.push(`    user turns       : ~${b.byRole.user.toLocaleString()}`);
  lines.push(`    assistant turns  : ~${b.byRole.assistant.toLocaleString()}`);
  lines.push('');
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
  lines.push(`  System prompt + tool definitions (static, cached)`);
  lines.push(`  Slash commands  : ${ambient.commandCount} discoverable`);
  if (ambient.skillCount !== undefined) {
    lines.push(`  Skills          : ${ambient.skillCount} discoverable`);
  }
  if (ambient.hasClaudeMdLoader) {
    lines.push('  CLAUDE.md       : loaded (Phase 1b)');
  } else {
    lines.push('  CLAUDE.md       : not loaded yet (Phase 1b — memory/rules are not injected)');
  }
  lines.push('');
  lines.push(
    '(Token estimates use the chars/4 heuristic. Real counts come from the provider per turn — see /usage.)',
  );
  return lines.join('\n');
}
