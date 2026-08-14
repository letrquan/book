import { z } from 'zod';
import { canonicalDigest } from './canonical-json.js';
import { WORKFLOW_ID_MESSAGE, WORKFLOW_ID_PATTERN } from './contracts.js';
import type { CapabilityAuthorityClass } from './contracts.js';

export const WORKFLOW_SCHEMA_VERSION = 1 as const;
/** Bumped whenever the rendered policy text changes for the same definition. */
export const WORKFLOW_POLICY_RENDER_VERSION = 'phase-3-v1';
/** Hard ceiling for the rendered execution-policy section. */
export const MAX_WORKFLOW_POLICY_CHARS = 1024;
export const MAX_WORKFLOW_DESCRIPTION_CHARS = 200;

export const workflowIdSchema = z.string().regex(WORKFLOW_ID_PATTERN, {
  message: WORKFLOW_ID_MESSAGE,
});

/**
 * Recursively strict: every object rejects unknown keys, so an attempt to smuggle
 * a prompt, command, tool schema, permission rule, or model name into a workflow
 * fails validation instead of being silently dropped.
 */
export const workflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
    id: workflowIdSchema,
    version: z.number().int().min(1).max(1_000_000),
    /** Display text only. Never rendered into the prompt as an instruction. */
    description: z.string().min(1).max(MAX_WORKFLOW_DESCRIPTION_CHARS),
    planning: z.enum(['direct', 'light', 'structured']),
    context: z
      .object({
        strategy: z.enum(['minimal', 'relevant', 'deep']),
        maxInputTokens: z.number().int().min(1_000).max(2_000_000).optional(),
        compactionPolicy: z.enum(['existing', 'checkpoint', 'handoff']),
        preserveFailures: z.boolean(),
        preserveDecisions: z.boolean(),
        includeProjectMemory: z.boolean(),
        includeRecentFailures: z.boolean(),
      })
      .strict(),
    verification: z
      .object({
        level: z.enum(['none', 'targeted', 'full']),
        requireEvidenceBeforeSuccess: z.boolean(),
      })
      .strict(),
    execution: z
      .object({
        editScope: z.enum(['small', 'normal', 'broad']),
        retryPosture: z.enum(['default', 'cautious']),
      })
      .strict(),
    /**
     * Advisory and monotone toward more confirmation. `ask-less` does not exist:
     * a workflow can never select `auto`, `dontAsk`, or `bypassPermissions`,
     * override deny rules, or exceed the user's configured mode.
     */
    requestedApprovalPosture: z.enum(['default', 'ask-more']),
  })
  .strict();

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowPlanning = WorkflowDefinition['planning'];
export type WorkflowContextStrategy = WorkflowDefinition['context']['strategy'];
export type WorkflowCompactionPolicy = WorkflowDefinition['context']['compactionPolicy'];
export type WorkflowVerificationLevel = WorkflowDefinition['verification']['level'];
export type WorkflowEditScope = WorkflowDefinition['execution']['editScope'];
export type WorkflowRetryPosture = WorkflowDefinition['execution']['retryPosture'];
export type WorkflowApprovalPosture = WorkflowDefinition['requestedApprovalPosture'];

/**
 * How a resolved field actually reaches execution. No Phase 3 field reports
 * `enforced`: the trusted runtime owns every enforcement point, so a workflow
 * either contributes bounded prompt guidance, is clamped away, or is ignored in
 * favour of fixed host behaviour.
 */
export type WorkflowFieldEnforcement = 'guidance' | 'clamped' | 'host-owned';

export interface WorkflowClamp {
  readonly field: string;
  readonly requested: unknown;
  readonly effective: unknown;
  readonly reason: string;
}

export interface WorkflowFieldDisposition {
  readonly field: string;
  readonly authority: CapabilityAuthorityClass;
  readonly enforcement: WorkflowFieldEnforcement;
  readonly requested: unknown;
  readonly effective: unknown;
}

