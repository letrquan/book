/** Modes are enabled one phase at a time; Phase 1 permits only `off`. */
export type HarnessMode = 'off' | 'observe' | 'shadow' | 'active' | 'learn';

export type WorkflowDecisionSource = 'baseline' | 'manual' | 'fixed' | 'adaptive' | 'candidate';

declare const boundedHarnessTextBrand: unique symbol;

/** Text accepted by the harness ingress validator after size and secret checks. */
export type BoundedHarnessText = string & {
  readonly [boundedHarnessTextBrand]: true;
};

/** Immutable workflow identity selected before a run starts. */
export interface WorkflowDecision {
  readonly id: string;
  readonly version: number;
  readonly reasonCode: string;
  /** Bounded, redacted display text; never a free-form executable instruction. */
  readonly explanation?: BoundedHarnessText;
  readonly source: WorkflowDecisionSource;
}

/** Harness-owned metadata. It is absent when the harness mode is `off`. */
export interface HarnessRunContext {
  readonly runId: string;
  readonly mode: Exclude<HarnessMode, 'off'>;
  readonly workflow?: WorkflowDecision;
  readonly policyVersion?: string;
  readonly runtimeFingerprint?: string;
  readonly environmentFingerprint?: string;
  readonly toolSurfaceFingerprint?: string;
  readonly capabilityManifestDigest?: string;
  readonly workspaceTrustFingerprint?: string;
  readonly integrationFingerprint?: string;
}

export type HarnessTerminalStatus =
  'completed' | 'failed' | 'cancelled' | 'aborted' | 'timed-out' | 'interrupted';

export type HarnessOutcomeDimension =
  | 'correctness'
  | 'reliability'
  | 'regression-risk'
  | 'user-alignment'
  | 'maintainability'
  | 'efficiency'
  | 'long-horizon-stability'
  | 'harness-complexity';

export type HarnessOutcomeStatus = 'pass' | 'fail' | 'unknown' | 'not-applicable';

export interface HarnessOutcome {
  readonly dimension: HarnessOutcomeDimension;
  readonly status: HarnessOutcomeStatus;
  readonly reasonCode: string;
  readonly evidenceRefs?: readonly BoundedHarnessText[];
}

export type HarnessEventType =
  | 'run-started'
  | 'provider-requested'
  | 'assistant-message-completed'
  | 'tool-started'
  | 'tool-completed'
  | 'verification-completed'
  | 'run-completed';

export type HarnessEventAttribute = BoundedHarnessText | number | boolean | null;

/** Events carry bounded summaries and references, not raw prompts or tool output. */
export interface HarnessEvent {
  readonly type: HarnessEventType;
  readonly occurredAt: number;
  readonly sequence?: number;
  readonly summary?: BoundedHarnessText;
  readonly attributes?: Readonly<Record<string, HarnessEventAttribute>>;
  readonly evidenceRefs?: readonly BoundedHarnessText[];
}

export interface PrepareRunInput {
  readonly mode: HarnessMode;
}

export type PreparedRun =
  | { readonly status: 'disabled'; readonly mode: 'off' }
  | {
      readonly status: 'prepared';
      readonly mode: Exclude<HarnessMode, 'off'>;
      readonly context: HarnessRunContext;
      readonly observer: HarnessObserver;
    };

export interface FinalizeRunInput {
  readonly status: HarnessTerminalStatus;
  readonly outcomes?: readonly HarnessOutcome[];
}

export type HarnessObserverEnqueueResult = 'accepted' | 'dropped' | 'closed';

export type HarnessObserverOverflowPolicy = 'drop-newest' | 'drop-oldest';

export interface HarnessObserverPolicy {
  readonly maxQueueSize: number;
  readonly overflow: HarnessObserverOverflowPolicy;
  readonly flushTimeoutMs: number;
  readonly closeTimeoutMs: number;
}

export interface HarnessObserverFlushResult {
  readonly flushed: boolean;
  readonly droppedEventCount: number;
  readonly failureReason?: string;
}

/** Enabled observers must make queue pressure and shutdown outcomes explicit. */
export interface HarnessObserver {
  readonly policy: HarnessObserverPolicy;
  enqueue(event: HarnessEvent): HarnessObserverEnqueueResult;
  flush(): Promise<HarnessObserverFlushResult>;
  close(): Promise<HarnessObserverFlushResult>;
}

export interface HarnessWorkflowTransition {
  readonly sequence: number;
  readonly occurredAt: number;
  readonly fromWorkflowId: string;
  readonly toWorkflow: WorkflowDecision;
  readonly reasonCode: string;
}

/** Initial selection is immutable; later changes are explicit, ordered transition records. */
export interface HarnessTransitionState {
  readonly initialWorkflow?: WorkflowDecision;
  readonly currentWorkflow?: WorkflowDecision;
  readonly transitions: readonly HarnessWorkflowTransition[];
}

