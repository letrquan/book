import { describe, expect, it } from 'vitest';
import { canonicalJson, evaluationDigest } from './identity.js';
import {
  PHASE_0_REQUIRED_LOCKED_COMPONENT_IDS,
  Phase0CalibrationReportSchema,
  Phase0ConfirmatoryReportSchema,
  Phase0EvaluationReportSchema,
  assessPhase0ConfirmatoryPromotion,
  classifyIntentionToTreatOutcome,
  type Phase0ConfirmatoryReport,
} from './report.js';

const a = `sha256:${'a'.repeat(64)}`;
const b = `sha256:${'b'.repeat(64)}`;

function compatibilityComponent(input: {
  id: string;
  role: 'locked-equal' | 'treatment' | 'stratifier' | 'diagnostic';
  canonicalValue: string;
  source: string;
  version: string;
}) {
  return { ...input, digest: evaluationDigest(input) };
}

function rawOutcomes(success: number, assigned = 100) {
  return {
    success,
    taskFailure: assigned - success,
    budgetExhaustion: 0,
    agentRuntimeFailure: 0,
    timeout: 0,
    requiredArtifactMissing: 0,
    executionCancelled: 0,
    userCancelled: 0,
    unknown: 0,
    missingOutcome: 0,
    evaluatorFailure: 0,
    setupFailure: 0,
    comparisonIdentityFailure: 0,
    evaluatorIntegrityFailure: 0,
    cleanupFailure: 0,
  };
}

function passedGate(margin: number, adjustedBound: number) {
  return {
    status: 'passed' as const,
    margin,
    plannedPower: 0.8,
    achievedPower: 0.82,
    adjustedAlpha: 0.025,
    adjustedBound,
    observedDelta: adjustedBound,
    reason: 'inside margin',
  };
}

