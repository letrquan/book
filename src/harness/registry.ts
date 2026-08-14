import { canonicalDigest } from './canonical-json.js';
import { WORKFLOW_ID_MESSAGE, WORKFLOW_ID_PATTERN } from './contracts.js';
import type { HarnessMode, WorkflowDecision, WorkflowOverrideScope } from './contracts.js';
import {
  BUILTIN_WORKFLOW_DEFINITIONS,
  MAX_WORKFLOW_POLICY_CHARS,
  MINIMAL_WORKFLOW_ID,
  WorkflowValidationError,
  resolveWorkflow,
  workflowDefinitionSchema,
  type ResolvedWorkflow,
  type WorkflowDefinition,
} from './workflows.js';

/** Registry format version; distinct from any individual workflow version. */
export const WORKFLOW_REGISTRY_VERSION = 1 as const;

/** The label Phase 2 stamps on runs where no workflow was selected. */
export const BASELINE_WORKFLOW_ID = 'baseline';

/** Shared by the coordinator fallback and the no-selection branch below. */
export const BASELINE_WORKFLOW_DECISION: WorkflowDecision = Object.freeze({
  id: BASELINE_WORKFLOW_ID,
  version: 1,
  reasonCode: 'no_workflow_selected',
  source: 'baseline',
});

export interface WorkflowRegistry {
  readonly version: typeof WORKFLOW_REGISTRY_VERSION;
  /** Canonical digest over every promoted definition, in registry order. */
  readonly digest: string;
  list(): readonly ResolvedWorkflow[];
  /** Active (highest promoted) version for an ID, or undefined when unknown. */
  get(id: string): ResolvedWorkflow | undefined;
}

export class HarnessWorkflowUnavailableError extends Error {
  readonly code = 'harness_workflow_unavailable';

  constructor(readonly mode: HarnessMode) {
    super(
      `Harness workflow selection requires an enabled harness mode; mode is "${mode}". ` +
        'Set harness.mode to "observe" so the selected workflow is recorded with the run, ' +
        'or remove the workflow selection.',
    );
    this.name = 'HarnessWorkflowUnavailableError';
  }
}

export class HarnessWorkflowInvalidIdError extends Error {
  readonly code = 'harness_workflow_invalid_id';

  constructor(readonly workflowId: string) {
    super(`Invalid harness workflow id "${workflowId}". ${WORKFLOW_ID_MESSAGE}`);
    this.name = 'HarnessWorkflowInvalidIdError';
  }
}

export class HarnessWorkflowUnknownError extends Error {
  readonly code = 'harness_workflow_unknown';

  constructor(
    readonly workflowId: string,
    known: readonly string[],
  ) {
    super(`Unknown harness workflow "${workflowId}". Available workflows: ${known.join(', ')}.`);
    this.name = 'HarnessWorkflowUnknownError';
  }
}

/**
 * Build a registry from promoted definitions. Every definition is revalidated
 * here — built-ins take the same path project-local files would — so an invalid
 * or unrenderable workflow fails at construction instead of mid-run.
 */
export function createWorkflowRegistry(
  definitions: readonly WorkflowDefinition[] = BUILTIN_WORKFLOW_DEFINITIONS,
): WorkflowRegistry {
  const active = new Map<string, ResolvedWorkflow>();
  const highestVersion = new Map<string, number>();
  const canonical: WorkflowDefinition[] = [];

  for (const candidate of definitions) {
    const parsed = workflowDefinitionSchema.safeParse(candidate);
    if (!parsed.success) {
      const id = typeof candidate?.id === 'string' ? candidate.id : '<unnamed>';
      throw new WorkflowValidationError(id, parsed.error.issues[0]?.message ?? 'schema rejected');
    }
    const definition = parsed.data;
    const previous = highestVersion.get(definition.id);
    if (previous !== undefined && definition.version <= previous) {
      throw new WorkflowValidationError(
        definition.id,
        previous === definition.version
          ? `duplicate id at version ${definition.version}`
          : `version ${definition.version} is not greater than promoted version ${previous}`,
      );
    }
    const resolved = resolveWorkflow(definition);
    if (resolved.policySection.length > MAX_WORKFLOW_POLICY_CHARS) {
      throw new WorkflowValidationError(
        definition.id,
        `rendered policy is ${resolved.policySection.length} characters, over the ${MAX_WORKFLOW_POLICY_CHARS} budget`,
      );
    }
    highestVersion.set(definition.id, definition.version);
    active.set(definition.id, resolved);
    canonical.push(definition);
  }

  if (!active.has(MINIMAL_WORKFLOW_ID)) {
    throw new WorkflowValidationError(
      MINIMAL_WORKFLOW_ID,
      'the minimal fallback workflow must be present in every registry',
    );
  }

  const digest = canonicalDigest('book-harness-registry-v1', {
    version: WORKFLOW_REGISTRY_VERSION,
    definitions: canonical,
  });
  const entries = Object.freeze([...active.values()]);

  return Object.freeze({
    version: WORKFLOW_REGISTRY_VERSION,
    digest,
    list: () => entries,
    get: (id: string) => active.get(id),
  });
}

