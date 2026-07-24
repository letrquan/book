import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AtomicJsonWriter } from './atomic-json.js';
import { AgentStore } from './store.js';
import type { AgentRecord, EvidenceItem } from './types.js';

let root = '';

afterEach(() => {
  vi.useRealTimers();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('AgentStore recovery', () => {
  it('quarantines corrupt version 3 record files and loads the remaining store', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const directory = join(root, 'repo');
    const records = join(directory, 'records');
    mkdirSync(records, { recursive: true });
    writeFileSync(join(directory, 'state.json'), JSON.stringify({ version: 3 }));
    writeFileSync(join(records, 'broken.json'), '{not valid json');

    const store = new AgentStore('repo', root);

    expect(store.listAgents()).toEqual([]);
    expect(readdirSync(records).some((name) => name.startsWith('broken.json.corrupt-'))).toBe(true);
  });

  it('migrates monolithic records to version 3 per-record storage', () => {
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
    expect(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).version).toBe(3);
    expect(existsSync(join(directory, 'records', 'old.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(directory, 'records', 'old.json'), 'utf8'))).toMatchObject({
      id: 'old',
      profile: 'explorer',
    });
    store.dispose();
  });

  it('marks active persisted agents interrupted while preserving transcript and worktree references', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const store = new AgentStore('repo', root, true, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 12345,
      hostname: 'test-host',
      now: () => 1,
    });
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

    const restarted = new AgentStore('repo', root, true, {
      instanceId: '22222222-2222-4222-8222-222222222222',
      pid: 23456,
      hostname: 'test-host',
      now: () => 100_000,
      processAlive: () => false,
    });
    restarted.markActiveInterrupted();
    const recovered = restarted.listAgents()[0];
    const detailed = restarted.loadAgent(record.id)!;
    expect(recovered.status).toBe('interrupted');
    expect(recovered.stopReason).toBe('process_exit');
    expect(recovered.worktree).toBe('C:/worktree');
    expect(recovered.transcript).toEqual([]);
    expect(detailed.transcript[0].content).toBe('partial');
    expect(recovered.completionSequence).toBe(1);
    expect(recovered.completionDeliveredSequence).toBe(0);
    expect(recovered.pendingPermission).toBeUndefined();
    store.dispose();
    restarted.dispose();
  });

  it('does not interrupt an active agent owned by a live Book instance', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const first = new AgentStore('repo', root, true, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 12345,
      hostname: 'test-host',
      now: () => 10,
    });
    const active = {
      ...recordFixture('live-agent'),
      status: 'running' as const,
    };
    first.saveAgent(active, { required: true });

    const second = new AgentStore('repo', root, true, {
      instanceId: '22222222-2222-4222-8222-222222222222',
      pid: 23456,
      hostname: 'test-host',
      now: () => 20,
      processAlive: () => true,
    });

    expect(second.recoverAbandonedAgents()).toEqual([]);
    expect(second.listAgents()[0]?.status).toBe('running');
    expect(second.isOwnedByLiveForeign('live-agent')).toBe(true);
    first.dispose();
    second.dispose();
  });

  it('coalesces deferred writes, emits one degraded event, and recovers after retry', () => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    let recordAttempts = 0;
    const persisted: AgentRecord[] = [];
    const writer = {
      write: vi.fn((target: string, value: unknown) => {
        if (!target.includes(`${join('records', '')}`)) {
          return { status: 'ok', target, attempts: 1, elapsedMs: 0 } as const;
        }
        recordAttempts++;
        if (recordAttempts === 1) {
          return {
            status: 'busy',
            target,
            operation: 'rename',
            attempts: 4,
            elapsedMs: 500,
          } as const;
        }
        persisted.push(structuredClone(value as AgentRecord));
        return { status: 'ok', target, attempts: 1, elapsedMs: 0 } as const;
      }),
    } as unknown as AtomicJsonWriter;
    const events: Array<{ state: string }> = [];
    const store = new AgentStore('repo', root, true, {
      writer,
      eventSink: (event) => events.push(event),
    });
    const record = recordFixture('queued-agent');

    store.saveAgent(record, { defer: true });
    vi.advanceTimersByTime(100);
    record.status = 'completed';
    record.completionSequence = 1;
    record.updatedAt = 2;
    store.saveAgent(record, { defer: true });
    vi.advanceTimersByTime(100);

    expect(persisted.at(-1)).toMatchObject({ status: 'completed', completionSequence: 1 });
    expect(events.map((event) => event.state)).toEqual(['degraded', 'recovered']);
    expect(store.hasPendingAgent(record.id)).toBe(false);
    store.dispose();
  });

  it('cancels an older queued record write before a required save', () => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const staleTemp = join(root, 'repo', 'records', 'stale-record.tmp');
    const recordWrites: AgentRecord[] = [];
    const writer = {
      write: vi.fn((target: string, value: unknown) => {
        if (!target.includes(`${join('records', '')}`)) {
          return { status: 'ok', target, attempts: 1, elapsedMs: 0 } as const;
        }
        recordWrites.push(structuredClone(value as AgentRecord));
        if (recordWrites.length === 1) {
          writeFileSync(staleTemp, JSON.stringify(value));
          return {
            status: 'busy',
            target,
            tempPath: staleTemp,
            operation: 'rename',
            attempts: 4,
            elapsedMs: 500,
          } as const;
        }
        return { status: 'ok', target, attempts: 1, elapsedMs: 0 } as const;
      }),
    } as unknown as AtomicJsonWriter;
    const store = new AgentStore('repo', root, true, { writer });
    const record = recordFixture('required-agent');

    store.saveAgent(record, { defer: true });
    vi.advanceTimersByTime(100);
    record.prompt = 'new required state';
    expect(store.saveAgent(record, { required: true }).status).toBe('ok');
    vi.advanceTimersByTime(10_000);

    expect(recordWrites).toHaveLength(2);
    expect(recordWrites.at(-1)?.prompt).toBe('new required state');
    expect(existsSync(staleTemp)).toBe(false);
    store.dispose();
  });

  it('re-serializes changed values when the logical revision is unchanged', () => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const staleTemp = join(root, 'repo', 'records', 'equal-revision.tmp');
    const recordWrites: Array<{ value: AgentRecord; preparedTemp?: string }> = [];
    const writer = {
      write: vi.fn((target: string, value: unknown, preparedTemp?: string) => {
        if (!target.includes(`${join('records', '')}`)) {
          return { status: 'ok', target, attempts: 1, elapsedMs: 0 } as const;
        }
        recordWrites.push({ value: structuredClone(value as AgentRecord), preparedTemp });
        if (recordWrites.length === 1) {
          writeFileSync(staleTemp, JSON.stringify(value));
          return {
            status: 'busy',
            target,
            tempPath: staleTemp,
            operation: 'rename',
            attempts: 4,
            elapsedMs: 500,
          } as const;
        }
        return { status: 'ok', target, attempts: 1, elapsedMs: 0 } as const;
      }),
    } as unknown as AtomicJsonWriter;
    const store = new AgentStore('repo', root, true, { writer });
    const record = recordFixture('equal-revision-agent');

    store.saveAgent(record, { defer: true });
    vi.advanceTimersByTime(100);
    record.prompt = 'changed without a revision bump';
    store.saveAgent(record, { defer: true });
    vi.advanceTimersByTime(100);

    expect(recordWrites).toHaveLength(2);
    expect(recordWrites[1]?.preparedTemp).toBeUndefined();
    expect(recordWrites[1]?.value.prompt).toBe('changed without a revision bump');
    expect(existsSync(staleTemp)).toBe(false);
    store.dispose();
  });

  it('cancels an older queued evidence write before a required save', () => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const staleTemp = join(root, 'repo', 'evidence', 'stale-evidence.tmp');
    const evidenceWrites: EvidenceItem[] = [];
    const writer = {
      write: vi.fn((target: string, value: unknown) => {
        if (!target.includes(`${join('evidence', '')}`)) {
          return { status: 'ok', target, attempts: 1, elapsedMs: 0 } as const;
        }
        evidenceWrites.push(structuredClone(value as EvidenceItem));
        if (evidenceWrites.length === 1) {
          writeFileSync(staleTemp, JSON.stringify(value));
          return {
            status: 'busy',
            target,
            tempPath: staleTemp,
            operation: 'rename',
            attempts: 4,
            elapsedMs: 500,
          } as const;
        }
        return { status: 'ok', target, attempts: 1, elapsedMs: 0 } as const;
      }),
    } as unknown as AtomicJsonWriter;
    const store = new AgentStore('repo', root, true, { writer });
    const evidence: EvidenceItem = {
      id: 'evidence-1',
      kind: 'finding',
      sourceAgentId: 'agent-1',
      summary: 'old',
      confidence: 0.5,
      references: [],
      verificationState: 'unverified',
      createdAt: 1,
      updatedAt: 1,
    };

    store.saveEvidence(evidence, { required: false });
    evidence.summary = 'required';
    expect(store.saveEvidence(evidence).status).toBe('ok');
    vi.advanceTimersByTime(10_000);

    expect(evidenceWrites).toHaveLength(2);
    expect(evidenceWrites.at(-1)?.summary).toBe('required');
    expect(existsSync(staleTemp)).toBe(false);
    store.dispose();
  });

  it('discovers foreign agents created after this store starts', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const second = new AgentStore('repo', root, true, {
      instanceId: '22222222-2222-4222-8222-222222222222',
      pid: 222,
      hostname: 'test-host',
      now: () => 2,
      processAlive: () => true,
    });
    const first = new AgentStore('repo', root, true, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 111,
      hostname: 'test-host',
      now: () => 3,
    });

    first.saveAgent(recordFixture('late-foreign-agent'), { required: true });

    expect(second.listAgents()).toEqual([
      expect.objectContaining({ id: 'late-foreign-agent', status: 'queued' }),
    ]);
    expect(second.isOwnedByLiveForeign('late-foreign-agent')).toBe(true);
    first.dispose();
    second.dispose();
  });

  it('preserves expired terminal records owned by a live foreign process', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const first = new AgentStore('repo', root, true, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 111,
      hostname: 'test-host',
      now: () => 1,
    });
    first.saveAgent(
      {
        ...recordFixture('live-owned-terminal'),
        status: 'completed',
        completionSequence: 1,
      },
      { required: true },
    );
    const second = new AgentStore('repo', root, true, {
      instanceId: '22222222-2222-4222-8222-222222222222',
      pid: 222,
      hostname: 'test-host',
      now: () => 40 * 86_400_000,
      processAlive: () => true,
    });

    expect(second.cleanupDetailed(30).agents).toEqual([]);
    expect(second.listAgents()).toEqual([
      expect.objectContaining({ id: 'live-owned-terminal', status: 'completed' }),
    ]);
    expect(existsSync(join(root, 'repo', 'records', 'live-owned-terminal.json'))).toBe(true);
    first.dispose();
    second.dispose();
  });

  it('recovers the newer legacy temp file before loading records', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const directory = join(root, 'repo');
    const records = join(directory, 'records');
    mkdirSync(join(directory, 'summaries'), { recursive: true });
    mkdirSync(join(directory, 'plans'), { recursive: true });
    mkdirSync(join(directory, 'evidence'), { recursive: true });
    mkdirSync(join(directory, 'snapshots'), { recursive: true });
    mkdirSync(join(directory, 'instances'), { recursive: true });
    mkdirSync(records, { recursive: true });
    writeFileSync(join(directory, 'state.json'), JSON.stringify({ version: 3 }));
    const old = recordFixture('recovered-agent');
    writeFileSync(join(records, 'recovered-agent.json'), JSON.stringify(old));
    const newer = { ...old, status: 'completed' as const, updatedAt: 2, completionSequence: 1 };
    writeFileSync(join(records, 'recovered-agent.json.999.123456.tmp'), JSON.stringify(newer));

    const store = new AgentStore('repo', root);

    expect(store.loadAgent('recovered-agent')).toMatchObject({
      status: 'completed',
      completionSequence: 1,
    });
    expect(readdirSync(records).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    store.dispose();
  });

  it('retains the selected recovery temp when promotion is still busy', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const directory = join(root, 'repo');
    const records = join(directory, 'records');
    mkdirSync(join(directory, 'summaries'), { recursive: true });
    mkdirSync(join(directory, 'plans'), { recursive: true });
    mkdirSync(join(directory, 'evidence'), { recursive: true });
    mkdirSync(join(directory, 'snapshots'), { recursive: true });
    mkdirSync(join(directory, 'instances'), { recursive: true });
    mkdirSync(records, { recursive: true });
    writeFileSync(join(directory, 'state.json'), JSON.stringify({ version: 3 }));
    const old = recordFixture('busy-recovery');
    writeFileSync(join(records, 'busy-recovery.json'), JSON.stringify(old));
    const newer = { ...old, status: 'completed' as const, updatedAt: 2, completionSequence: 1 };
    const tempPath = join(records, 'busy-recovery.json.999.123456.tmp');
    writeFileSync(tempPath, JSON.stringify(newer));
    const writer = {
      write: vi.fn((target: string, _value: unknown, preparedTemp?: string) =>
        target.includes(`${join('records', '')}`) && preparedTemp
          ? {
              status: 'busy' as const,
              target,
              tempPath: preparedTemp,
              operation: 'rename' as const,
              attempts: 4,
              elapsedMs: 500,
            }
          : { status: 'ok' as const, target, attempts: 1, elapsedMs: 0 },
      ),
    } as unknown as AtomicJsonWriter;

    const store = new AgentStore('repo', root, true, { writer });

    expect(existsSync(tempPath)).toBe(true);
    expect(store.loadAgent('busy-recovery')).toMatchObject({ status: 'queued' });
    store.dispose();
  });

  it('quarantines recovery temps whose embedded ID does not match the target', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const directory = join(root, 'repo');
    const records = join(directory, 'records');
    mkdirSync(join(directory, 'summaries'), { recursive: true });
    mkdirSync(join(directory, 'plans'), { recursive: true });
    mkdirSync(join(directory, 'evidence'), { recursive: true });
    mkdirSync(join(directory, 'snapshots'), { recursive: true });
    mkdirSync(join(directory, 'instances'), { recursive: true });
    mkdirSync(records, { recursive: true });
    writeFileSync(join(directory, 'state.json'), JSON.stringify({ version: 3 }));
    writeFileSync(
      join(records, 'expected.json.999.123456.tmp'),
      JSON.stringify(recordFixture('different')),
    );

    const store = new AgentStore('repo', root);

    expect(store.loadAgent('expected')).toBeUndefined();
    expect(
      readdirSync(records).some((name) => name.startsWith('expected.json.999.123456.tmp.corrupt-')),
    ).toBe(true);
    store.dispose();
  });
});

function recordFixture(id: string): AgentRecord {
  return {
    id,
    name: 'explorer',
    role: 'explorer',
    description: 'explore',
    status: 'queued',
    applicationStatus: 'not_applied',
    prompt: 'inspect',
    referencedEvidenceIds: [],
    transcript: [],
    pendingMessages: [],
    createdAt: 1,
    updatedAt: 1,
  };
}