function readyReport(): Phase0ConfirmatoryReport {
  const lockedCanonicalValues: Record<string, string> = {
    analysis: a,
    broker: a,
    budget: a,
    corpus: a,
    evaluator: a,
    'report-schema': a,
    'resolved-model': 'provider/adapter/model',
    split: a,
    verifier: canonicalJson([a]),
    worker: a,
  };
  const lockedComponents = PHASE_0_REQUIRED_LOCKED_COMPONENT_IDS.map((id) =>
    compatibilityComponent({
      id,
      role: 'locked-equal',
      canonicalValue: lockedCanonicalValues[id] ?? `locked:${id}`,
      source: 'preregistration',
      version: 'phase0-trial-v1',
    }),
  );
  const compatibilityCellDigest = evaluationDigest(
    [...lockedComponents].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
  );
  const outcomesByArm = [
    {
      armId: 'a-base',
      role: 'baseline' as const,
      assigned: 100,
      intentionToTreatDenominator: 100,
      raw: rawOutcomes(70),
      initialFixtureLedgerDigest: a,
      finalSnapshotLedgerDigest: a,
      rawOutcomeLedgerDigest: a,
    },
    {
      armId: 'b-candidate',
      role: 'candidate' as const,
      assigned: 100,
      intentionToTreatDenominator: 100,
      raw: rawOutcomes(90),
      initialFixtureLedgerDigest: a,
      finalSnapshotLedgerDigest: b,
      rawOutcomeLedgerDigest: b,
    },
  ];
  const finalSnapshotSubject = evaluationDigest(
    outcomesByArm.map(({ armId, finalSnapshotLedgerDigest }) => ({
      armId,
      finalSnapshotLedgerDigest,
    })),
  );
  const report: Phase0ConfirmatoryReport = {
    schemaVersion: 2,
    designClass: 'confirmatory',
    claimAuthority: 'promotion-eligible',
    generatedAt: '2026-08-11T00:00:00Z',
    design: {
      schemaVersion: 2,
      designClass: 'confirmatory',
      preregistrationId: 'phase0-trial-v1',
      preregistrationDigest: a,
      lockedAt: '2026-08-01T00:00:00Z',
      lockedBeforeTargetOutcomes: true,
      targetPopulation: 'exact first Phase 0 slice',
      exactSlice: {
        providerOriginAdapterModel: 'provider/adapter/model',
        taskClass: 'multi-file',
        projectRisk: 'medium',
        outcomeClass: 'machine-verifiable',
        fixtureAuthority: 'evaluator-owned-data-only',
        agentClass: 'trusted-built-in-single-agent',
        network: 'off-provider-broker-only',
      },
      identity: {
        evaluatorReleaseDigest: a,
        evaluatorProvenanceDigest: a,
        analysisDigest: a,
        reportSchemaDigest: a,
        workerRegistrationDigest: a,
        brokerDigest: a,
        verifierReleaseDigests: [a],
        corpusVersion: 'phase0-confirmatory-v1',
        corpusDigest: a,
        splitVersion: 'sealed-v1',
        splitDigest: a,
        splitRole: 'promotion-sealed',
        compatibilityCellDigest,
      },
      candidate: { workflowDigest: a, adaptiveParameters: ['policy-one'] },
      baseline: {
        workflowDigest: b,
        strongestEligible: true,
        selectionEvidence: 'held-in',
      },
      hypotheses: [
        {
          id: 'primary-machine-success',
          statement: 'candidate improves paired externally verified success',
          sliceDigest: a,
        },
      ],
      multiplicityFamilyId: 'phase0-primary-family-v1',
      queryBudget: 1,
      retryBudget: 10,
      estimand: 'paired-itt-success-difference-vs-strongest-eligible-fixed-baseline',
      plannedIndependentFamilies: 20,
      plannedRepetitionsPerFamily: 5,
      plannedEnrolledBlocks: 100,
      plannedPower: 0.8,
      practicalEffect: 0.15,
      metricPolicyDigest: a,
      guardrailPolicyDigest: a,
      budgetPolicyDigest: a,
      familyWiseAlpha: 0.05,
      multiplicity: 'holm',
      horizon: 'fixed',
      stoppingRule: 'open only after all scheduled blocks complete',
      randomizationScheduleDigest: a,
      exclusionRulesDigest: a,
      queryLedgerDigest: a,
      thresholdsMayRelaxAfterOutcomes: false,
    },
    campaign: {
      enrolledBlocks: 100,
      completedBlocks: 100,
      validBlocks: 100,
      invalidBlocks: 0,
      retriedBlocks: 0,
      independentHeldOutFamilies: 20,
      minimumCompleteRepetitionsPerFamily: 5,
      blockLedger: {
        digest: a,
        recordCount: 200,
        immutableReference: 'evidence/block-ledger-v1.jsonl',
        invalidBlocks: [],
        retries: [],
      },
    },
    outcomesByArm,
    infrastructure: {
      preRandomizationSetupFailures: 0,
      replacementBlocks: 0,
      quarantinedWorkspaces: 0,
      cleanupFailures: 0,
      ledgerDigest: a,
      immutableReference: 'evidence/infrastructure-ledger-v1.jsonl',
    },
    aaEvidence: {
      splitRole: 'design-held-in',
      matchedBlocks: 20,
      pairedSuccessDisagreementRate: 0.1,
      setupFailureRate: 0,
      unknownRate: 0,
      evaluatorFailureRate: 0,
      upperSuccessNoiseBound: 0.1,
      latencyCoefficientOfVariation: 0.1,
      intraFamilyCorrelation: 0.1,
      orderEffectStatus: 'passed',
      estimateDigest: a,
    },
    inference: {
      plannedPower: 0.8,
      achievedPower: 0.82,
      holmAdjustedAlpha: 0.025,
      familyWiseAlpha: 0.05,
      holmApplied: true,
      pointEstimate: 0.2,
      decisionEffect: 0.15,
      adjustedIntervalLower: 0.16,
      adjustedIntervalUpper: 0.24,
      primaryIntervalExcludesZero: true,
      effectMeetsDecisionEffect: true,
      worstCaseMissingnessSensitivityPassed: true,
      pairedDiscordanceRate: 0.2,
      intraFamilyCorrelation: 0.1,
      designEffect: 1.4,
      equalCaseWeighting: true,
      clusteredPairedAnalysis: true,
    },
    multiplicity: {
      familyId: 'phase0-primary-family-v1',
      method: 'holm',
      familyWiseAlpha: 0.05,
      alphaSpent: 0.025,
      queryLedgerDigest: a,
      queryCount: 1,
      queryBudget: 1,
      allProposedSlicesReported: true,
      droppedHypothesisIds: [],
      results: [
        {
          hypothesisId: 'primary-machine-success',
          status: 'passed',
          holmRank: 1,
          adjustedAlpha: 0.025,
          adjustedIntervalLower: 0.16,
          adjustedIntervalUpper: 0.24,
        },
      ],
    },
    guardrails: {
      protectedSuccess: passedGate(-0.05, -0.02),
      unknownRate: passedGate(0.02, 0.01),
      timeoutRate: passedGate(0.02, 0),
      evaluatorOrMissingRate: passedGate(0.02, 0),
      meanCost: passedGate(0.25, 0.1),
      totalTokens: passedGate(0.25, 0.1),
      medianLatency: passedGate(0.25, 0.1),
      p95Latency: passedGate(0.25, 0.2),
      humanRubric: {
        status: 'not-applicable',
        margin: -0.25,
        reason: 'machine-only slice',
      },
    },
    executionDiagnostics: {
      randomizationScheduleDigest: a,
      freshEnvironmentPerArm: true,
      freshFixtureMaterialization: true,
      freshBookHome: true,
      freshToolDiscoveryState: true,
      freshProcessState: true,
      balancedOrder: true,
      interleavedOverTime: true,
      boundedPairWindow: true,
      wholeBlockRetriesOnly: true,
      originalOutcomesRetained: true,
      accountRegionLocked: true,
      symmetricConcurrency: true,
      cachePolicyBalanced: true,
      rateLimitPolicyBalanced: true,
      providerCacheStateRecorded: true,
      pairWindowMaximumMs: 60_000,
      interleavedBlocks: 100,
      orderEffectStatus: 'passed',
      orderEffectEstimate: 0,
      armDiagnostics: outcomesByArm.map((arm) => ({
        armId: arm.armId,
        providerCacheHits: 0,
        providerCacheMisses: 100,
        throttledRequests: 0,
        providerRetries: 0,
        retryAfterMsTotal: 0,
        rateLimitFailures: 0,
        meanConcurrency: 1,
        maxConcurrency: 1,
        outputTruncations: 0,
      })),
      cacheDiagnosticsDigest: a,
      rateLimitDiagnosticsDigest: a,
      retryLedgerDigest: a,
      concurrencyDiagnosticsDigest: a,
    },
    compatibility: {
      valid: true,
      cellDigest: compatibilityCellDigest,
      components: [
        ...lockedComponents,
        compatibilityComponent({
          id: 'workflow-policy-treatment',
          role: 'treatment',
          canonicalValue: canonicalJson({
            adaptiveParameters: ['policy-one'],
            baselineWorkflowDigest: b,
            candidateWorkflowDigest: a,
          }),
          source: 'preregistration',
          version: 'phase0-trial-v1',
        }),
        compatibilityComponent({
          id: 'case-family',
          role: 'stratifier',
          canonicalValue: 'family-1',
          source: 'split',
          version: 'v1',
        }),
        compatibilityComponent({
          id: 'latency',
          role: 'diagnostic',
          canonicalValue: 'recorded',
          source: 'runner',
          version: 'v1',
        }),
      ],
      undeclaredDifferences: [],
    },
    integrity: {
      preregistrationLocked: true,
      sealedSplit: true,
      queryLedgerValid: true,
      sampleRatioValid: true,
      leakageCheckPassed: true,
      evaluatorAttestationVerified: true,
      workerBrokerIsolationVerified: true,
      machineVerifiersPassed: true,
      humanRubricStatus: 'not-applicable',
      cleanupPassed: true,
      zeroToleranceViolationCount: 0,
    },
    attestations: {
      evaluator: { subjectDigest: a, statementDigest: a, signerId: 'host-a', verified: true },
      workerHost: { subjectDigest: a, statementDigest: a, signerId: 'host-a', verified: true },
      broker: { subjectDigest: a, statementDigest: a, signerId: 'host-a', verified: true },
      finalSnapshot: {
        subjectDigest: finalSnapshotSubject,
        statementDigest: a,
        signerId: 'host-a',
        verified: true,
        readOnly: true,
        workerStopped: true,
        descendantsStopped: true,
      },
    },
    approval: {
      ownerId: 'evidence-owner',
      approverId: 'independent-approver',
      independentApprover: true,
      approvedAt: '2026-08-11T01:00:00Z',
      approvalDigest: a,
    },
    limitations: ['Evidence applies only to the exact compatibility cell.'],
    unsupportedSlices: ['Every other task or risk slice.'],
    evidenceStartedAt: '2026-08-02T00:00:00Z',
    evidenceCompletedAt: '2026-08-10T00:00:00Z',
    evidenceExpiresAt: '2027-08-11T00:00:00Z',
    revalidationTriggers: ['Any locked compatibility component changes.'],
    rollbackTargetDigest: b,
    disposition: 'promote',
    dispositionReasons: [],
  };
  return report;
}

