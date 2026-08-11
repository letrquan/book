import { z } from 'zod';
import {
  SafeEvaluationIdSchema,
  Sha256DigestSchema,
  canonicalJson,
  evaluationDigest,
} from './identity.js';

export const PHASE_0_CONFIRMATORY_POLICY = Object.freeze({
  familyWiseAlpha: 0.05,
  minimumPower: 0.8,
  minimumHeldOutFamilies: 20,
  minimumRepetitionsPerFamily: 5,
  minimumMatchedAaBlocks: 20,
  machineSuccessPracticalEffect: 0.15,
  protectedSuccessMargin: -0.05,
  unknownRateMargin: 0.02,
  timeoutRateMargin: 0.02,
  evaluatorOrMissingRateMargin: 0.02,
  resourceIncreaseMargin: 0.25,
  rubricMargin: -0.25,
  zeroToleranceViolations: 0,
});

export const PHASE_0_REQUIRED_LOCKED_COMPONENT_IDS = Object.freeze([
  'corpus',
  'split',
  'case',
  'fixture',
  'verifier',
  'provider-origin',
  'provider-adapter',
  'resolved-model',
  'evaluator',
  'analysis',
  'report-schema',
  'worker',
  'runtime',
  'os-isolation',
  'tool-surface',
  'network-policy',
  'broker',
  'credential-audience',
  'budget',
  'pricing',
  'evaluation-date',
  'locale',
  'account-region',
  'concurrency',
  'cache-policy',
  'rate-limit-policy',
] as const);

export const EvaluationTerminalCategorySchema = z.enum([
  'success',
  'task-failure',
  'budget-exhaustion',
  'agent-runtime-failure',
  'timeout',
  'required-artifact-missing',
  'execution-cancelled',
  'user-cancelled',
  'unknown',
  'missing-outcome',
  'evaluator-failure',
  'setup-failure',
  'comparison-identity-failure',
  'evaluator-integrity-failure',
  'cleanup-failure',
]);

export type EvaluationTerminalCategory = z.infer<typeof EvaluationTerminalCategorySchema>;

export interface IntentionToTreatClassification {
  enrolled: boolean;
  comparisonValid: boolean;
  successContribution?: 0 | 1;
  rawCategory: EvaluationTerminalCategory;
  disposition: 'not-enrolled' | 'invalid-block' | 'intention-to-treat';
}

/** Preserve the raw category while applying the frozen #46 enrollment and ITT rules. */
export function classifyIntentionToTreatOutcome(input: {
  category: EvaluationTerminalCategory;
  assigned: boolean;
  anyArmStarted: boolean;
  comparisonIdentityValid: boolean;
  evaluatorIntegrityValid: boolean;
}): IntentionToTreatClassification {
  if (!input.assigned && !input.anyArmStarted && input.category === 'setup-failure') {
    return {
      enrolled: false,
      comparisonValid: true,
      rawCategory: input.category,
      disposition: 'not-enrolled',
    };
  }
  if (!input.assigned && !input.anyArmStarted) {
    return {
      enrolled: false,
      comparisonValid: false,
      rawCategory: input.category,
      disposition: 'invalid-block',
    };
  }
  if (!input.comparisonIdentityValid || !input.evaluatorIntegrityValid) {
    return {
      enrolled: input.assigned || input.anyArmStarted,
      comparisonValid: false,
      rawCategory: input.category,
      disposition: 'invalid-block',
    };
  }
  return {
    enrolled: input.assigned || input.anyArmStarted,
    comparisonValid: true,
    successContribution: input.category === 'success' ? 1 : 0,
    rawCategory: input.category,
    disposition: 'intention-to-treat',
  };
}

const NonEmptyStringSchema = z.string().min(1);

const RawOutcomeCountsSchema = z
  .object({
    success: z.number().int().nonnegative(),
    taskFailure: z.number().int().nonnegative(),
    budgetExhaustion: z.number().int().nonnegative(),
    agentRuntimeFailure: z.number().int().nonnegative(),
    timeout: z.number().int().nonnegative(),
    requiredArtifactMissing: z.number().int().nonnegative(),
    executionCancelled: z.number().int().nonnegative(),
    userCancelled: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    missingOutcome: z.number().int().nonnegative(),
    evaluatorFailure: z.number().int().nonnegative(),
    setupFailure: z.number().int().nonnegative(),
    comparisonIdentityFailure: z.number().int().nonnegative(),
    evaluatorIntegrityFailure: z.number().int().nonnegative(),
    cleanupFailure: z.number().int().nonnegative(),
  })
  .strict();

const ArmOutcomeSchema = z
  .object({
    armId: SafeEvaluationIdSchema,
    role: z.enum(['baseline', 'candidate']),
    assigned: z.number().int().nonnegative(),
    intentionToTreatDenominator: z.number().int().nonnegative(),
    raw: RawOutcomeCountsSchema,
    initialFixtureLedgerDigest: Sha256DigestSchema,
    finalSnapshotLedgerDigest: Sha256DigestSchema,
    rawOutcomeLedgerDigest: Sha256DigestSchema,
  })
  .strict();

const CompatibilityComponentSchema = z
  .object({
    id: SafeEvaluationIdSchema,
    role: z.enum(['locked-equal', 'treatment', 'stratifier', 'diagnostic']),
    canonicalValue: NonEmptyStringSchema,
    source: NonEmptyStringSchema,
    version: NonEmptyStringSchema,
    digest: Sha256DigestSchema,
  })
  .strict()
  .superRefine((component, context) => {
    const payload = {
      id: component.id,
      role: component.role,
      canonicalValue: component.canonicalValue,
      source: component.source,
      version: component.version,
    };
    if (evaluationDigest(payload) !== component.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Compatibility component digest does not cover its canonical payload.',
      });
    }
  });

