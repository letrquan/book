import { describe, it, expect } from 'vitest';
import { estimateTokens, buildContextBreakdown, buildContextReport } from './context-report.js';
import type { Message } from './types.js';

function msg(role: 'user' | 'assistant', content: string, toolCalls = 0, toolResults = 0): Message {
  const m: Message = {
    id: crypto.randomUUID(),
    role,
    content,
    includeInContext: true,
    timestamp: 0,
  };
  if (toolCalls)
    m.toolCalls = Array.from({ length: toolCalls }, () => ({ id: 't', name: 'Read' }) as never);
  if (toolResults)
    m.toolResults = Array.from(
      { length: toolResults },
      () => ({ toolCallId: 'x', success: true, output: 'x'.repeat(40) }) as never,
    );
  return m;
}

describe('estimateTokens', () => {
  it('rounds up chars/4', () => {
    expect(estimateTokens('1234567')).toBe(2); // ceil(7/4)
    expect(estimateTokens('')).toBe(0);
  });
});

describe('buildContextBreakdown', () => {
  it('counts messages, roles, tool calls/results', () => {
    const messages: Message[] = [
      msg('user', 'hello world this is a prompt'),
      msg('assistant', 'reply with some words here too', 2, 1),
    ];
    const b = buildContextBreakdown(messages);
    expect(b.totalMessages).toBe(2);
    expect(b.userMessages).toBe(1);
    expect(b.assistantMessages).toBe(1);
    expect(b.toolCalls).toBe(2);
    expect(b.toolResults).toBe(1);
    expect(b.estimatedTokens).toBeGreaterThan(0);
  });

  it('excludes local-only messages from context totals', () => {
    const local = msg('assistant', 'x'.repeat(400));
    local.includeInContext = false;

    const b = buildContextBreakdown([msg('user', 'real prompt'), local]);

    expect(b.totalMessages).toBe(1);
    expect(b.userMessages).toBe(1);
    expect(b.assistantMessages).toBe(0);
    expect(b.estimatedTokens).toBe(3);
  });

  it('handles empty conversation', () => {
    const b = buildContextBreakdown([]);
    expect(b.totalMessages).toBe(0);
    expect(b.estimatedTokens).toBe(0);
  });
});

describe('buildContextReport', () => {
  it('produces a human-readable report with budget percentage', () => {
    const messages: Message[] = [msg('user', 'hello world this is a prompt', 0, 0)];
    const report = buildContextReport(messages, {
      model: 'claude-sonnet-5',
      maxTokens: 100000,
      commandCount: 5,
      hasClaudeMdLoader: false,
    });
    expect(report).toContain('Context window breakdown');
    expect(report).toContain('claude-sonnet-5');
    expect(report).toContain('100,000');
    expect(report).toContain('Slash commands  : 5');
    expect(report).toContain('Git/workspace   : branch, status, OS, date');
    expect(report).toContain('none found (Phase 1b loader active)');
  });

  it('reports when CLAUDE.md instructions are loaded', () => {
    const report = buildContextReport([], {
      model: 'claude-sonnet-5',
      maxTokens: 100000,
      commandCount: 5,
      subagentCount: 2,
      hasMemoryIndex: true,
      hasClaudeMdLoader: true,
    });

    expect(report).toContain('CLAUDE.md       : loaded (Phase 1b)');
    expect(report).toContain('Subagents       : 2 discoverable');
    expect(report).toContain('Memory index    : loaded');
  });
});
