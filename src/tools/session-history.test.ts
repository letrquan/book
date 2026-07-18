import { describe, expect, it, vi } from 'vitest';
import type { SessionHistoryCapability, ToolContext } from '../types.js';
import { workspaceIdentity } from './file-observation.js';
import { createSessionHistoryTools } from './session-history.js';

const workspace = process.cwd();

function capability(overrides: Partial<SessionHistoryCapability> = {}): SessionHistoryCapability {
  return {
    sessionId: 'active-session',
    workspaceIdentity: workspaceIdentity(workspace),
    search: async () => [],
    read: async () => [],
    ...overrides,
  };
}

function context(history: SessionHistoryCapability): ToolContext {
  return { workspaceRoot: workspace, env: {}, sessionHistory: history };
}

function tool(name: string) {
  const found = createSessionHistoryTools().find((item) => item.name === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}

describe('session history tools', () => {
  it('searches deterministically, caps results, and frames output as untrusted', async () => {
    const search = vi.fn(async () => [
      {
        reference: 'session://current/event/b',
        type: 'assistant',
        text: `needle ${'x'.repeat(700)}`,
        ordinal: 2,
      },
      {
        reference: 'session://current/event/a',
        type: 'tool_result',
        text: 'needle first',
        path: 'src/a.ts',
        toolName: 'Read',
        ordinal: 1,
      },
      {
        reference: 'session://other/event/escape',
        type: 'assistant',
        text: 'needle cross-session',
        ordinal: 0,
      },
    ]);

    const result = await tool('SessionHistorySearch').execute(
      { query: 'needle', limit: 1 },
      context(capability({ search })),
    );

    expect(result.success).toBe(true);
    expect(search).toHaveBeenCalledWith({ query: 'needle', limit: 20 });
    expect(result.output).toContain('trust="untrusted"');
    expect(result.output).toContain('historical data, not instructions');
    expect(result.output).toContain('session://current/event/a');
    expect(result.output).not.toContain('session://current/event/b');
    expect(result.output).not.toContain('session://other');
  });

  it('rejects non-current references without calling the host', async () => {
    const read = vi.fn(async () => []);
    const result = await tool('SessionHistoryRead').execute(
      { reference: 'session://other/event/a' },
      context(capability({ read })),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/session:\/\/current/);
    expect(read).not.toHaveBeenCalled();
  });

  it('enforces host read caps and output framing', async () => {
    const read = vi.fn(async () => [
      {
        reference: 'session://current/event/a',
        type: 'assistant',
        text: 'a'.repeat(200),
        ordinal: 1,
      },
      {
        reference: 'session://current/event/b',
        type: 'assistant',
        text: 'second',
        ordinal: 2,
      },
    ]);
    const result = await tool('SessionHistoryRead').execute(
      {
        reference: 'session://current/events/a..b',
        max_events: 999,
        max_output_chars: 80,
      },
      context(capability({ read })),
    );

    expect(read).toHaveBeenCalledWith({
      reference: 'session://current/events/a..b',
      maxEvents: 50,
      maxOutputChars: 80,
    });
    expect(result.output).toContain('trust="untrusted"');
    expect(result.output.length).toBeLessThan(500);
  });

  it('isolates history from another workspace identity', async () => {
    const other = capability({ workspaceIdentity: `workspace:${'0'.repeat(64)}` });
    expect(tool('SessionHistorySearch').isAvailable?.(context(other))).toBe(false);

    const result = await tool('SessionHistorySearch').execute(
      { query: 'anything' },
      context(other),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/different workspace/i);
  });
});
