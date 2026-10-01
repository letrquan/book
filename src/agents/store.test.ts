import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { open as openAsync, rename as renameAsync } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
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
      // The lease heartbeat is written asynchronously; the doubles below stand in for the whole
      // writer, so this is the half of it the heartbeat uses.
      writeAsync: vi.fn(async (target: string) => ({
        status: 'ok' as const,
        target,
        attempts: 1,
        elapsedMs: 0,
      })),
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
      // The lease heartbeat is written asynchronously; the doubles below stand in for the whole
      // writer, so this is the half of it the heartbeat uses.
      writeAsync: vi.fn(async (target: string) => ({
        status: 'ok' as const,
        target,
        attempts: 1,
        elapsedMs: 0,
      })),
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
      // The lease heartbeat is written asynchronously; the doubles below stand in for the whole
      // writer, so this is the half of it the heartbeat uses.
      writeAsync: vi.fn(async (target: string) => ({
        status: 'ok' as const,
        target,
        attempts: 1,
        elapsedMs: 0,
      })),
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
      // The lease heartbeat is written asynchronously; the doubles below stand in for the whole
      // writer, so this is the half of it the heartbeat uses.
      writeAsync: vi.fn(async (target: string) => ({
        status: 'ok' as const,
        target,
        attempts: 1,
        elapsedMs: 0,
      })),
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
      // The lease heartbeat is written asynchronously; the doubles below stand in for the whole
      // writer, so this is the half of it the heartbeat uses.
      writeAsync: vi.fn(async (target: string) => ({
        status: 'ok' as const,
        target,
        attempts: 1,
        elapsedMs: 0,
      })),
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

