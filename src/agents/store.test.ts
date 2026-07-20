import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStore } from './store.js';
import type { AgentRecord } from './types.js';

let root = '';

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('AgentStore recovery', () => {
  it('marks active persisted agents interrupted while preserving transcript and worktree references', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const store = new AgentStore('repo', root);
    const record: AgentRecord = {
      id: 'agent-1',
      name: 'patcher',
      role: 'patcher',
      description: 'patch',
      status: 'running',
      applicationStatus: 'not_applied',
      worktree: 'C:/worktree',
      branch: 'book-agent/test',
      prompt: 'continue',
      referencedEvidenceIds: [],
      transcript: [
        { id: 'a', role: 'assistant', content: 'partial', includeInContext: true, timestamp: 1 },
      ],
      pendingMessages: [],
      createdAt: 1,
      updatedAt: 1,
    };
    store.saveAgent(record);

    const restarted = new AgentStore('repo', root);
    restarted.markActiveInterrupted();
    const recovered = restarted.listAgents()[0];
    expect(recovered.status).toBe('interrupted');
    expect(recovered.stopReason).toBe('process_exit');
    expect(recovered.worktree).toBe('C:/worktree');
    expect(recovered.transcript[0].content).toBe('partial');
  });
});