export interface WorkflowEffectiveSettings {
  readonly planning: WorkflowPlanning;
  readonly context: {
    readonly strategy: WorkflowContextStrategy;
    /** Always absent: no host-enforced workflow-selectable input ceiling exists. */
    readonly maxInputTokens?: undefined;
    /** Always `existing`: compaction and checkpoint/resume are kernel controls. */
    readonly compactionPolicy: 'existing';
    readonly preserveFailures: boolean;
    readonly preserveDecisions: boolean;
    /** Always false: memory and failure injection follow host settings, not workflows. */
    readonly includeProjectMemory: false;
    readonly includeRecentFailures: false;
  };
  readonly verification: {
    readonly level: WorkflowVerificationLevel;
    readonly requireEvidenceBeforeSuccess: boolean;
  };
  readonly execution: {
    readonly editScope: WorkflowEditScope;
    /** Always `default`: retry correctness is a trusted-kernel control. */
    readonly retryPosture: 'default';
  };
  readonly approvalPosture: WorkflowApprovalPosture;
}

export interface WorkflowComplexity {
  readonly renderedChars: number;
  readonly estimatedTokens: number;
  /** Effective fields that differ from the `minimal` baseline. */
  readonly activeFieldCount: number;
  readonly clampCount: number;
  /** Extra verification calls the workflow asks the model to make. */
  readonly requestedExtraCalls: number;
}

export interface ResolvedWorkflow {
  readonly requested: WorkflowDefinition;
  readonly effective: WorkflowEffectiveSettings;
  readonly clamps: readonly WorkflowClamp[];
  readonly dispositions: readonly WorkflowFieldDisposition[];
  readonly definitionDigest: string;
  readonly policyRenderVersion: string;
  readonly policySection: string;
  readonly complexity: WorkflowComplexity;
}

// ---------------------------------------------------------------------------
// Built-in definitions
// ---------------------------------------------------------------------------

/**
 * `minimal` preserves current Book behaviour: it renders no policy text and
 * produces no clamps, so its provider messages stay identical to the baseline.
 */
const MINIMAL: WorkflowDefinition = {
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  id: 'minimal',
  version: 1,
  description: 'Preserve existing Book behaviour with no added scaffolding.',
  planning: 'direct',
  context: {
    strategy: 'relevant',
    compactionPolicy: 'existing',
    preserveFailures: false,
    preserveDecisions: false,
    includeProjectMemory: false,
    includeRecentFailures: false,
  },
  verification: { level: 'none', requireEvidenceBeforeSuccess: false },
  execution: { editScope: 'normal', retryPosture: 'default' },
  requestedApprovalPosture: 'default',
};

const SAFE_EDIT: WorkflowDefinition = {
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  id: 'safe-edit',
  version: 1,
  description: 'Plan mutating work, keep edits small, and verify what changed.',
  planning: 'light',
  context: {
    strategy: 'relevant',
    compactionPolicy: 'existing',
    preserveFailures: true,
    preserveDecisions: true,
    includeProjectMemory: false,
    includeRecentFailures: false,
  },
  verification: { level: 'targeted', requireEvidenceBeforeSuccess: false },
  execution: { editScope: 'small', retryPosture: 'default' },
  requestedApprovalPosture: 'ask-more',
};

const VERIFY_HEAVY: WorkflowDefinition = {
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  id: 'verify-heavy',
  version: 1,
  description: 'Require explicit verification evidence before claiming completion.',
  planning: 'structured',
  context: {
    strategy: 'deep',
    compactionPolicy: 'existing',
    preserveFailures: true,
    preserveDecisions: true,
    includeProjectMemory: false,
    includeRecentFailures: false,
  },
  verification: { level: 'full', requireEvidenceBeforeSuccess: true },
  execution: { editScope: 'normal', retryPosture: 'default' },
  requestedApprovalPosture: 'default',
};

/** The three comparison instruments. Do not tune these during Phase 3. */
export const BUILTIN_WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] = Object.freeze([
  MINIMAL,
  SAFE_EDIT,
  VERIFY_HEAVY,
]);