describe('AgentStore recovery of host-owned agents', () => {
  /**
   * A `/review` killed by SIGKILL or a hard crash never runs the manager's exit
   * handler, so its reviewers are recovered here on the next launch instead.
   */
  function reviewerRecord(id: string): AgentRecord {
    return {
      id,
      name: 'reviewer',
      role: 'explorer',
      description: 'review',
      status: 'running',
      applicationStatus: 'not_applied',
      prompt: 'review the diff',
      parentSessionId: 'session-1',
      spawnerClaim: { throughRunSequence: 1, notifyParent: false, resumeAfterRestart: false },
      referencedEvidenceIds: [],
      transcript: [],
      pendingMessages: [],
      createdAt: 1,
      updatedAt: 1,
    };
  }

  function restart(directory: string): AgentStore {
    return new AgentStore('repo', directory, true, {
      instanceId: '33333333-3333-4333-8333-333333333333',
      pid: 34567,
      hostname: 'test-host',
      now: () => 100_000,
      processAlive: () => false,
    });
  }

  it('marks a process-death interruption resumable, with the status it held', () => {
    // The distinction a restart needs: "died mid-flight" versus "genuinely
    // stopped". Without it the whole pending backlog became terminal records
    // nothing ever re-drove.
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const store = new AgentStore('repo', root, true, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 12345,
      hostname: 'test-host',
      now: () => 1,
    });
    const record = reviewerRecord('reviewer-1');
    record.status = 'running';
    store.saveAgent(record);

    const recovered = restart(root).recoverAbandonedAgents()[0]!;

    expect(recovered).toMatchObject({
      status: 'interrupted',
      stopReason: 'process_exit',
      resumable: true,
      resumedFromStatus: 'running',
    });
  });

  it('recovers a suppressed agent without leaving a completion to deliver', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const store = new AgentStore('repo', root, true, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 12345,
      hostname: 'test-host',
      now: () => 1,
    });
    store.saveAgent(reviewerRecord('reviewer-1'));

    const recovered = restart(root).recoverAbandonedAgents()[0]!;

    expect(recovered.status).toBe('interrupted');
    // Equal sequences mean nothing is outstanding: the next `--continue` will
    // not spend a model turn re-narrating a review that never finished, and the
    // agent will not stay pinned in the session's agent list.
    expect(recovered.completionSequence).toBe(1);
    expect(recovered.completionDeliveredSequence).toBe(1);
  });

  it('still leaves an ordinary agent’s completion outstanding', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const store = new AgentStore('repo', root, true, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 12345,
      hostname: 'test-host',
      now: () => 1,
    });
    const ordinary = { ...reviewerRecord('explorer-1'), spawnerClaim: undefined };
    store.saveAgent(ordinary);

    const recovered = restart(root).recoverAbandonedAgents()[0]!;

    expect(recovered.completionSequence).toBe(1);
    expect(recovered.completionDeliveredSequence ?? 0).toBe(0);
  });

  it('leaves the completion of a run past the claim outstanding', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const store = new AgentStore('repo', root, true, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 12345,
      hostname: 'test-host',
      now: () => 1,
    });
    // A follow-up the parent sent after the review took its result: run 2, past the claim.
    store.saveAgent({ ...reviewerRecord('reviewer-2'), runSequence: 2 });

    const recovered = restart(root).recoverAbandonedAgents()[0]!;

    expect(recovered.completionSequence).toBe(1);
    expect(recovered.completionDeliveredSequence ?? 0).toBe(0);
  });

  /**
   * Records written before per-run claims carried two record-level flags, which every path
   * that started a run nobody was waiting on cleared by hand; while set, they described the
   * run the record was on.
   */
  function legacyRecord(id: string, runSequence: number | undefined): AgentRecord {
    return {
      ...reviewerRecord(id),
      spawnerClaim: undefined,
      runSequence,
      notifyParentOnCompletion: false,
      resumeAfterRestart: false,
    } as unknown as AgentRecord;
  }

  /**
   * An older Book build shares this store and knows only the record-level pair, so a claimed
   * agent has to keep reading as the host's to it for as long as the claim covers the run the
   * record is on.
   */
  it('writes the legacy flag pair while the claim covers the run, and drops it past the claim', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const recordPath = join(root, 'repo', 'records', 'reviewer-5.json');
    const store = new AgentStore('repo', root, true, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 12345,
      hostname: 'test-host',
      now: () => 1,
    });
    store.saveAgent({ ...reviewerRecord('reviewer-5'), runSequence: 1 });

    const claimed = JSON.parse(readFileSync(recordPath, 'utf8'));
    expect(claimed.notifyParentOnCompletion).toBe(false);
    expect(claimed.resumeAfterRestart).toBe(false);
    // The in-memory record is the claim; the pair exists only for the build that reads it.
    expect(store.loadAgent('reviewer-5')).not.toHaveProperty('notifyParentOnCompletion');
    expect(store.loadAgent('reviewer-5')).not.toHaveProperty('resumeAfterRestart');

    // A follow-up the parent sent after the review took its result: run 2, past the claim.
    store.saveAgent({ ...reviewerRecord('reviewer-5'), runSequence: 2 });

    const pastClaim = JSON.parse(readFileSync(recordPath, 'utf8'));
    expect(pastClaim).not.toHaveProperty('notifyParentOnCompletion');
    expect(pastClaim).not.toHaveProperty('resumeAfterRestart');
    expect(store.loadAgent('reviewer-5')).not.toHaveProperty('notifyParentOnCompletion');
    expect(store.loadAgent('reviewer-5')).not.toHaveProperty('resumeAfterRestart');
    store.dispose();
  });

  it('reads a legacy flag pair as a claim on the run the record was on', () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const store = new AgentStore('repo', root, true, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 12345,
      hostname: 'test-host',
      now: () => 1,
    });
    store.saveAgent(legacyRecord('reviewer-3', 3));
    store.saveAgent(legacyRecord('reviewer-4', undefined));

    const reopened = restart(root);
    const continued = reopened.loadAgent('reviewer-3')!;
    expect(continued.spawnerClaim).toEqual({
      throughRunSequence: 3,
      notifyParent: false,
      resumeAfterRestart: false,
    });
    expect(continued).not.toHaveProperty('notifyParentOnCompletion');
    expect(continued).not.toHaveProperty('resumeAfterRestart');
    // A record that never started claims its first run.
    expect(reopened.loadAgent('reviewer-4')!.spawnerClaim).toMatchObject({
      throughRunSequence: 1,
    });

    // And the recovery the next launch performs still keeps the host's run undelivered.
    for (const recovered of reopened.recoverAbandonedAgents()) {
      expect(recovered.completionDeliveredSequence).toBe(recovered.completionSequence);
    }
  });
});
/**
 * The heartbeat is the one write nobody waits for: it runs on a timer for as long as the process
 * lives, and what it writes is read by other Book instances rather than by this one. So it is
 * written off the caller's thread, which is only a good trade if the properties below hold — a tick
 * that is skipped rather than queued, a lease file with the contents it always had, and a dispose
 * that leaves nothing behind (#357).
 *
 * The slow disk is injected through the writer's asynchronous filesystem rather than through a
 * stubbed writer, so the writes these tests watch are ones the real atomic protocol made: a lock, a
 * temp file, an fsync and a rename, with only the timing replaced. The rename is where the hold is,
 * because it is the last step — the one that can put a file back after dispose deleted it.
 */