const GateStatusSchema = z.enum(['passed', 'failed', 'unknown', 'not-applicable']);
const GateSchema = z
  .object({
    status: GateStatusSchema,
    margin: z.number(),
    plannedPower: z.number().min(0).max(1).optional(),
    achievedPower: z.number().min(0).max(1).optional(),
    adjustedAlpha: z.number().positive().max(0.05).optional(),
    adjustedBound: z.number().optional(),
    observedDelta: z.number().optional(),
    reason: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((gate, context) => {
    if (gate.status === 'not-applicable') return;
    for (const [field, value] of [
      ['plannedPower', gate.plannedPower],
      ['adjustedAlpha', gate.adjustedAlpha],
    ] as const) {
      if (value === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} is required for an applicable guardrail.`,
          path: [field],
        });
      }
    }
  });

const HypothesisSchema = z
  .object({
    id: SafeEvaluationIdSchema,
    statement: NonEmptyStringSchema,
    sliceDigest: Sha256DigestSchema,
  })
  .strict();

const HypothesisResultSchema = z
  .object({
    hypothesisId: SafeEvaluationIdSchema,
    status: z.enum(['passed', 'failed', 'unknown']),
    holmRank: z.number().int().positive(),
    adjustedAlpha: z.number().positive().max(0.05),
    adjustedIntervalLower: z.number().min(-1).max(1),
    adjustedIntervalUpper: z.number().min(-1).max(1),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.adjustedIntervalLower > result.adjustedIntervalUpper) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Hypothesis interval lower bound exceeds its upper bound.',
      });
    }
  });

const AttestationReferenceSchema = z
  .object({
    subjectDigest: Sha256DigestSchema,
    statementDigest: Sha256DigestSchema,
    signerId: SafeEvaluationIdSchema,
    verified: z.boolean(),
  })
  .strict();

const ConfirmationIdentitySchema = z
  .object({
    evaluatorReleaseDigest: Sha256DigestSchema,
    evaluatorProvenanceDigest: Sha256DigestSchema,
    analysisDigest: Sha256DigestSchema,
    reportSchemaDigest: Sha256DigestSchema,
    workerRegistrationDigest: Sha256DigestSchema,
    brokerDigest: Sha256DigestSchema,
    verifierReleaseDigests: z.array(Sha256DigestSchema).min(1),
    corpusVersion: NonEmptyStringSchema,
    corpusDigest: Sha256DigestSchema,
    splitVersion: NonEmptyStringSchema,
    splitDigest: Sha256DigestSchema,
    splitRole: z.literal('promotion-sealed'),
    compatibilityCellDigest: Sha256DigestSchema,
  })
  .strict();

export const Phase0ConfirmatoryDesignSchema = z
  .object({
    schemaVersion: z.literal(2),
    designClass: z.literal('confirmatory'),
    preregistrationId: SafeEvaluationIdSchema,
    preregistrationDigest: Sha256DigestSchema,
    lockedAt: z.string().datetime({ offset: true }),
    lockedBeforeTargetOutcomes: z.literal(true),
    targetPopulation: NonEmptyStringSchema,
    exactSlice: z
      .object({
        providerOriginAdapterModel: NonEmptyStringSchema,
        taskClass: z.literal('multi-file'),
        projectRisk: z.literal('medium'),
        outcomeClass: z.literal('machine-verifiable'),
        fixtureAuthority: z.literal('evaluator-owned-data-only'),
        agentClass: z.literal('trusted-built-in-single-agent'),
        network: z.literal('off-provider-broker-only'),
      })
      .strict(),
    identity: ConfirmationIdentitySchema,
    candidate: z
      .object({
        workflowDigest: Sha256DigestSchema,
        adaptiveParameters: z.array(NonEmptyStringSchema),
      })
      .strict(),
    baseline: z
      .object({
        workflowDigest: Sha256DigestSchema,
        strongestEligible: z.literal(true),
        selectionEvidence: z.enum(['held-in', 'nested-validation']),
      })
      .strict(),
    hypotheses: z.array(HypothesisSchema).min(1),
    multiplicityFamilyId: SafeEvaluationIdSchema,
    queryBudget: z.number().int().positive(),
    retryBudget: z.number().int().nonnegative(),
    estimand: z.literal('paired-itt-success-difference-vs-strongest-eligible-fixed-baseline'),
    plannedIndependentFamilies: z.number().int().min(20),
    plannedRepetitionsPerFamily: z.number().int().min(5),
    plannedEnrolledBlocks: z.number().int().positive(),
    plannedPower: z.number().min(0.8).max(1),
    practicalEffect: z.number().min(0.15).max(1),
    metricPolicyDigest: Sha256DigestSchema,
    guardrailPolicyDigest: Sha256DigestSchema,
    budgetPolicyDigest: Sha256DigestSchema,
    familyWiseAlpha: z.literal(0.05),
    multiplicity: z.literal('holm'),
    horizon: z.literal('fixed'),
    stoppingRule: NonEmptyStringSchema,
    randomizationScheduleDigest: Sha256DigestSchema,
    exclusionRulesDigest: Sha256DigestSchema,
    queryLedgerDigest: Sha256DigestSchema,
    thresholdsMayRelaxAfterOutcomes: z.literal(false),
  })
  .strict()
  .superRefine((design, context) => {
    if (design.candidate.workflowDigest === design.baseline.workflowDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Candidate and baseline workflow digests must differ.',
      });
    }
    const hypothesisIds = design.hypotheses.map((hypothesis) => hypothesis.id);
    if (new Set(hypothesisIds).size !== hypothesisIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Hypothesis IDs must differ.' });
    }
    if (design.queryBudget < design.hypotheses.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The query budget cannot be smaller than the preregistered hypothesis family.',
      });
    }
    if (
      design.plannedEnrolledBlocks <
      design.plannedIndependentFamilies * design.plannedRepetitionsPerFamily
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Planned blocks do not cover every planned family repetition.',
      });
    }
    if (
      new Set(design.candidate.adaptiveParameters).size !==
      design.candidate.adaptiveParameters.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Adaptive parameter IDs must differ.',
      });
    }
    if (
      new Set(design.identity.verifierReleaseDigests).size !==
      design.identity.verifierReleaseDigests.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Verifier release digests must differ.',
      });
    }
  });

export const Phase0CalibrationReportSchema = z
  .object({
    schemaVersion: z.literal(2),
    designClass: z.literal('calibration'),
    claimAuthority: z.literal('none'),
    corpusVersion: z.literal('calibration-public-v1'),
    corpusDigest: Sha256DigestSchema,
    splitRole: z.literal('calibration-public'),
    evaluatorVersion: NonEmptyStringSchema,
    evaluatorReleaseStatus: z.literal('unpackaged-calibration-source'),
    generatedAt: z.string().datetime({ offset: true }),
    attemptsPerArm: z.literal(3),
    repeatedControlRuns: z.literal(5),
    attempts: z.array(z.unknown()).min(1),
    noiseSummary: z
      .object({
        sampleCount: z.number().int().nonnegative(),
        successRate: z.number().min(0).max(1),
        unknownRate: z.number().min(0).max(1),
        setupFailureRate: z.number().min(0).max(1),
      })
      .strict(),
    disposition: z.literal('calibration-only'),
    limitations: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();

const Phase0ConfirmatoryReportBaseSchema = z
  .object({
    schemaVersion: z.literal(2),
    designClass: z.literal('confirmatory'),
    claimAuthority: z.literal('promotion-eligible'),
    generatedAt: z.string().datetime({ offset: true }),
    design: Phase0ConfirmatoryDesignSchema,
    campaign: z
      .object({
        enrolledBlocks: z.number().int().nonnegative(),
        completedBlocks: z.number().int().nonnegative(),
        validBlocks: z.number().int().nonnegative(),
        invalidBlocks: z.number().int().nonnegative(),
        retriedBlocks: z.number().int().nonnegative(),
        independentHeldOutFamilies: z.number().int().nonnegative(),
        minimumCompleteRepetitionsPerFamily: z.number().int().nonnegative(),
        blockLedger: z
          .object({
            digest: Sha256DigestSchema,
            recordCount: z.number().int().nonnegative(),
            immutableReference: NonEmptyStringSchema,
            invalidBlocks: z.array(
              z
                .object({
                  blockId: SafeEvaluationIdSchema,
                  reason: NonEmptyStringSchema,
                  retainedOutcomeDigest: Sha256DigestSchema,
                })
                .strict(),
            ),
            retries: z.array(
              z
                .object({
                  blockId: SafeEvaluationIdSchema,
                  replacesBlockId: SafeEvaluationIdSchema,
                  retainedOutcomeDigest: Sha256DigestSchema,
                })
                .strict(),
            ),
          })
          .strict(),
      })
      .strict(),
    outcomesByArm: z.array(ArmOutcomeSchema).length(2),
    infrastructure: z
      .object({
        preRandomizationSetupFailures: z.number().int().nonnegative(),
        replacementBlocks: z.number().int().nonnegative(),
        quarantinedWorkspaces: z.number().int().nonnegative(),
        cleanupFailures: z.number().int().nonnegative(),
        ledgerDigest: Sha256DigestSchema,
        immutableReference: NonEmptyStringSchema,
      })
      .strict(),
    aaEvidence: z
      .object({
        splitRole: z.literal('design-held-in'),
        matchedBlocks: z.number().int().nonnegative(),
        pairedSuccessDisagreementRate: z.number().min(0).max(1),
        setupFailureRate: z.number().min(0).max(1),
        unknownRate: z.number().min(0).max(1),
        evaluatorFailureRate: z.number().min(0).max(1),
        upperSuccessNoiseBound: z.number().min(0).max(1),
        latencyCoefficientOfVariation: z.number().nonnegative(),
        intraFamilyCorrelation: z.number().min(-1).max(1),
        orderEffectStatus: z.enum(['passed', 'failed', 'unknown']),
        estimateDigest: Sha256DigestSchema,
      })
      .strict(),
    inference: z
      .object({
        plannedPower: z.number().min(0).max(1),
        achievedPower: z.number().min(0).max(1),
        holmAdjustedAlpha: z.number().positive().max(0.05),
        familyWiseAlpha: z.literal(0.05),
        holmApplied: z.boolean(),
        pointEstimate: z.number().min(-1).max(1),
        decisionEffect: z.number().min(0.15).max(1),
        adjustedIntervalLower: z.number().min(-1).max(1),
        adjustedIntervalUpper: z.number().min(-1).max(1),
        primaryIntervalExcludesZero: z.boolean(),
        effectMeetsDecisionEffect: z.boolean(),
        worstCaseMissingnessSensitivityPassed: z.boolean(),
        pairedDiscordanceRate: z.number().min(0).max(1),
        intraFamilyCorrelation: z.number().min(-1).max(1),
        designEffect: z.number().nonnegative(),
        equalCaseWeighting: z.boolean(),
        clusteredPairedAnalysis: z.boolean(),
      })
      .strict()
      .superRefine((inference, context) => {
        if (inference.adjustedIntervalLower > inference.adjustedIntervalUpper) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Primary interval lower bound exceeds its upper bound.',
          });
        }
        if (
          inference.pointEstimate < inference.adjustedIntervalLower ||
          inference.pointEstimate > inference.adjustedIntervalUpper
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Primary point estimate must lie within its adjusted interval.',
          });
        }
      }),
    multiplicity: z
      .object({
        familyId: SafeEvaluationIdSchema,
        method: z.literal('holm'),
        familyWiseAlpha: z.literal(0.05),
        alphaSpent: z.number().min(0).max(0.05),
        queryLedgerDigest: Sha256DigestSchema,
        queryCount: z.number().int().nonnegative(),
        queryBudget: z.number().int().positive(),
        allProposedSlicesReported: z.boolean(),
        droppedHypothesisIds: z.array(SafeEvaluationIdSchema),
        results: z.array(HypothesisResultSchema).min(1),
      })
      .strict(),
    guardrails: z
      .object({
        protectedSuccess: GateSchema,
        unknownRate: GateSchema,
        timeoutRate: GateSchema,
        evaluatorOrMissingRate: GateSchema,
        meanCost: GateSchema,
        totalTokens: GateSchema,
        medianLatency: GateSchema,
        p95Latency: GateSchema,
        humanRubric: GateSchema,
      })
      .strict(),
    executionDiagnostics: z
      .object({
        randomizationScheduleDigest: Sha256DigestSchema,
        freshEnvironmentPerArm: z.boolean(),
        freshFixtureMaterialization: z.boolean(),
        freshBookHome: z.boolean(),
        freshToolDiscoveryState: z.boolean(),
        freshProcessState: z.boolean(),
        balancedOrder: z.boolean(),
        interleavedOverTime: z.boolean(),
        boundedPairWindow: z.boolean(),
        wholeBlockRetriesOnly: z.boolean(),
        originalOutcomesRetained: z.boolean(),
        accountRegionLocked: z.boolean(),
        symmetricConcurrency: z.boolean(),
        cachePolicyBalanced: z.boolean(),
        rateLimitPolicyBalanced: z.boolean(),
        providerCacheStateRecorded: z.boolean(),
        pairWindowMaximumMs: z.number().int().positive(),
        interleavedBlocks: z.number().int().nonnegative(),
        orderEffectStatus: z.enum(['passed', 'failed', 'unknown']),
        orderEffectEstimate: z.number(),
        armDiagnostics: z
          .array(
            z
              .object({
                armId: SafeEvaluationIdSchema,
                providerCacheHits: z.number().int().nonnegative(),
                providerCacheMisses: z.number().int().nonnegative(),
                throttledRequests: z.number().int().nonnegative(),
                providerRetries: z.number().int().nonnegative(),
                retryAfterMsTotal: z.number().int().nonnegative(),
                rateLimitFailures: z.number().int().nonnegative(),
                meanConcurrency: z.number().nonnegative(),
                maxConcurrency: z.number().int().positive(),
                outputTruncations: z.number().int().nonnegative(),
              })
              .strict(),
          )
          .length(2),
        cacheDiagnosticsDigest: Sha256DigestSchema,
        rateLimitDiagnosticsDigest: Sha256DigestSchema,
        retryLedgerDigest: Sha256DigestSchema,
        concurrencyDiagnosticsDigest: Sha256DigestSchema,
      })
      .strict(),
    compatibility: z
      .object({
        valid: z.boolean(),
        cellDigest: Sha256DigestSchema,
        components: z.array(CompatibilityComponentSchema).min(1),
        undeclaredDifferences: z.array(NonEmptyStringSchema),
      })
      .strict(),
    integrity: z
      .object({
        preregistrationLocked: z.boolean(),
        sealedSplit: z.boolean(),
        queryLedgerValid: z.boolean(),
        sampleRatioValid: z.boolean(),
        leakageCheckPassed: z.boolean(),
        evaluatorAttestationVerified: z.boolean(),
        workerBrokerIsolationVerified: z.boolean(),
        machineVerifiersPassed: z.boolean(),
        humanRubricStatus: z.enum(['passed', 'failed', 'unknown', 'not-applicable']),
        cleanupPassed: z.boolean(),
        zeroToleranceViolationCount: z.number().int().nonnegative(),
      })
      .strict(),
    attestations: z
      .object({
        evaluator: AttestationReferenceSchema,
        workerHost: AttestationReferenceSchema,
        broker: AttestationReferenceSchema,
        finalSnapshot: z
          .object({
            subjectDigest: Sha256DigestSchema,
            statementDigest: Sha256DigestSchema,
            signerId: SafeEvaluationIdSchema,
            verified: z.boolean(),
            readOnly: z.boolean(),
            workerStopped: z.boolean(),
            descendantsStopped: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    approval: z
      .object({
        ownerId: SafeEvaluationIdSchema,
        approverId: SafeEvaluationIdSchema,
        independentApprover: z.boolean(),
        approvedAt: z.string().datetime({ offset: true }),
        approvalDigest: Sha256DigestSchema,
      })
      .strict(),
    limitations: z.array(NonEmptyStringSchema),
    unsupportedSlices: z.array(NonEmptyStringSchema),
    evidenceStartedAt: z.string().datetime({ offset: true }),
    evidenceCompletedAt: z.string().datetime({ offset: true }),
    evidenceExpiresAt: z.string().datetime({ offset: true }),
    revalidationTriggers: z.array(NonEmptyStringSchema).min(1),
    rollbackTargetDigest: Sha256DigestSchema,
    disposition: z.enum(['promote', 'reject', 'insufficient-evidence']),
    dispositionReasons: z.array(NonEmptyStringSchema),
  })
  .strict()
  .superRefine((report, context) => {
    const armIds = report.outcomesByArm.map((arm) => arm.armId);
    if (new Set(armIds).size !== armIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Outcome arm IDs must differ.' });
    }
    const armRoles = report.outcomesByArm.map((arm) => arm.role);
    if (new Set(armRoles).size !== 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one baseline arm and one candidate arm are required.',
      });
    }
    for (const arm of report.outcomesByArm) {
      const rawTotal = Object.values(arm.raw).reduce((total, count) => total + count, 0);
      if (rawTotal !== arm.assigned) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Raw outcome counts do not equal assigned trials for ${arm.armId}.`,
        });
      }
      if (arm.assigned !== report.campaign.enrolledBlocks) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Assigned trials do not equal enrolled blocks for ${arm.armId}.`,
        });
      }
      if (arm.intentionToTreatDenominator !== report.campaign.validBlocks) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `The intention-to-treat denominator does not equal valid blocks for ${arm.armId}.`,
        });
      }
      const invalidRawOutcomes =
        arm.raw.comparisonIdentityFailure +
        arm.raw.evaluatorIntegrityFailure +
        arm.raw.cleanupFailure;
      if (invalidRawOutcomes !== report.campaign.invalidBlocks) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid raw outcomes do not equal invalid blocks for ${arm.armId}.`,
        });
      }
    }
    if (
      report.campaign.completedBlocks !==
      report.campaign.validBlocks + report.campaign.invalidBlocks
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Completed blocks must equal valid plus invalid blocks.',
      });
    }
    if (report.campaign.completedBlocks > report.campaign.enrolledBlocks) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Completed blocks cannot exceed enrolled blocks.',
      });
    }
    if (report.campaign.blockLedger.recordCount !== report.campaign.completedBlocks * 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The block ledger must contain one record per completed block and arm.',
      });
    }
    if (report.campaign.blockLedger.invalidBlocks.length !== report.campaign.invalidBlocks) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid block records do not match the invalid-block count.',
      });
    }
    if (report.campaign.blockLedger.retries.length !== report.campaign.retriedBlocks) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Retry records do not match the retried-block count.',
      });
    }
    if (report.campaign.retriedBlocks > report.design.retryBudget) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The campaign exceeded its preregistered whole-block retry budget.',
      });
    }
    const invalidBlockIds = report.campaign.blockLedger.invalidBlocks.map((block) => block.blockId);
    const retryBlockIds = report.campaign.blockLedger.retries.map((block) => block.blockId);
    if (
      new Set(invalidBlockIds).size !== invalidBlockIds.length ||
      new Set(retryBlockIds).size !== retryBlockIds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid and retry block IDs must be unique within their ledgers.',
      });
    }
    if (
      report.campaign.blockLedger.retries.some(
        (retry) => !invalidBlockIds.includes(retry.replacesBlockId),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Every retry must identify a retained invalid original block.',
      });
    }

    const hypothesisIds = report.design.hypotheses.map((hypothesis) => hypothesis.id).sort();
    const hypothesisResultIds = report.multiplicity.results
      .map((result) => result.hypothesisId)
      .sort();
    if (
      new Set(hypothesisResultIds).size !== hypothesisResultIds.length ||
      hypothesisIds.join('\0') !== hypothesisResultIds.join('\0')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Multiplicity results must cover every preregistered hypothesis exactly once.',
      });
    }
    const holmRanks = report.multiplicity.results
      .map((result) => result.holmRank)
      .sort((a, b) => a - b);
    if (holmRanks.some((rank, index) => rank !== index + 1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Holm ranks must be a complete one-based sequence.',
      });
    }
    if (
      report.multiplicity.familyId !== report.design.multiplicityFamilyId ||
      report.multiplicity.queryLedgerDigest !== report.design.queryLedgerDigest ||
      report.multiplicity.queryBudget !== report.design.queryBudget
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Multiplicity family or query-ledger identity differs from preregistration.',
      });
    }
    const primaryHypothesisResult = report.multiplicity.results.find(
      (result) => result.hypothesisId === report.design.hypotheses[0]?.id,
    );
    if (primaryHypothesisResult?.adjustedAlpha !== report.inference.holmAdjustedAlpha) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Primary inference alpha differs from the Holm family result.',
      });
    }
    if (report.inference.plannedPower !== report.design.plannedPower) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Reported planned power differs from preregistration.',
      });
    }
    const frozenDecisionEffect = Math.max(
      report.design.practicalEffect,
      report.aaEvidence.upperSuccessNoiseBound,
    );
    if (report.inference.decisionEffect !== frozenDecisionEffect) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Decision effect must equal the larger practical effect and A/A noise bound.',
      });
    }
    if (
      report.executionDiagnostics.randomizationScheduleDigest !==
      report.design.randomizationScheduleDigest
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Executed randomization schedule differs from preregistration.',
      });
    }
    const diagnosticArmIds = report.executionDiagnostics.armDiagnostics
      .map((diagnostic) => diagnostic.armId)
      .sort();
    if (diagnosticArmIds.join('\0') !== [...armIds].sort().join('\0')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Execution diagnostics must cover both report arms exactly once.',
      });
    }
    if (report.executionDiagnostics.retryLedgerDigest !== report.campaign.blockLedger.digest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Execution retry diagnostics do not bind the block ledger.',
      });
    }

    const finalSnapshotSubject = evaluationDigest(
      report.outcomesByArm
        .map((arm) => ({
          armId: arm.armId,
          finalSnapshotLedgerDigest: arm.finalSnapshotLedgerDigest,
        }))
        .sort((left, right) => (left.armId < right.armId ? -1 : left.armId > right.armId ? 1 : 0)),
    );
    if (
      report.attestations.evaluator.subjectDigest !==
        report.design.identity.evaluatorReleaseDigest ||
      report.attestations.workerHost.subjectDigest !==
        report.design.identity.workerRegistrationDigest ||
      report.attestations.broker.subjectDigest !== report.design.identity.brokerDigest ||
      report.attestations.finalSnapshot.subjectDigest !== finalSnapshotSubject
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Attestation subjects do not match the preregistered artifacts and snapshot ledgers.',
      });
    }

    const generatedAt = Date.parse(report.generatedAt);
    const startedAt = Date.parse(report.evidenceStartedAt);
    const completedAt = Date.parse(report.evidenceCompletedAt);
    const approvedAt = Date.parse(report.approval.approvedAt);
    const expiresAt = Date.parse(report.evidenceExpiresAt);
    if (!(
      Date.parse(report.design.lockedAt) <= startedAt &&
      startedAt <= completedAt &&
      completedAt <= generatedAt &&
      generatedAt <= approvedAt &&
      approvedAt < expiresAt
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Preregistration, evidence, report, approval, and expiry timestamps are out of order.',
      });
    }
    if (report.approval.ownerId === report.approval.approverId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The independent approver must differ from the evidence owner.',
      });
    }
    const compatibilityIds = report.compatibility.components.map((component) => component.id);
    if (new Set(compatibilityIds).size !== compatibilityIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Compatibility component IDs must differ.',
      });
    }
    if (report.compatibility.cellDigest !== report.design.identity.compatibilityCellDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Compatibility cell digest does not match the preregistration.',
      });
    }
    for (const role of ['locked-equal', 'treatment', 'stratifier', 'diagnostic'] as const) {
      if (!report.compatibility.components.some((component) => component.role === role)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Compatibility manifest is missing the ${role} role.`,
        });
      }
    }
    const lockedComponentIds = new Set(
      report.compatibility.components
        .filter((component) => component.role === 'locked-equal')
        .map((component) => component.id),
    );
    const missingLockedComponents = PHASE_0_REQUIRED_LOCKED_COMPONENT_IDS.filter(
      (id) => !lockedComponentIds.has(id),
    );
    if (missingLockedComponents.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Compatibility manifest is missing locked components: ${missingLockedComponents.join(',')}.`,
      });
    }
    const lockedById = new Map(
      report.compatibility.components
        .filter((component) => component.role === 'locked-equal')
        .map((component) => [component.id, component]),
    );
    const expectedLockedValues: Record<string, string> = {
      analysis: report.design.identity.analysisDigest,
      broker: report.design.identity.brokerDigest,
      budget: report.design.budgetPolicyDigest,
      corpus: report.design.identity.corpusDigest,
      evaluator: report.design.identity.evaluatorReleaseDigest,
      'report-schema': report.design.identity.reportSchemaDigest,
      'resolved-model': report.design.exactSlice.providerOriginAdapterModel,
      split: report.design.identity.splitDigest,
      verifier: canonicalJson([...report.design.identity.verifierReleaseDigests].sort()),
      worker: report.design.identity.workerRegistrationDigest,
    };
    if (
      Object.entries(expectedLockedValues).some(
        ([id, value]) => lockedById.get(id)?.canonicalValue !== value,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Locked compatibility components do not match preregistered identities.',
      });
    }
    const treatmentComponents = report.compatibility.components.filter(
      (component) => component.role === 'treatment',
    );
    const treatmentPayload = {
      adaptiveParameters: [...report.design.candidate.adaptiveParameters].sort(),
      baselineWorkflowDigest: report.design.baseline.workflowDigest,
      candidateWorkflowDigest: report.design.candidate.workflowDigest,
    };
    const treatment = treatmentComponents[0];
    if (
      treatmentComponents.length !== 1 ||
      treatment?.id !== 'workflow-policy-treatment' ||
      treatment.canonicalValue !== canonicalJson(treatmentPayload) ||
      treatment.source !== 'preregistration' ||
      treatment.version !== report.design.preregistrationId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The sole treatment component must be the preregistered workflow/policy change.',
      });
    }
    const lockedIdentity = report.compatibility.components
      .filter((component) => component.role === 'locked-equal')
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    if (evaluationDigest(lockedIdentity) !== report.compatibility.cellDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Compatibility cell digest does not cover the locked-equal components.',
      });
    }
  });