export const MINIMAL_WORKFLOW_ID = MINIMAL.id;

// ---------------------------------------------------------------------------
// Resolution: requested -> effective, with explicit clamps
// ---------------------------------------------------------------------------

/**
 * Authority for every workflow field, taken from the Phase 1 capability matrix.
 * Fields absent from this map do not exist in the schema.
 */
const FIELD_AUTHORITY: Readonly<Record<string, CapabilityAuthorityClass>> = Object.freeze({
  planning: 'bounded-model-guidance',
  'context.strategy': 'bounded-model-guidance',
  'context.maxInputTokens': 'unsupported-clamped',
  'context.compactionPolicy': 'kernel-enforced',
  'context.preserveFailures': 'bounded-model-guidance',
  'context.preserveDecisions': 'bounded-model-guidance',
  'context.includeProjectMemory': 'unsupported-clamped',
  'context.includeRecentFailures': 'unsupported-clamped',
  'verification.level': 'bounded-model-guidance',
  'verification.requireEvidenceBeforeSuccess': 'bounded-model-guidance',
  'execution.editScope': 'bounded-model-guidance',
  'execution.retryPosture': 'unsupported-clamped',
  requestedApprovalPosture: 'bounded-model-guidance',
});

const EXTRA_CALLS_BY_VERIFICATION: Readonly<Record<WorkflowVerificationLevel, number>> =
  Object.freeze({ none: 0, targeted: 1, full: 2 });

/**
 * Apply the trusted-kernel clamps. Every dropped or downgraded request produces
 * a clamp record so the restriction is visible rather than silently ignored.
 */
export function resolveWorkflow(definition: WorkflowDefinition): ResolvedWorkflow {
  const requested = workflowDefinitionSchema.parse(definition);
  const clamps: WorkflowClamp[] = [];
  const clamp = (field: string, from: unknown, to: unknown, reason: string): void => {
    if (from === to) return;
    clamps.push({ field, requested: from, effective: to, reason });
  };

  clamp(
    'context.maxInputTokens',
    requested.context.maxInputTokens,
    undefined,
    'no_host_enforced_input_ceiling',
  );
  clamp(
    'context.compactionPolicy',
    requested.context.compactionPolicy,
    'existing',
    'compaction_is_kernel_controlled',
  );
  clamp(
    'context.includeProjectMemory',
    requested.context.includeProjectMemory,
    false,
    'memory_inclusion_is_host_owned',
  );
  clamp(
    'context.includeRecentFailures',
    requested.context.includeRecentFailures,
    false,
    'failure_injection_is_host_owned',
  );
  clamp(
    'execution.retryPosture',
    requested.execution.retryPosture,
    'default',
    'retry_correctness_is_kernel_controlled',
  );

  const effective: WorkflowEffectiveSettings = {
    planning: requested.planning,
    context: {
      strategy: requested.context.strategy,
      maxInputTokens: undefined,
      compactionPolicy: 'existing',
      preserveFailures: requested.context.preserveFailures,
      preserveDecisions: requested.context.preserveDecisions,
      includeProjectMemory: false,
      includeRecentFailures: false,
    },
    verification: {
      level: requested.verification.level,
      requireEvidenceBeforeSuccess: requested.verification.requireEvidenceBeforeSuccess,
    },
    execution: { editScope: requested.execution.editScope, retryPosture: 'default' },
    approvalPosture: requested.requestedApprovalPosture,
  };

  const clampedFields = new Set(clamps.map((entry) => entry.field));
  const dispositions: WorkflowFieldDisposition[] = Object.entries(FIELD_AUTHORITY).map(
    ([field, authority]) => {
      const requestedValue = readField(requested, field);
      const effectiveValue = readEffectiveField(effective, field);
      return {
        field,
        authority,
        enforcement:
          authority === 'bounded-model-guidance'
            ? 'guidance'
            : clampedFields.has(field)
              ? 'clamped'
              : 'host-owned',
        requested: requestedValue,
        effective: effectiveValue,
      };
    },
  );

  const policySection = renderWorkflowPolicySection(requested, effective);
  const renderedChars = policySection.length;

  return {
    requested,
    effective,
    clamps: Object.freeze(clamps),
    dispositions: Object.freeze(dispositions),
    definitionDigest: canonicalDigest('book-harness-workflow-v1', requested),
    policyRenderVersion: WORKFLOW_POLICY_RENDER_VERSION,
    policySection,
    complexity: {
      renderedChars,
      estimatedTokens: Math.ceil(renderedChars / 4),
      activeFieldCount: countActiveFields(effective),
      clampCount: clamps.length,
      requestedExtraCalls: EXTRA_CALLS_BY_VERIFICATION[effective.verification.level],
    },
  };
}