export interface WorkflowSelectionRequest {
  readonly mode: HarnessMode;
  /** Process/run-scoped override from `--harness-workflow` or a session command. */
  readonly runOverride?: string;
  /** Persisted `harness.workflow` from the resolved settings layers. */
  readonly settingsWorkflow?: string;
  /** Rollback lever: ignore every selection and pin `minimal`. */
  readonly forceMinimal?: boolean;
}

export interface WorkflowSelection {
  readonly decision: WorkflowDecision;
  /** Absent for the `baseline` decision, which selects no registry workflow. */
  readonly resolved?: ResolvedWorkflow;
  readonly registryVersion: number;
  readonly registryDigest: string;
  readonly overrideScope: WorkflowOverrideScope;
}

/**
 * Reject a workflow selection that could never be recorded. Under `off` the
 * harness creates no run context and no ledger, so an effective workflow would
 * change behaviour with no provenance — fail closed instead of silently
 * ignoring the request.
 */
export function assertWorkflowSelectionAvailable(
  mode: HarnessMode,
  workflowId: string | undefined,
): void {
  if (!workflowId) return;
  // Mode first: with the harness disabled, "the harness is off" is the useful
  // diagnosis whether or not the ID is also malformed.
  if (mode === 'off') throw new HarnessWorkflowUnavailableError(mode);
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
    throw new HarnessWorkflowInvalidIdError(workflowId);
  }
}

/**
 * Full launch-time gate for a configured selection: valid ID shape, an enabled
 * harness mode, and a workflow the promoted registry actually contains. Hosts
 * call this before a run starts so a bad selection fails at load rather than
 * degrading to baseline mid-run.
 */
export function assertSelectableWorkflow(
  mode: HarnessMode,
  workflowId: string | undefined,
  registry?: WorkflowRegistry,
): void {
  // Nothing selected is the overwhelmingly common case. Return before touching
  // the registry so an `off` run stays inert and a malformed built-in cannot
  // fail unrelated commands: a default parameter would be evaluated eagerly.
  if (!workflowId) return;
  assertWorkflowSelectionAvailable(mode, workflowId);
  const resolvedRegistry = registry ?? builtinWorkflowRegistry();
  if (resolvedRegistry.get(workflowId)) return;
  throw new HarnessWorkflowUnknownError(
    workflowId,
    resolvedRegistry.list().map((entry) => entry.requested.id),
  );
}

/**
 * Resolve the active workflow. Precedence is run override, then persisted
 * settings, then the Phase 2 `baseline` stamp when nothing was selected.
 * An unknown ID never falls back — it fails the run.
 */
export function selectWorkflow(
  registry: WorkflowRegistry,
  request: WorkflowSelectionRequest,
): WorkflowSelection {
  const base = {
    registryVersion: registry.version,
    registryDigest: registry.digest,
  } as const;

  if (request.forceMinimal) {
    // The rollback lever still produces a recorded manual decision, so it
    // remains subject to the same enabled-mode requirement as any selection.
    assertWorkflowSelectionAvailable(request.mode, MINIMAL_WORKFLOW_ID);
    const resolved = registry.get(MINIMAL_WORKFLOW_ID)!;
    return {
      ...base,
      overrideScope: 'run',
      resolved,
      decision: {
        id: resolved.requested.id,
        version: resolved.requested.version,
        reasonCode: 'rollback_forced_minimal',
        source: 'manual',
      },
    };
  }

  // Truthy, not nullish: an empty or whitespace override must not shadow a
  // persisted selection, and must not be treated as a selection itself.
  const requestedId = request.runOverride?.trim() || request.settingsWorkflow?.trim();
  if (!requestedId) {
    return { ...base, overrideScope: 'none', decision: BASELINE_WORKFLOW_DECISION };
  }

  assertWorkflowSelectionAvailable(request.mode, requestedId);
  const resolved = registry.get(requestedId);
  if (!resolved) {
    throw new HarnessWorkflowUnknownError(
      requestedId,
      registry.list().map((entry) => entry.requested.id),
    );
  }

  const scope: WorkflowOverrideScope = request.runOverride?.trim() ? 'run' : 'settings';
  return {
    ...base,
    overrideScope: scope,
    resolved,
    decision: {
      id: resolved.requested.id,
      version: resolved.requested.version,
      reasonCode: scope === 'run' ? 'manual_run_override' : 'manual_settings_selection',
      source: 'manual',
    },
  };
}

/**
 * The promoted registry: built-ins only, project files are not loaded. Built
 * fresh per call rather than cached in module state — validating three frozen
 * definitions is a few small parses and digests, and callers reach it only on a
 * path that already has a workflow selected.
 */
export function builtinWorkflowRegistry(): WorkflowRegistry {
  return createWorkflowRegistry();
}