export type Phase0ConfirmatoryReport = z.infer<typeof Phase0ConfirmatoryReportBaseSchema>;

export interface PromotionAssessment {
  disposition: 'promote' | 'reject' | 'insufficient-evidence';
  reasons: string[];
}

/** Derive the only possible Phase 0 disposition; reports cannot self-authorize promotion. */
export function assessPhase0ConfirmatoryPromotion(
  report: Phase0ConfirmatoryReport,
): PromotionAssessment {
  const insufficient: string[] = [];
  const rejected: string[] = [];
  const { aaEvidence, campaign, design, inference, integrity } = report;

  if (
    campaign.independentHeldOutFamilies < PHASE_0_CONFIRMATORY_POLICY.minimumHeldOutFamilies ||
    campaign.independentHeldOutFamilies < design.plannedIndependentFamilies
  ) {
    insufficient.push('held-out-family-floor-not-met');
  }
  if (
    campaign.minimumCompleteRepetitionsPerFamily <
      PHASE_0_CONFIRMATORY_POLICY.minimumRepetitionsPerFamily ||
    campaign.minimumCompleteRepetitionsPerFamily < design.plannedRepetitionsPerFamily
  ) {
    insufficient.push('repetitions-per-family-floor-not-met');
  }
  if (aaEvidence.matchedBlocks < PHASE_0_CONFIRMATORY_POLICY.minimumMatchedAaBlocks) {
    insufficient.push('matched-aa-floor-not-met');
  }
  if (aaEvidence.orderEffectStatus === 'unknown') insufficient.push('aa-order-effect-unknown');
  else if (aaEvidence.orderEffectStatus === 'failed') rejected.push('aa-order-effect-detected');
  if (
    inference.plannedPower < PHASE_0_CONFIRMATORY_POLICY.minimumPower ||
    inference.achievedPower < PHASE_0_CONFIRMATORY_POLICY.minimumPower ||
    design.plannedPower < PHASE_0_CONFIRMATORY_POLICY.minimumPower
  ) {
    insufficient.push('power-below-frozen-minimum');
  }
  if (
    campaign.enrolledBlocks < design.plannedEnrolledBlocks ||
    campaign.completedBlocks !== campaign.enrolledBlocks ||
    campaign.validBlocks < design.plannedEnrolledBlocks
  ) {
    insufficient.push('fixed-horizon-enrollment-incomplete');
  }
  if (
    campaign.validBlocks <
    campaign.independentHeldOutFamilies * campaign.minimumCompleteRepetitionsPerFamily
  ) {
    insufficient.push('family-repetition-matrix-incomplete');
  }
  if (
    report.infrastructure.replacementBlocks < report.infrastructure.preRandomizationSetupFailures
  ) {
    insufficient.push('pre-randomization-setup-replacement-incomplete');
  }
  if (report.infrastructure.cleanupFailures > 0) {
    insufficient.push('infrastructure-cleanup-failure-visible');
  }
  if (!inference.holmApplied || inference.familyWiseAlpha !== 0.05) {
    insufficient.push('holm-family-wise-control-missing');
  }
  if (
    report.multiplicity.queryCount > report.multiplicity.queryBudget ||
    report.multiplicity.alphaSpent > PHASE_0_CONFIRMATORY_POLICY.familyWiseAlpha ||
    !report.multiplicity.allProposedSlicesReported ||
    report.multiplicity.droppedHypothesisIds.length > 0
  ) {
    rejected.push('multiplicity-or-query-ledger-invalid');
  }
  if (report.multiplicity.results.some((result) => result.status === 'failed')) {
    rejected.push('sibling-hypothesis-failed');
  }
  if (report.multiplicity.results.some((result) => result.status === 'unknown')) {
    insufficient.push('sibling-hypothesis-unknown');
  }
  if (!inference.worstCaseMissingnessSensitivityPassed) {
    insufficient.push('worst-case-missingness-sensitivity-failed');
  }
  if (!inference.equalCaseWeighting || !inference.clusteredPairedAnalysis) {
    rejected.push('paired-cluster-analysis-contract-violated');
  }

  if (!inference.primaryIntervalExcludesZero || inference.adjustedIntervalLower <= 0) {
    rejected.push('primary-superiority-not-established');
  }
  if (
    !inference.effectMeetsDecisionEffect ||
    inference.pointEstimate < inference.decisionEffect ||
    inference.decisionEffect < PHASE_0_CONFIRMATORY_POLICY.machineSuccessPracticalEffect ||
    inference.decisionEffect < aaEvidence.upperSuccessNoiseBound
  ) {
    rejected.push('practical-effect-not-met');
  }
  for (const [name, gate] of Object.entries(report.guardrails)) {
    const expectedMargins: Record<string, number> = {
      protectedSuccess: PHASE_0_CONFIRMATORY_POLICY.protectedSuccessMargin,
      unknownRate: PHASE_0_CONFIRMATORY_POLICY.unknownRateMargin,
      timeoutRate: PHASE_0_CONFIRMATORY_POLICY.timeoutRateMargin,
      evaluatorOrMissingRate: PHASE_0_CONFIRMATORY_POLICY.evaluatorOrMissingRateMargin,
      meanCost: PHASE_0_CONFIRMATORY_POLICY.resourceIncreaseMargin,
      totalTokens: PHASE_0_CONFIRMATORY_POLICY.resourceIncreaseMargin,
      medianLatency: PHASE_0_CONFIRMATORY_POLICY.resourceIncreaseMargin,
      p95Latency: PHASE_0_CONFIRMATORY_POLICY.resourceIncreaseMargin,
      humanRubric: PHASE_0_CONFIRMATORY_POLICY.rubricMargin,
    };
    const expectedMargin = expectedMargins[name];
    if (gate.margin !== expectedMargin) rejected.push(`guardrail-margin-changed:${name}`);
    if (gate.status === 'not-applicable') {
      if (name !== 'humanRubric') rejected.push(`required-guardrail-not-applicable:${name}`);
      continue;
    }
    if (
      gate.plannedPower === undefined ||
      gate.achievedPower === undefined ||
      gate.plannedPower < PHASE_0_CONFIRMATORY_POLICY.minimumPower ||
      gate.achievedPower < PHASE_0_CONFIRMATORY_POLICY.minimumPower
    ) {
      insufficient.push(`guardrail-power-insufficient:${name}`);
    }
    if (gate.adjustedAlpha === undefined) {
      insufficient.push(`guardrail-alpha-missing:${name}`);
    }
    if (gate.observedDelta === undefined) {
      insufficient.push(`guardrail-observed-delta-missing:${name}`);
    }
    if (gate.status === 'failed') rejected.push(`guardrail-failed:${name}`);
    if (gate.adjustedBound === undefined) {
      insufficient.push(`guardrail-bound-missing:${name}`);
      continue;
    }
    const lowerBoundGuardrail = name === 'protectedSuccess' || name === 'humanRubric';
    const withinMargin = lowerBoundGuardrail
      ? gate.adjustedBound >= expectedMargin
      : gate.adjustedBound <= expectedMargin;
    if (gate.status === 'passed' && !withinMargin) {
      rejected.push(`guardrail-failed:${name}`);
    } else if (gate.status === 'unknown') insufficient.push(`guardrail-unknown:${name}`);
  }
  if (!report.compatibility.valid || report.compatibility.undeclaredDifferences.length > 0) {
    rejected.push('compatibility-identity-invalid');
  }
  if (!integrity.preregistrationLocked || !integrity.sealedSplit || !integrity.queryLedgerValid) {
    rejected.push('sealed-evidence-integrity-invalid');
  }
  if (!integrity.sampleRatioValid) rejected.push('sample-ratio-invalid');
  if (!integrity.leakageCheckPassed) rejected.push('corpus-leakage-detected');
  if (!integrity.evaluatorAttestationVerified || !integrity.workerBrokerIsolationVerified) {
    insufficient.push('evaluator-worker-broker-attestation-unavailable');
  }
  if (!integrity.machineVerifiersPassed) rejected.push('machine-verifier-gate-failed');
  if (integrity.humanRubricStatus === 'failed') rejected.push('human-rubric-gate-failed');
  if (integrity.humanRubricStatus === 'unknown') insufficient.push('human-rubric-unknown');
  if (!integrity.cleanupPassed) insufficient.push('cleanup-failure-visible');
  if (integrity.zeroToleranceViolationCount > 0) {
    rejected.push('zero-tolerance-security-integrity-violation');
  }
  if (
    (report.guardrails.humanRubric.status === 'not-applicable') !==
    (integrity.humanRubricStatus === 'not-applicable')
  ) {
    rejected.push('human-rubric-applicability-mismatch');
  }
  const executionControls = [
    report.executionDiagnostics.freshEnvironmentPerArm,
    report.executionDiagnostics.freshFixtureMaterialization,
    report.executionDiagnostics.freshBookHome,
    report.executionDiagnostics.freshToolDiscoveryState,
    report.executionDiagnostics.freshProcessState,
    report.executionDiagnostics.balancedOrder,
    report.executionDiagnostics.interleavedOverTime,
    report.executionDiagnostics.boundedPairWindow,
    report.executionDiagnostics.wholeBlockRetriesOnly,
    report.executionDiagnostics.originalOutcomesRetained,
    report.executionDiagnostics.accountRegionLocked,
    report.executionDiagnostics.symmetricConcurrency,
    report.executionDiagnostics.cachePolicyBalanced,
    report.executionDiagnostics.rateLimitPolicyBalanced,
    report.executionDiagnostics.providerCacheStateRecorded,
  ];
  if (executionControls.some((control) => !control)) {
    rejected.push('execution-control-contract-violated');
  }
  if (report.executionDiagnostics.interleavedBlocks < campaign.completedBlocks) {
    rejected.push('clock-time-interleaving-incomplete');
  }
  if (report.executionDiagnostics.orderEffectStatus === 'failed') {
    rejected.push('material-order-effect-detected');
  } else if (report.executionDiagnostics.orderEffectStatus === 'unknown') {
    insufficient.push('order-effect-check-unknown');
  }
  const attestations = [
    report.attestations.evaluator,
    report.attestations.workerHost,
    report.attestations.broker,
    report.attestations.finalSnapshot,
  ];
  if (
    attestations.some((attestation) => !attestation.verified) ||
    !report.attestations.finalSnapshot.readOnly ||
    !report.attestations.finalSnapshot.workerStopped ||
    !report.attestations.finalSnapshot.descendantsStopped
  ) {
    insufficient.push('authenticated-attestation-or-final-snapshot-unavailable');
  }
  if (!report.approval.independentApprover) {
    insufficient.push('independent-approval-unavailable');
  }

  const reasons = [...new Set([...rejected, ...insufficient])].sort();
  return {
    disposition:
      rejected.length > 0
        ? 'reject'
        : insufficient.length > 0
          ? 'insufficient-evidence'
          : 'promote',
    reasons,
  };
}

export const Phase0ConfirmatoryReportSchema = Phase0ConfirmatoryReportBaseSchema.superRefine(
  (report, context) => {
    const assessment = assessPhase0ConfirmatoryPromotion(report);
    if (report.disposition !== assessment.disposition) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Disposition must be derived as ${assessment.disposition}.`,
        path: ['disposition'],
      });
    }
    const declaredReasons = [...new Set(report.dispositionReasons)].sort();
    if (declaredReasons.join('\0') !== assessment.reasons.join('\0')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Disposition reasons must exactly match the fail-closed assessment.',
        path: ['dispositionReasons'],
      });
    }
  },
);

export const Phase0EvaluationReportSchema = z.union([
  Phase0CalibrationReportSchema,
  Phase0ConfirmatoryReportSchema,
]);

export type Phase0CalibrationReport = z.infer<typeof Phase0CalibrationReportSchema>;
export type Phase0EvaluationReport = z.infer<typeof Phase0EvaluationReportSchema>;