function readField(definition: WorkflowDefinition, field: string): unknown {
  switch (field) {
    case 'planning':
      return definition.planning;
    case 'context.strategy':
      return definition.context.strategy;
    case 'context.maxInputTokens':
      return definition.context.maxInputTokens;
    case 'context.compactionPolicy':
      return definition.context.compactionPolicy;
    case 'context.preserveFailures':
      return definition.context.preserveFailures;
    case 'context.preserveDecisions':
      return definition.context.preserveDecisions;
    case 'context.includeProjectMemory':
      return definition.context.includeProjectMemory;
    case 'context.includeRecentFailures':
      return definition.context.includeRecentFailures;
    case 'verification.level':
      return definition.verification.level;
    case 'verification.requireEvidenceBeforeSuccess':
      return definition.verification.requireEvidenceBeforeSuccess;
    case 'execution.editScope':
      return definition.execution.editScope;
    case 'execution.retryPosture':
      return definition.execution.retryPosture;
    case 'requestedApprovalPosture':
      return definition.requestedApprovalPosture;
    default:
      return undefined;
  }
}

function readEffectiveField(effective: WorkflowEffectiveSettings, field: string): unknown {
  switch (field) {
    case 'planning':
      return effective.planning;
    case 'context.strategy':
      return effective.context.strategy;
    case 'context.maxInputTokens':
      return effective.context.maxInputTokens;
    case 'context.compactionPolicy':
      return effective.context.compactionPolicy;
    case 'context.preserveFailures':
      return effective.context.preserveFailures;
    case 'context.preserveDecisions':
      return effective.context.preserveDecisions;
    case 'context.includeProjectMemory':
      return effective.context.includeProjectMemory;
    case 'context.includeRecentFailures':
      return effective.context.includeRecentFailures;
    case 'verification.level':
      return effective.verification.level;
    case 'verification.requireEvidenceBeforeSuccess':
      return effective.verification.requireEvidenceBeforeSuccess;
    case 'execution.editScope':
      return effective.execution.editScope;
    case 'execution.retryPosture':
      return effective.execution.retryPosture;
    case 'requestedApprovalPosture':
      return effective.approvalPosture;
    default:
      return undefined;
  }
}

const BASELINE_EFFECTIVE = Object.freeze({
  planning: 'direct',
  strategy: 'relevant',
  preserveFailures: false,
  preserveDecisions: false,
  verificationLevel: 'none',
  requireEvidenceBeforeSuccess: false,
  editScope: 'normal',
  approvalPosture: 'default',
} as const);

