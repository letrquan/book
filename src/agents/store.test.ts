import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  it('migrates version 1 records to explicit version 2 profile and run fields', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const directory = join(root, 'repo');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'state.json'),
      JSON.stringify({
        version: 1,
        plans: [],
        evidence: [],
        snapshots: [],
        agents: [
          {
            id: 'old',
            name: 'explorer',
            role: 'explorer',
            description: 'Explore',
            status: 'completed',
            applicationStatus: 'not_applied',
            prompt: 'Trace authentication flow.',
            referencedEvidenceIds: [],
            transcript: [],
            pendingMessages: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    const store = new AgentStore('repo', root);
    const [record] = store.listAgents();
    expect(record.profile).toBe('explorer');
    expect(record.displayName).toBe('Trace authentication flow');
    expect(record.resolvedModel).toBe('unknown');
    expect(record.producedEvidenceIds).toEqual([]);
    expect(record.finishedAt).toBe(1);
    expect(record.completionSequence).toBe(1);
    expect(record.completionDeliveredSequence).toBe(1);
    store.saveAgent(record);
    expect(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).version).toBe(2);
  });

  it('marks active persisted agents interrupted while preserving transcript and worktree references', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const store = new AgentStore('repo', root);
    const record: AgentRecord = {
      id: 'agent-1',
      name: 'patcher',
      role: 'patcher',
      description: 'patch',
      status: 'waiting_permission',
      applicationStatus: 'not_applied',
      worktree: 'C:/worktree',
      branch: 'book-agent/test',
      prompt: 'continue',
      referencedEvidenceIds: [],
      transcript: [
        { id: 'a', role: 'assistant', content: 'partial', includeInContext: true, timestamp: 1 },
      ],
      pendingMessages: [],
      pendingPermission: {
        id: 'permission-1',
        agentId: 'agent-1',
        displayName: 'Patcher',
        toolName: 'Read',
        toolCall: { id: 'read-1', name: 'Read', arguments: { filePath: 'README.md' } },
        createdAt: 1,
      },
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
    expect(recovered.completionSequence).toBe(1);
    expect(recovered.completionDeliveredSequence).toBe(0);
    expect(recovered.pendingPermission).toBeUndefined();
  });
});
