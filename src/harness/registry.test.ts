import { describe, expect, it } from 'vitest';
import {
  BASELINE_WORKFLOW_ID,
  HarnessWorkflowInvalidIdError,
  HarnessWorkflowUnavailableError,
  HarnessWorkflowUnknownError,
  WORKFLOW_REGISTRY_VERSION,
  assertSelectableWorkflow,
  assertWorkflowSelectionAvailable,
  builtinWorkflowRegistry,
  createWorkflowRegistry,
  selectWorkflow,
  type WorkflowRegistry,
} from './registry.js';
import {
  BUILTIN_WORKFLOW_DEFINITIONS,
  WorkflowValidationError,
  type WorkflowDefinition,
} from './workflows.js';

function builtin(id: string): WorkflowDefinition {
  const definition = BUILTIN_WORKFLOW_DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) throw new Error(`missing built-in workflow ${id}`);
  return structuredClone(definition) as WorkflowDefinition;
}

describe('registry construction', () => {
  it('exposes exactly the three promoted built-ins', () => {
    const registry = builtinWorkflowRegistry();
    expect(registry.list().map((entry) => entry.requested.id)).toEqual([
      'minimal',
      'safe-edit',
      'verify-heavy',
    ]);
    expect(registry.version).toBe(WORKFLOW_REGISTRY_VERSION);
    expect(registry.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a stable digest for the same definitions', () => {
    expect(createWorkflowRegistry().digest).toBe(createWorkflowRegistry().digest);
    const changed = createWorkflowRegistry([
      builtin('minimal'),
      { ...builtin('safe-edit'), version: 2 },
      builtin('verify-heavy'),
    ]);
    expect(changed.digest).not.toBe(createWorkflowRegistry().digest);
  });

  it('rejects a duplicate id at the same version', () => {
    expect(() => createWorkflowRegistry([builtin('minimal'), builtin('minimal')])).toThrow(
      WorkflowValidationError,
    );
  });

  it('rejects a non-monotonic version for the same id', () => {
    const promoted = { ...builtin('safe-edit'), version: 3 };
    expect(() =>
      createWorkflowRegistry([builtin('minimal'), promoted, { ...promoted, version: 2 }]),
    ).toThrow(/not greater than promoted version 3/);
  });

  it('keeps the highest promoted version active', () => {
    const registry = createWorkflowRegistry([
      builtin('minimal'),
      { ...builtin('safe-edit'), version: 1 },
      { ...builtin('safe-edit'), version: 4 },
    ]);
    expect(registry.get('safe-edit')?.requested.version).toBe(4);
  });

  it('requires the minimal fallback to exist', () => {
    expect(() => createWorkflowRegistry([builtin('safe-edit')])).toThrow(
      /minimal fallback workflow must be present/,
    );
  });

  it('rejects an invalid definition before it can be selected', () => {
    expect(() =>
      createWorkflowRegistry([builtin('minimal'), { ...builtin('safe-edit'), hooks: [] } as never]),
    ).toThrow(WorkflowValidationError);
  });
});

describe('mode gating', () => {
  it('fails closed when a workflow is selected with the harness off', () => {
    expect(() => assertWorkflowSelectionAvailable('off', 'safe-edit')).toThrow(
      HarnessWorkflowUnavailableError,
    );
    expect(() =>
      selectWorkflow(builtinWorkflowRegistry(), { mode: 'off', settingsWorkflow: 'minimal' }),
    ).toThrow(HarnessWorkflowUnavailableError);
  });

  it('leaves an off run on the baseline stamp when nothing is selected', () => {
    const selection = selectWorkflow(builtinWorkflowRegistry(), { mode: 'off' });
    expect(selection.decision).toEqual({
      id: BASELINE_WORKFLOW_ID,
      version: 1,
      reasonCode: 'no_workflow_selected',
      source: 'baseline',
    });
    expect(selection.resolved).toBeUndefined();
    expect(selection.overrideScope).toBe('none');
  });

  it('accepts a selection under observe', () => {
    expect(() => assertWorkflowSelectionAvailable('observe', 'safe-edit')).not.toThrow();
  });

  it('gates the forced-minimal rollback lever on an enabled mode too', () => {
    expect(() =>
      selectWorkflow(builtinWorkflowRegistry(), { mode: 'off', forceMinimal: true }),
    ).toThrow(HarnessWorkflowUnavailableError);
  });

  it('reports a disabled harness before complaining about the id shape', () => {
    expect(() => assertWorkflowSelectionAvailable('off', '../candidates/evil')).toThrow(
      HarnessWorkflowUnavailableError,
    );
  });

  it('rejects a malformed id with a typed harness error, not a raw schema error', () => {
    let thrown: unknown;
    try {
      assertWorkflowSelectionAvailable('observe', '../candidates/evil');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessWorkflowInvalidIdError);
    expect((thrown as HarnessWorkflowInvalidIdError).code).toBe('harness_workflow_invalid_id');
    expect(String(thrown)).toContain('../candidates/evil');
  });

  it('stays inert when no workflow is selected, whatever the registry contains', () => {
    // A default parameter would build the registry eagerly, so a malformed
    // built-in could fail commands that never touch the harness.
    const exploding = {
      version: 1,
      digest: 'x',
      list: () => {
        throw new Error('registry must not be consulted');
      },
      get: () => {
        throw new Error('registry must not be consulted');
      },
    } as unknown as WorkflowRegistry;
    expect(() => assertSelectableWorkflow('off', undefined, exploding)).not.toThrow();
    expect(() => assertSelectableWorkflow('observe', undefined, exploding)).not.toThrow();
  });
});

describe('selection precedence', () => {
  const registry = builtinWorkflowRegistry();

  it('prefers the run override over the persisted settings value', () => {
    const selection = selectWorkflow(registry, {
      mode: 'observe',
      runOverride: 'verify-heavy',
      settingsWorkflow: 'safe-edit',
    });
    expect(selection.decision.id).toBe('verify-heavy');
    expect(selection.decision.source).toBe('manual');
    expect(selection.decision.reasonCode).toBe('manual_run_override');
    expect(selection.overrideScope).toBe('run');
  });

  it('uses the persisted settings value when no run override exists', () => {
    const selection = selectWorkflow(registry, { mode: 'observe', settingsWorkflow: 'safe-edit' });
    expect(selection.decision.id).toBe('safe-edit');
    expect(selection.decision.reasonCode).toBe('manual_settings_selection');
    expect(selection.overrideScope).toBe('settings');
  });

  it('stamps baseline when nothing is selected', () => {
    const selection = selectWorkflow(registry, { mode: 'observe' });
    expect(selection.decision.source).toBe('baseline');
    expect(selection.resolved).toBeUndefined();
  });

  it('forces minimal for rollback regardless of any selection', () => {
    const selection = selectWorkflow(registry, {
      mode: 'observe',
      runOverride: 'verify-heavy',
      settingsWorkflow: 'safe-edit',
      forceMinimal: true,
    });
    expect(selection.decision.id).toBe('minimal');
    expect(selection.decision.reasonCode).toBe('rollback_forced_minimal');
    expect(selection.resolved?.policySection).toBe('');
  });

  it('ignores an empty run override instead of discarding the settings selection', () => {
    for (const empty of ['', '   ']) {
      const selection = selectWorkflow(registry, {
        mode: 'observe',
        runOverride: empty,
        settingsWorkflow: 'verify-heavy',
      });
      expect(selection.decision.id).toBe('verify-heavy');
      expect(selection.overrideScope).toBe('settings');
    }
  });

  it('stamps baseline when both selections are empty', () => {
    const selection = selectWorkflow(registry, {
      mode: 'observe',
      runOverride: '  ',
      settingsWorkflow: '',
    });
    expect(selection.decision.source).toBe('baseline');
    expect(selection.overrideScope).toBe('none');
  });

  it('is deterministic for identical requests', () => {
    const first = selectWorkflow(registry, { mode: 'observe', settingsWorkflow: 'verify-heavy' });
    const second = selectWorkflow(registry, { mode: 'observe', settingsWorkflow: 'verify-heavy' });
    expect(second).toEqual(first);
  });
});

describe('selection failure is closed, never a silent fallback', () => {
  const registry = builtinWorkflowRegistry();

  it('rejects an unknown workflow id instead of falling back to minimal', () => {
    expect(() => selectWorkflow(registry, { mode: 'observe', runOverride: 'nope' })).toThrow(
      HarnessWorkflowUnknownError,
    );
  });

  it('rejects candidate-store and path-like selections', () => {
    for (const id of [
      'harness/candidates/evil',
      '../candidates/evil',
      '.book/harness/workflows/evil',
      '/etc/passwd',
      'C:\\temp\\evil',
      'evil.json',
    ]) {
      expect(() => selectWorkflow(registry, { mode: 'observe', runOverride: id })).toThrow();
      expect(registry.get(id)).toBeUndefined();
    }
  });

  it('never resolves a candidate id even when it looks like a promoted one', () => {
    expect(registry.get('candidate')).toBeUndefined();
    expect(registry.get('minimal-candidate')).toBeUndefined();
    expect(registry.get(BASELINE_WORKFLOW_ID)).toBeUndefined();
  });
});

describe('recorded provenance', () => {
  it('carries registry identity and workflow digests on every selection', () => {
    const registry = builtinWorkflowRegistry();
    const selection = selectWorkflow(registry, { mode: 'observe', runOverride: 'verify-heavy' });
    expect(selection.registryDigest).toBe(registry.digest);
    expect(selection.registryVersion).toBe(registry.version);
    expect(selection.resolved?.definitionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(selection.resolved?.policyRenderVersion).toBe('phase-3-v1');
  });

  it('records the registry digest even for a baseline run', () => {
    const registry = builtinWorkflowRegistry();
    const selection = selectWorkflow(registry, { mode: 'observe' });
    expect(selection.registryDigest).toBe(registry.digest);
  });
});