describe('Phase 0 report and outcome contract', () => {
  it('derives promotion only when every frozen confirmatory gate passes', () => {
    const report = readyReport();
    expect(assessPhase0ConfirmatoryPromotion(report)).toEqual({
      disposition: 'promote',
      reasons: [],
    });
    expect(Phase0ConfirmatoryReportSchema.parse(report)).toEqual(report);
  });

  it('returns insufficient evidence below the family floor and rejects zero-tolerance violations', () => {
    const underpowered = readyReport();
    underpowered.campaign.independentHeldOutFamilies = 19;
    const underpoweredAssessment = assessPhase0ConfirmatoryPromotion(underpowered);
    expect(underpoweredAssessment).toEqual({
      disposition: 'insufficient-evidence',
      reasons: ['held-out-family-floor-not-met'],
    });
    underpowered.disposition = underpoweredAssessment.disposition;
    underpowered.dispositionReasons = underpoweredAssessment.reasons;
    expect(Phase0ConfirmatoryReportSchema.safeParse(underpowered).success).toBe(true);

    const unsafe = readyReport();
    unsafe.integrity.zeroToleranceViolationCount = 1;
    const unsafeAssessment = assessPhase0ConfirmatoryPromotion(unsafe);
    expect(unsafeAssessment).toMatchObject({
      disposition: 'reject',
      reasons: ['zero-tolerance-security-integrity-violation'],
    });
  });

  it('rejects caller-declared passing guardrails outside frozen margins', () => {
    const report = readyReport();
    report.guardrails.unknownRate.adjustedBound = 0.03;
    expect(assessPhase0ConfirmatoryPromotion(report)).toMatchObject({
      disposition: 'reject',
      reasons: ['guardrail-failed:unknownRate'],
    });
  });

  it('rejects raw arm counts that do not reconcile to assigned trials', () => {
    const report = readyReport();
    report.outcomesByArm[0].raw.taskFailure -= 1;
    expect(Phase0ConfirmatoryReportSchema.safeParse(report).success).toBe(false);
  });

  it('keeps an incomplete fixed-horizon family matrix at insufficient evidence', () => {
    const report = readyReport();
    report.campaign.completedBlocks = 99;
    report.campaign.validBlocks = 99;
    report.campaign.blockLedger.recordCount = 198;
    for (const arm of report.outcomesByArm) arm.intentionToTreatDenominator = 99;
    const assessment = assessPhase0ConfirmatoryPromotion(report);
    expect(assessment).toEqual({
      disposition: 'insufficient-evidence',
      reasons: ['family-repetition-matrix-incomplete', 'fixed-horizon-enrollment-incomplete'],
    });
    report.disposition = assessment.disposition;
    report.dispositionReasons = assessment.reasons;
    expect(Phase0ConfirmatoryReportSchema.safeParse(report).success).toBe(true);
  });

  it('requires powered guardrails and a complete preregistered hypothesis family', () => {
    const underpowered = readyReport();
    underpowered.guardrails.unknownRate.achievedPower = 0.79;
    expect(assessPhase0ConfirmatoryPromotion(underpowered)).toMatchObject({
      disposition: 'insufficient-evidence',
      reasons: ['guardrail-power-insufficient:unknownRate'],
    });

    const hiddenSibling = readyReport();
    hiddenSibling.multiplicity.allProposedSlicesReported = false;
    hiddenSibling.multiplicity.droppedHypothesisIds = ['hidden-sibling'];
    expect(assessPhase0ConfirmatoryPromotion(hiddenSibling)).toMatchObject({
      disposition: 'reject',
      reasons: ['multiplicity-or-query-ledger-invalid'],
    });
  });

  it('makes a calibration report structurally incapable of promotion', () => {
    const calibration = {
      schemaVersion: 2,
      designClass: 'calibration',
      claimAuthority: 'none',
      corpusVersion: 'calibration-public-v1',
      corpusDigest: a,
      splitRole: 'calibration-public',
      evaluatorVersion: 'phase0-contract-v2',
      evaluatorReleaseStatus: 'unpackaged-calibration-source',
      generatedAt: '2026-08-11T00:00:00Z',
      attemptsPerArm: 3,
      repeatedControlRuns: 5,
      attempts: [{}],
      noiseSummary: { sampleCount: 5, successRate: 1, unknownRate: 0, setupFailureRate: 0 },
      disposition: 'calibration-only',
      limitations: ['No promotion authority.'],
    } as const;
    expect(Phase0CalibrationReportSchema.safeParse(calibration).success).toBe(true);
    expect(
      Phase0EvaluationReportSchema.safeParse({ ...calibration, disposition: 'promote' }).success,
    ).toBe(false);
  });

  it('keeps unknown and evaluator failure in the intention-to-treat denominator', () => {
    expect(
      classifyIntentionToTreatOutcome({
        category: 'unknown',
        assigned: true,
        anyArmStarted: true,
        comparisonIdentityValid: true,
        evaluatorIntegrityValid: true,
      }),
    ).toEqual({
      enrolled: true,
      comparisonValid: true,
      successContribution: 0,
      rawCategory: 'unknown',
      disposition: 'intention-to-treat',
    });
    expect(
      classifyIntentionToTreatOutcome({
        category: 'setup-failure',
        assigned: false,
        anyArmStarted: false,
        comparisonIdentityValid: true,
        evaluatorIntegrityValid: true,
      }),
    ).toMatchObject({ enrolled: false, disposition: 'not-enrolled' });
    expect(
      classifyIntentionToTreatOutcome({
        category: 'success',
        assigned: false,
        anyArmStarted: false,
        comparisonIdentityValid: true,
        evaluatorIntegrityValid: true,
      }),
    ).toMatchObject({
      enrolled: false,
      comparisonValid: false,
      disposition: 'invalid-block',
    });
    expect(
      classifyIntentionToTreatOutcome({
        category: 'evaluator-integrity-failure',
        assigned: true,
        anyArmStarted: true,
        comparisonIdentityValid: true,
        evaluatorIntegrityValid: false,
      }),
    ).toMatchObject({ enrolled: true, comparisonValid: false, disposition: 'invalid-block' });
  });
});
