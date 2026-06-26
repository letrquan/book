import { describe, it, expect } from 'vitest';
import { shouldCompact, compactHistory, buildCompactPrompt } from './compact.js';
import type { Message, Usage } from '../types.js';

describe('shouldCompact', () => {
  it('returns false when usage is below threshold', () => {
    const usage: Usage = { promptTokens: 8000, completionTokens: 2000, totalTokens: 10000 };
    expect(shouldCompact(usage, 128000, 0.8)).toBe(false);
  });

  it('returns true when usage exceeds threshold', () => {
    const usage: Usage = { promptTokens: 100000, completionTokens: 5000, totalTokens: 105000 };
    expect(shouldCompact(usage, 128000, 0.8)).toBe(true);
  });

  it('returns false when no usage', () => {
    expect(shouldCompact(null, 128000, 0.8)).toBe(false);
  });
});

describe('compactHistory', () => {
  it('keeps the last K turns, returns the rest for summarization', () => {
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
    expect(summarized[0].content).toBe('old1');
  });

  it('returns empty summarized when history is short', () => {
    const history: Message[] = [
      { id: '1', role: 'user', content: 'only', timestamp: 0 },
    ];
    const { kept, summarized } = compactHistory(history, 2);
    expect(kept.length).toBe(1);
    expect(summarized.length).toBe(0);
  });
});

describe('buildCompactPrompt', () => {
  it('builds a summarization prompt from the summarized turns', () => {
    const summarized: Message[] = [
      { id: '1', role: 'user', content: 'do X', timestamp: 0 },
      { id: '2', role: 'assistant', content: 'done X', timestamp: 0 },
    ];
    const prompt = buildCompactPrompt(summarized);
    expect(prompt).toMatch(/Summarize/);
    expect(prompt).toMatch(/User: do X/);
    expect(prompt).toMatch(/Assistant: done X/);
  });
});
