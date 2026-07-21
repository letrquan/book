import { describe, expect, it } from 'vitest';
import type { SessionStoreInterface, ToolContext } from '../types.js';
import { createDefaultRegistry } from './registry.js';
import { READ_ONLY_PLAN_TOOLS } from './plan-mode.js';

describe('session history tools', () => {
  it('are capability-gated, current-session-only, untrusted, and read-only in plan mode', async () => {
    const store = {
      searchCurrent: (id: string) => [
        { ref: `session://current/event/${id}`, role: 'user', preview: 'evidence', timestamp: 1 },
      ],
      readCurrent: (_id: string, refs: string[]) => refs.map((ref) => ({ ref, content: 'exact' })),
    } as unknown as SessionStoreInterface;

    expect(createDefaultRegistry().getTool('SessionHistorySearch')).toBeUndefined();
    const registry = createDefaultRegistry({
      sessionHistory: { store, sessionId: () => 'active-id' },
    });
    const context: ToolContext = { workspaceRoot: '.', env: {} };
    const search = await registry.execute(
      { id: 's', name: 'SessionHistorySearch', arguments: { query: 'x' } },
      context,
    );
    expect(search.content).toContain('UNTRUSTED HISTORICAL DATA');
    expect(search.content).toContain('session://current/event/active-id');
    expect(READ_ONLY_PLAN_TOOLS.has('SessionHistorySearch')).toBe(true);
    expect(READ_ONLY_PLAN_TOOLS.has('SessionHistoryRead')).toBe(true);
  });
});
