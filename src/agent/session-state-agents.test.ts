import { describe, expect, it } from 'vitest';
import { renderSessionState } from './session-state.js';

/**
 * A lead that delegated in an earlier turn has nothing in context saying the
 * child is still working — a background spawn returns as soon as the child is
 * queued. Observed in the real TUI: the lead printed "Sidekick reported. Done."
 * 1.8s into a 6.1s run, and nothing on screen contradicted it.
 */
describe('outstanding delegated agents', () => {
  const base = { workspace: '/repo' } as const;

  it('names each unfinished agent and withholds their results', () => {
    const block = renderSessionState({
      ...base,
      outstandingAgents: [
        { label: 'explorer "map the auth module"', status: 'running' },
        { label: 'patcher "add the retry"', status: 'queued' },
      ],
    });
    expect(block).toContain('## Delegated agents still running');
    expect(block).toContain('- explorer "map the auth module" - running');
    expect(block).toContain('- patcher "add the retry" - queued');
    expect(block).toContain('Do not state, summarize, or imply what they found');
  });

  it('renders nothing when no delegation is outstanding', () => {
    const empty = renderSessionState({ ...base, outstandingAgents: [] });
    expect(empty).not.toContain('Delegated agents');
    // Absent and empty must be byte-identical: an ordinary session that never
    // delegated has to keep rendering exactly what it rendered before.
    expect(empty).toBe(renderSessionState({ ...base }));
  });

  it('keeps the task list rendering alongside it', () => {
    const block = renderSessionState({
      ...base,
      outstandingAgents: [{ label: 'explorer "trace auth"', status: 'running' }],
      todos: [{ content: 'Wire the handler', status: 'in_progress', activeForm: 'Wiring' }],
    });
    expect(block).toContain('## Delegated agents still running');
    expect(block).toContain('## Current task list');
  });
});
