import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  builtinWorkflowRegistry,
  createHarnessCoordinator,
  selectWorkflow,
} from './coordinator.js';
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

  it('records the selected workflow, its digests, and its clamps with the run', async () => {
    const { coordinator, store, workspace } = await fixture();
    const registry = builtinWorkflowRegistry();
    const selection = selectWorkflow(registry, { mode: 'observe', runOverride: 'verify-heavy' });
    const resolved = selection.resolved!;
    const prepared = await coordinator.prepareRun({
      mode: 'observe',
      identity: identity(workspace, 'root-workflow-1'),
      workflow: {
        decision: selection.decision,
        registryVersion: selection.registryVersion,
        registryDigest: selection.registryDigest,
        overrideScope: selection.overrideScope,
        definitionDigest: resolved.definitionDigest,
        policyRenderVersion: resolved.policyRenderVersion,
        policySection: resolved.policySection,
        clamps: [
          { field: 'execution.retryPosture', reason: 'retry_correctness_is_kernel_controlled' },
        ],
        activeFieldCount: resolved.complexity.activeFieldCount,
        renderedChars: resolved.complexity.renderedChars,
        requestedExtraCalls: resolved.complexity.requestedExtraCalls,
      },
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.context.workflow).toMatchObject({
      id: 'verify-heavy',
      version: 1,
      source: 'manual',
      reasonCode: 'manual_run_override',
    });
    expect(prepared.context.workflowPolicySection).toContain('## Execution policy');
    expect(prepared.context.workflowPolicyRenderVersion).toBe('phase-3-v1');

    await coordinator.finalizeRun('root-workflow-1', { status: 'completed' });
    const run = await store.readRun('root-workflow-1');
    const started = run.records.find((record) => record.eventType === 'run_started');
    const startedData = started?.data as { workflow: string; metadata: Record<string, unknown> };
    expect(startedData.workflow).toBe('verify-heavy');
    expect(startedData.metadata).toMatchObject({
      workflowId: 'verify-heavy',
      workflowVersion: 1,
      workflowSource: 'manual',
      workflowReasonCode: 'manual_run_override',
      workflowOverrideScope: 'run',
      workflowRegistryDigest: registry.digest,
      workflowDefinitionDigest: resolved.definitionDigest,
      workflowPolicyRenderVersion: 'phase-3-v1',
      workflowClampCount: 1,
    });

    const clamped = run.records.filter((record) => record.eventType === 'capability_clamped');
    expect(clamped).toHaveLength(1);
    expect(clamped[0].data).toMatchObject({
      attributes: {
        workflowId: 'verify-heavy',
        clampedField: 'execution.retryPosture',
        clampReason: 'retry_correctness_is_kernel_controlled',
      },
    });
  });

  it('keeps the baseline label and adds no prompt policy when nothing is selected', async () => {
    const { coordinator, store, workspace } = await fixture();
    const selection = selectWorkflow(builtinWorkflowRegistry(), { mode: 'observe' });
    const prepared = await coordinator.prepareRun({
      mode: 'observe',
      identity: identity(workspace, 'root-baseline-1'),
      workflow: {
        decision: selection.decision,
        registryVersion: selection.registryVersion,
        registryDigest: selection.registryDigest,
        overrideScope: selection.overrideScope,
      },
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.context.workflow).toMatchObject({ id: 'baseline', source: 'baseline' });
    expect(prepared.context.workflowPolicySection).toBeUndefined();

    await coordinator.finalizeRun('root-baseline-1', { status: 'completed' });
    const run = await store.readRun('root-baseline-1');
    const started = run.records.find((record) => record.eventType === 'run_started');
    expect((started?.data as { workflow: string }).workflow).toBe('baseline');
    expect(run.records.some((record) => record.eventType === 'capability_clamped')).toBe(false);
  });

  it('renders no execution policy for the minimal workflow', async () => {
    const { coordinator, workspace } = await fixture();
    const selection = selectWorkflow(builtinWorkflowRegistry(), {
      mode: 'observe',
      runOverride: 'minimal',
    });
    const prepared = await coordinator.prepareRun({
      mode: 'observe',
      identity: identity(workspace, 'root-minimal-1'),
      workflow: {
        decision: selection.decision,
        registryVersion: selection.registryVersion,
        registryDigest: selection.registryDigest,
        overrideScope: selection.overrideScope,
        policySection: selection.resolved!.policySection,
        policyRenderVersion: selection.resolved!.policyRenderVersion,
      },
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.context.workflow?.id).toBe('minimal');
    expect(prepared.context.workflowPolicySection).toBeUndefined();
    expect(prepared.context.workflowPolicyRenderVersion).toBeUndefined();
    await coordinator.finalizeRun('root-minimal-1', { status: 'completed' });
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