export interface HarnessCoordinator {
  prepareRun(input: PrepareRunInput): Promise<PreparedRun>;
  observe(runId: string, event: HarnessEvent): HarnessObserverEnqueueResult;
  finalizeRun(runId: string, result: FinalizeRunInput): Promise<HarnessObserverFlushResult>;
}

export interface RuntimeCompatibilityIdentity {
  readonly runtimeFingerprint: string;
  readonly environmentFingerprint: string;
  readonly toolSurfaceFingerprint: string;
  readonly contextCapabilitiesVersion: string;
}

export interface ToolSurfaceDescriptor {
  readonly id: string;
  readonly schemaHash: string;
  readonly implementationVersion?: string;
  readonly permissionClass: string;
  readonly supportsCancellation: boolean;
  readonly retrySafety: 'safe' | 'unsafe' | 'unknown';
}

export type CapabilityAuthorityClass =
  | 'kernel-enforced'
  | 'host-enforced'
  | 'deterministic-hook'
  | 'trusted-verifier'
  | 'bounded-model-guidance'
  | 'unsupported-clamped';

export type CapabilityAvailability =
  | 'disabled'
  | 'available'
  | 'approved'
  | 'denied'
  | 'clamped'
  | 'unsupported'
  | 'initialization-failed';

export interface CapabilityReference {
  readonly id: string;
  readonly version: string;
  readonly digest?: string;
  readonly authority: CapabilityAuthorityClass;
  readonly availability: CapabilityAvailability;
  readonly reasonCode?: string;
}

export interface RequestedEffectiveCapability {
  readonly requested?: CapabilityReference;
  readonly effective?: CapabilityReference;
  readonly status: CapabilityAvailability;
  readonly reasonCode?: string;
}

export type HarnessHostSurface = 'tui' | 'headless' | 'ci' | 'sdk';
export type ExternalIntegrationKind = 'provider' | 'mcp' | 'web';
export type WorkspaceTrustState = 'trusted' | 'untrusted' | 'unknown';

export interface WorkspaceTrustReference {
  readonly workspaceId: string;
  readonly state: WorkspaceTrustState;
  readonly decisionSource: 'user' | 'host-policy' | 'unavailable';
  readonly fingerprint?: string;
  readonly reasonCode?: string;
}

export interface IntegrationSecurityPosture {
  readonly credentials: 'none' | 'scoped' | 'unavailable';
  readonly network: 'off' | 'restricted' | 'enabled' | 'unavailable';
  readonly sandbox: 'required' | 'optional' | 'unavailable';
  readonly permissionCeiling: string;
}

export interface ExternalIntegrationReference {
  readonly id: string;
  readonly kind: ExternalIntegrationKind;
  readonly hostSurface: HarnessHostSurface;
  readonly state: CapabilityAvailability;
  readonly requested: IntegrationSecurityPosture;
  readonly effective?: IntegrationSecurityPosture;
  readonly fingerprint?: string;
  readonly reasonCode?: string;
}

export interface AgentCapabilityManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly promptLayers: readonly CapabilityReference[];
  readonly skills: readonly CapabilityReference[];
  readonly tools: readonly CapabilityReference[];
  readonly contextPolicies: readonly CapabilityReference[];
  readonly modelProviderCapabilities: readonly CapabilityReference[];
  readonly verificationCapabilities: readonly CapabilityReference[];
  readonly hooks: readonly CapabilityReference[];
  readonly delegationCapabilities: readonly CapabilityReference[];
  readonly permissionCapabilities: readonly CapabilityReference[];
  readonly workspaceTrust?: WorkspaceTrustReference;
  readonly integrations: readonly ExternalIntegrationReference[];
}

/** A workflow may reference registered policies, but cannot embed their implementations. */
export interface WorkflowCapabilityRequest {
  readonly promptLayerIds?: readonly string[];
  readonly skillPolicyId?: string;
  readonly toolExposurePolicyId?: string;
  readonly contextPolicyId?: string;
  readonly modelAdapterId?: string;
  readonly verificationPolicyId?: string;
  readonly hookPolicyId?: string;
  readonly delegationPolicyId?: string;
}

/** These controls remain owned by the trusted runtime and cannot be workflow-selected. */
export type TrustedKernelControl =
  | 'permissions'
  | 'sandbox'
  | 'secrets'
  | 'absolute-budgets'
  | 'evaluator-definitions'
  | 'held-out-membership'
  | 'audit-retention'
  | 'promotion-authority'
  | 'model-provider-identity'
  | 'tool-contracts'
  | 'prompt-injection-defense'
  | 'provenance-rules'
  | 'checkpoint-resume'
  | 'compaction'
  | 'cancellation'
  | 'retry-correctness'
  | 'trace-integrity';