function countActiveFields(effective: WorkflowEffectiveSettings): number {
  let count = 0;
  if (effective.planning !== BASELINE_EFFECTIVE.planning) count++;
  if (effective.context.strategy !== BASELINE_EFFECTIVE.strategy) count++;
  if (effective.context.preserveFailures !== BASELINE_EFFECTIVE.preserveFailures) count++;
  if (effective.context.preserveDecisions !== BASELINE_EFFECTIVE.preserveDecisions) count++;
  if (effective.verification.level !== BASELINE_EFFECTIVE.verificationLevel) count++;
  if (
    effective.verification.requireEvidenceBeforeSuccess !==
    BASELINE_EFFECTIVE.requireEvidenceBeforeSuccess
  ) {
    count++;
  }
  if (effective.execution.editScope !== BASELINE_EFFECTIVE.editScope) count++;
  if (effective.approvalPosture !== BASELINE_EFFECTIVE.approvalPosture) count++;
  return count;
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/**
 * Fixed templates keyed on enum values. A workflow's free-form `description` is
 * never interpolated here, so untrusted definition text cannot become an
 * instruction even once project-local workflow files are supported.
 */
const PLANNING_GUIDANCE: Readonly<Record<WorkflowPlanning, string>> = Object.freeze({
  direct: '',
  light: 'Before mutating work, state a short ordered plan.',
  structured:
    'Before mutating work, plan the scope, affected areas, risks, and how each step will be verified.',
});

const CONTEXT_GUIDANCE: Readonly<Record<WorkflowContextStrategy, string>> = Object.freeze({
  minimal: 'Inspect only what the current step needs; avoid broad exploratory reads.',
  relevant: '',
  deep: 'Inspect surrounding call sites, tests, and configuration before changing behavior.',
});

const VERIFICATION_GUIDANCE: Readonly<Record<WorkflowVerificationLevel, string>> = Object.freeze({
  none: '',
  targeted: 'After a meaningful change, run the focused tests or checks that cover it.',
  full: 'Run the project verifiers you are authorized to run, then review the final diff for regressions.',
});

const EDIT_SCOPE_GUIDANCE: Readonly<Record<WorkflowEditScope, string>> = Object.freeze({
  small:
    'Keep edits narrow. Treat dependency, migration, and multi-file rewrites as needing confirmation first.',
  normal: '',
  broad: '',
});

const APPROVAL_GUIDANCE: Readonly<Record<WorkflowApprovalPosture, string>> = Object.freeze({
  default: '',
  'ask-more':
    'Confirm before hard-to-reverse or wide-reaching actions, even when the permission mode allows them.',
});

const EVIDENCE_GUIDANCE =
  'State the verification evidence for completion; if blocked, say what ran and what is unchecked.';

const RETAIN_FAILURES_GUIDANCE =
  'Carry failed attempts and their causes forward; do not retry a failed approach unchanged.';

const RETAIN_DECISIONS_GUIDANCE = 'Keep later steps consistent with decisions already made.';

/**
 * Render the bounded execution-policy section for the dynamic prompt zone.
 * Returns an empty string when the workflow adds nothing over the baseline, so
 * `minimal` leaves provider messages byte-identical to a run with no harness.
 */
export function renderWorkflowPolicySection(
  definition: WorkflowDefinition,
  effective: WorkflowEffectiveSettings,
): string {
  const lines = [
    PLANNING_GUIDANCE[effective.planning],
    CONTEXT_GUIDANCE[effective.context.strategy],
    effective.context.preserveFailures ? RETAIN_FAILURES_GUIDANCE : '',
    effective.context.preserveDecisions ? RETAIN_DECISIONS_GUIDANCE : '',
    VERIFICATION_GUIDANCE[effective.verification.level],
    effective.verification.requireEvidenceBeforeSuccess ? EVIDENCE_GUIDANCE : '',
    EDIT_SCOPE_GUIDANCE[effective.execution.editScope],
    APPROVAL_GUIDANCE[effective.approvalPosture],
  ].filter((line) => line.length > 0);

  if (lines.length === 0) return '';

  return [
    '## Execution policy',
    `Active workflow: ${definition.id} v${definition.version} (${WORKFLOW_POLICY_RENDER_VERSION}). Guidance only, not enforcement; permissions, sandboxing, budgets, retries, compaction, and tool contracts stay host-controlled.`,
    ...lines.map((line) => `- ${line}`),
  ].join('\n');
}

export class WorkflowValidationError extends Error {
  readonly code = 'harness_workflow_invalid';

  constructor(
    readonly workflowId: string,
    reason: string,
  ) {
    super(`Harness workflow "${workflowId}" is invalid: ${reason}`);
    this.name = 'WorkflowValidationError';
  }
}