describe('AgentStore lease heartbeat', () => {
  const instanceId = '44444444-4444-4444-8444-444444444444';
  const instancesDirectory = (directory: string) => join(directory, 'repo', 'instances');
  const leasePath = (directory: string) =>
    join(instancesDirectory(directory), `${instanceId}.json`);
  const contents = (directory: string) => readdirSync(instancesDirectory(directory));

  /** Poll until a condition holds, so the assertions are about what happened, not how fast. */
  async function waitFor(check: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  /**
   * A disk whose next heartbeat rename is held open, which is what a slow disk looks like from here.
   *
   * `renamed` records renames that have finished rather than ones that were attempted, so a count of
   * zero means no write completed rather than that one was refused.
   */
  function slowDisk(): {
    fsAsync: {
      open: (path: string, flags: string, mode?: number) => Promise<FileHandle>;
      rename: (from: string, to: string) => Promise<void>;
    };
    renamed: string[];
    holdNextRename: () => { started: Promise<void>; release: () => void };
  } {
    const renamed: string[] = [];
    let gate: Promise<void> | undefined;
    let markStarted: (() => void) | undefined;
    let releaseGate: (() => void) | undefined;
    let held = false;
    return {
      renamed,
      holdNextRename: () => {
        held = true;
        gate = new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        return {
          started: new Promise<void>((resolve) => {
            markStarted = resolve;
          }),
          release: () => releaseGate?.(),
        };
      },
      fsAsync: {
        open: (path, flags, mode) => openAsync(path, flags, mode),
        rename: async (from, to) => {
          if (held) {
            held = false;
            markStarted?.();
            await gate;
          }
          await renameAsync(from, to);
          renamed.push(to);
        },
      },
    };
  }

  function store(directory: string, disk: ReturnType<typeof slowDisk>): AgentStore {
    return new AgentStore('repo', directory, true, {
      instanceId,
      writerOptions: { fsAsync: disk.fsAsync },
      heartbeatMs: 5,
      pid: 4321,
      hostname: 'test-host',
      now: () => 1_000,
    });
  }

  it('skips a tick that arrives while a heartbeat write is still running', async () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const disk = slowDisk();
    const held = disk.holdNextRename();
    const agents = store(root, disk);

    // The store took its lease in its constructor and that one is synchronous, so this is the first
    // heartbeat, and it is still in flight when the ticks below arrive.
    await held.started;
    await new Promise((done) => setTimeout(done, 60));

    // A dozen ticks came and went against a disk slower than the heartbeat, and none of them started
    // a write: a queued heartbeat is a write whose content was already stale when it started, and a
    // queue of them grows with the time the disk is slow.
    expect(disk.renamed).toEqual([]);

    held.release();
    await waitFor(() => disk.renamed.length === 1, 'the held heartbeat to land');
    agents.dispose();
    await waitFor(() => !existsSync(leasePath(root)), 'the lease to be removed on dispose');
  });

  it('writes the lease another instance reads, through an fsync and an atomic rename', async () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const disk = slowDisk();
    const agents = store(root, disk);

    // A heartbeat, not the constructor's lease: what is being checked here is the asynchronous
    // protocol, and the file it produced is one that went through the lock, the temp file and the
    // rename rather than through the synchronous writer. The directory has to be back to just the
    // lease as well, because the writer removes its lock after the rename this double reports.
    await waitFor(
      () => disk.renamed.length > 0 && contents(root).length === 1,
      'the first heartbeat to land',
    );

    // The whole document, because every field of it is what another instance reads to decide this
    // one is alive: without the pid and host there is nothing to fall back on, and without the
    // heartbeat stamp there is no freshness to judge.
    expect(JSON.parse(readFileSync(leasePath(root), 'utf8'))).toEqual({
      schemaVersion: 1,
      instanceId,
      pid: 4321,
      hostname: 'test-host',
      processStartedAt: expect.any(Number),
      heartbeatAt: 1_000,
    });
    // No temp file and no lock left: the rename is what makes the lease readable, and a leftover of
    // either is something another instance's stale-lock sweep has to reason about.
    expect(contents(root)).toEqual([`${instanceId}.json`]);

    agents.dispose();
    await waitFor(() => !existsSync(leasePath(root)), 'the lease to be removed on dispose');
  });

  it('disposes during a write without leaving the lease behind or throwing', async () => {
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const disk = slowDisk();
    const held = disk.holdNextRename();
    const agents = store(root, disk);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await held.started;
      // Mid-heartbeat: the lock and the temp file are there and the rename has not happened, and
      // the lease is there too from the constructor.
      expect(contents(root)).toHaveLength(3);
      expect(contents(root).some((name) => name.endsWith('.tmp'))).toBe(true);
      expect(existsSync(leasePath(root))).toBe(true);

      agents.dispose();
      // Read with no await between the call and the read. A removal that waits for the write in
      // flight is a removal that does not happen for a process that exits in between, and a lease
      // left on disk is what another instance reads as a live owner until it goes stale — minutes
      // for a Book that is never coming back. So `dispose()` unlinks the lease itself, and the
      // held write is a re-creation risk, not part of the removal.
      expect(existsSync(leasePath(root)), 'the lease should be gone when dispose() returns').toBe(
        false,
      );
      await new Promise((done) => setTimeout(done, 40));
      // Nothing started after the dispose, so there is no later write to land behind it.
      expect(disk.renamed).toEqual([]);

      held.release();
      await waitFor(() => contents(root).length === 0, 'the disposed lease to be gone');

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      held.release();
    }
  });

  it('removes a lease whose write had already passed the point of no return', async () => {
    // The other end of the same window, and the reason the unlink is repeated when the write settles
    // rather than only at the end of it. `canCommit` is asked immediately before the rename, so a
    // write that is *inside* the rename has already passed that question — and the file that rename
    // produces is the one `dispose()` had just deleted. The rename here is held before it moves a
    // byte, so the ordering is the one that matters: the store unlinks, the write then lands, and
    // the settled write has to take the file away again.
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const renamed: string[] = [];
    let held = false;
    let unblock = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let reached = (): void => {};
    const atRename = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const agents = new AgentStore('repo', root, true, {
      instanceId,
      writerOptions: {
        fsAsync: {
          open: (path, flags, mode) => openAsync(path, flags, mode),
          rename: async (from, to) => {
            if (held) {
              reached();
              await blocked;
            }
            await renameAsync(from, to);
            renamed.push(to);
          },
        },
      },
      heartbeatMs: 5,
      pid: 4321,
      hostname: 'test-host',
      now: () => 1_000,
    });
    // The constructor's lease is written synchronously and never reaches this double, so the hold is
    // armed afterwards and catches the first heartbeat.
    expect(existsSync(leasePath(root))).toBe(true);
    held = true;
    await atRename;

    agents.dispose();
    expect(existsSync(leasePath(root)), 'the lease should be gone when dispose() returns').toBe(
      false,
    );

    // The write `dispose()` could not stop. That it lands is the premise rather than the assertion:
    // a test where the rename never happened would pass for the wrong reason.
    unblock();
    await waitFor(
      () => renamed.includes(leasePath(root)),
      'the held heartbeat to put the lease back',
    );
    await waitFor(
      () => !existsSync(leasePath(root)),
      'the lease the settled write left behind to be removed again',
    );
    expect(contents(root)).toEqual([]);
  });

  it('keeps agent records synchronous, because a caller is told when they are durable', async () => {
    // The other half of the claim: only the heartbeat moved. `saveAgent` returning has always meant
    // the record is on disk, and a caller reading the file straight after the call depends on it.
    root = mkdtempSync(join(tmpdir(), 'book-agent-store-'));
    const disk = slowDisk();
    const agents = store(root, disk);
    await waitFor(
      () => disk.renamed.length > 0 && contents(root).length === 1,
      'the first heartbeat to land',
    );

    agents.saveAgent(recordFixture('sync-agent'));
    const recordPath = join(root, 'repo', 'records', 'sync-agent.json');
    // Read with no await between the call and the read, which a write on the thread pool could not
    // be.
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toMatchObject({
      id: 'sync-agent',
      status: 'queued',
    });

    agents.dispose();
    await waitFor(() => !existsSync(leasePath(root)), 'the lease to be removed on dispose');
  });
});
