import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessCoordinator } from './coordinator.js';
import { RunEvidenceStore } from './run-store.js';
import { workspaceIdentity } from '../tools/file-provenance.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'book-harness-coordinator-'));
  const workspace = join(root, 'workspace');
  const bookHome = join(root, 'book');
  const coordinator = createHarnessCoordinator('observe', { workspace, bookHome });
  const store = new RunEvidenceStore({ workspace, bookHome });
  return { coordinator, store, workspace };
}

function identity(workspace: string, runId: string, rootRunId = runId, parentRunId?: string) {
  return {
    workspaceId: workspaceIdentity(workspace),
    rootRunId,
    runId,
    parentRunId,
    sessionId: 'session-observe',
  };
}

describe('observe-mode harness coordinator', () => {
  it('prepares a frozen baseline context and seals the root stream on finalize', async () => {
    const { coordinator, store, workspace } = await fixture();
    const prepared = await coordinator.prepareRun({
      mode: 'observe',
      identity: identity(workspace, 'root-observe-1'),
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(Object.isFrozen(prepared.context)).toBe(true);
    expect(prepared.context.mode).toBe('observe');
    expect(prepared.context.workflow).toMatchObject({ id: 'baseline', source: 'baseline' });

    expect(
      coordinator.observe('root-observe-1', { type: 'turn_started', occurredAt: 1 }),
    ).toMatchObject({ status: 'accepted' });
    const final = await coordinator.finalizeRun('root-observe-1', { status: 'completed' });
    expect(final.flushed).toBe(true);
    const run = await store.readRun('root-observe-1');
    expect(run.status).toBe('complete');
    expect(run.seal?.terminalStatus).toBe('completed');
  });

  it('joins child runs to the open root stream without letting them seal it', async () => {
    const { coordinator, store, workspace } = await fixture();
    const root = await coordinator.prepareRun({
      mode: 'observe',
      identity: identity(workspace, 'root-shared-1'),
    });
    expect(root.status).toBe('prepared');
    const child = await coordinator.prepareRun({
      mode: 'observe',
      identity: identity(workspace, 'child-shared-1', 'root-shared-1', 'root-shared-1'),
    });
    expect(child.status).toBe('prepared');
    if (child.status !== 'prepared') return;

    // A child observer finalize is a flush, never a stream seal.
    const childFinal = await child.observer.finalize!({ status: 'completed' });
    expect(childFinal.status).not.toBe('closed');
    let run = await store.readRun('root-shared-1');
    expect(run.seal).toBeUndefined();

    expect(
      coordinator.observe('child-shared-1', {
        type: 'tool_finished',
        occurredAt: 5,
        runId: 'child-shared-1',
      }),
    ).toMatchObject({ status: 'accepted' });
    const rootFinal = await coordinator.finalizeRun('root-shared-1', { status: 'completed' });
    expect(rootFinal.flushed).toBe(true);
    run = await store.readRun('root-shared-1');
    expect(run.status).toBe('complete');
    const types = run.records.map((record) => record.eventType);
    expect(types).toContain('subagent_handoff_created');
    const childEvent = run.records.find((record) => record.eventType === 'tool_finished');
    expect(childEvent?.runId).toBe('child-shared-1');
    expect(childEvent?.rootRunId).toBe('root-shared-1');
  });

  it('fails child preparation deterministically when the root stream is unavailable', async () => {
    const { coordinator, workspace } = await fixture();
    await expect(
      coordinator.prepareRun({
        mode: 'observe',
        identity: identity(workspace, 'child-orphan-1', 'root-missing-1', 'root-missing-1'),
      }),
    ).rejects.toThrow('harness_root_stream_unavailable');
  });

  it('treats unknown-run observation and duplicate finalization as inert', async () => {
    const { coordinator, workspace } = await fixture();
    expect(coordinator.observe('never-prepared', { type: 'turn_started', occurredAt: 1 })).toBe(
      'rejected',
    );
    await coordinator.prepareRun({
      mode: 'observe',
      identity: identity(workspace, 'root-dup-1'),
    });
    const first = await coordinator.finalizeRun('root-dup-1', { status: 'completed' });
    const second = await coordinator.finalizeRun('root-dup-1', { status: 'completed' });
    expect(first.flushed).toBe(true);
    expect(second).toMatchObject({ status: 'disabled', droppedEventCount: 0 });
  });
});
