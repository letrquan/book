import { z } from 'zod';
import { SafeEvaluationIdSchema, Sha256DigestSchema, evaluationDigest } from './identity.js';

const RatingAnchorSchema = z
  .object({
    score: z.number().int().min(0).max(4),
    label: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

const RubricDimensionSchema = z
  .object({
    id: SafeEvaluationIdSchema,
    description: z.string().min(1),
    weight: z.number().positive(),
    anchors: z.array(RatingAnchorSchema).length(5),
  })
  .strict()
  .superRefine((dimension, context) => {
    const scores = [...dimension.anchors.map((anchor) => anchor.score)].sort();
    if (scores.some((score, index) => score !== index)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Every rubric dimension must define exactly the 0-4 anchors.',
      });
    }
  });

export const HumanRubricArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    rubricId: SafeEvaluationIdSchema,
    rubricVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    evaluatorReleaseDigest: Sha256DigestSchema,
    authority: z.enum(['calibration-only', 'confirmatory-eligible', 'observational']),
    eligibleSlice: z
      .object({
        taskClasses: z.array(z.enum(['review', 'research'])).min(1),
        projectRisks: z.array(z.enum(['low', 'medium', 'high'])).min(1),
        outcomeClass: z.literal('human-rubric'),
      })
      .strict(),
    evidenceView: z
      .object({
        allowedArtifacts: z.array(z.string().min(1)).min(1),
        allowedReferences: z.array(z.string().min(1)),
        excludedFields: z
          .array(
            z.enum([
              'arm',
              'workflow',
              'model-provider',
              'transcript',
              'self-report',
              'cost',
              'latency',
              'tool-trace',
              'other-ratings',
            ]),
          )
          .length(9),
        modelEvidenceIndex: z.enum(['forbidden', 'advisory-only']),
      })
      .strict(),
    dimensions: z.array(RubricDimensionSchema).min(1),
    hardFailures: z
      .array(z.object({ id: SafeEvaluationIdSchema, description: z.string().min(1) }).strict())
      .min(1),
    passThreshold: z.number().min(0).max(4),
    missingItemRule: z.literal('unknown'),
    aggregation: z.literal('weighted-dimension-mean'),
    protocol: z
      .object({
        primaryReviewers: z.literal(2),
        adjudicators: z.literal(1),
        blindIndependentReview: z.literal(true),
        minimumCalibrationArtifacts: z.literal(30),
        minimumOrdinalAlpha: z.literal(0.8),
        minimumAlphaLowerBound95: z.literal(0.67),
        minimumAnchorAgreement: z.literal(0.9),
        requiredHardFailureDetection: z.literal(1),
        minimumBlindDuplicateRate: z.literal(0.1),
        maximumDimensionSpread: z.literal(1),
        consensusMeeting: z.literal('forbidden'),
      })
      .strict(),
    privacy: z
      .object({
        pseudonymousReviewerIds: z.literal(true),
        personalTranscripts: z.literal('forbidden'),
        credentials: z.literal('forbidden'),
        privateWorkspaces: z.literal('forbidden'),
        freeTextNotes: z.literal('minimized-redacted'),
      })
      .strict(),
  })
  .strict()
  .superRefine((rubric, context) => {
    const dimensionIds = rubric.dimensions.map((dimension) => dimension.id);
    if (new Set(dimensionIds).size !== dimensionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Rubric dimension IDs must differ.',
      });
    }
    const hardFailureIds = rubric.hardFailures.map((failure) => failure.id);
    if (new Set(hardFailureIds).size !== hardFailureIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Rubric hard-failure IDs must differ.',
      });
    }
    const totalWeight = rubric.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
    if (Math.abs(totalWeight - 1) > 1e-9) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Rubric dimension weights must sum to one.',
      });
    }
    const evidenceReferences = [
      ...rubric.evidenceView.allowedArtifacts,
      ...rubric.evidenceView.allowedReferences,
    ];
    if (new Set(evidenceReferences).size !== evidenceReferences.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Allowed rubric evidence references must differ.',
      });
    }
    if (new Set(rubric.evidenceView.excludedFields).size !== 9) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The blind evidence view must exclude every frozen identity and trace field.',
      });
    }
    if (
      new Set(rubric.eligibleSlice.taskClasses).size !== rubric.eligibleSlice.taskClasses.length ||
      new Set(rubric.eligibleSlice.projectRisks).size !== rubric.eligibleSlice.projectRisks.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Eligible rubric slice entries must differ.',
      });
    }
  });

export const HumanReviewPacketSchema = z
  .object({
    schemaVersion: z.literal(1),
    packetId: SafeEvaluationIdSchema,
    packetDigest: Sha256DigestSchema,
    artifactDigest: Sha256DigestSchema,
    rubricId: SafeEvaluationIdSchema,
    rubricVersion: z.string().min(1),
    rubricDigest: Sha256DigestSchema,
    evidenceDigest: Sha256DigestSchema,
    evidenceReferences: z.array(z.string().min(1)).min(1),
    presentationSeedDigest: Sha256DigestSchema,
    privacyReviewDigest: Sha256DigestSchema,
    armIdentityExcluded: z.literal(true),
    equalEvidenceViewAttested: z.literal(true),
    immutable: z.literal(true),
    modelEvidenceIndex: z
      .object({ digest: Sha256DigestSchema, advisoryOnly: z.literal(true) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((packet, context) => {
    if (new Set(packet.evidenceReferences).size !== packet.evidenceReferences.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Review-packet evidence references must differ.',
      });
    }
  });

const ReliabilitySchema = z
  .object({
    artifactCount: z.number().int().nonnegative(),
    ordinalKrippendorffAlpha: z.number().min(-1).max(1),
    alphaLowerBound95: z.number().min(-1).max(1),
    anchorAgreementRate: z.number().min(0).max(1),
    hardFailureDetectionRate: z.number().min(0).max(1),
    blindDuplicateRate: z.number().min(0).max(1),
  })
  .strict();

export const HumanRubricCalibrationSchema = ReliabilitySchema.extend({
  calibrationVersion: SafeEvaluationIdSchema,
  calibrationSetDigest: Sha256DigestSchema,
  rubricId: SafeEvaluationIdSchema,
  rubricVersion: z.string().min(1),
  rubricDigest: Sha256DigestSchema,
  reviewerPoolVersion: SafeEvaluationIdSchema,
  calibratedReviewerIds: z.array(SafeEvaluationIdSchema).min(2),
  reviewerQualifications: z
    .array(
      z
        .object({
          reviewerId: SafeEvaluationIdSchema,
          qualificationVersion: SafeEvaluationIdSchema,
          domainRole: z.string().min(1),
        })
        .strict(),
    )
    .min(2),
  lockedBeforeScoring: z.literal(true),
  separateFromCandidateAndHoldouts: z.literal(true),
  stratifiedAcrossAnchors: z.literal(true),
  nearThresholdCovered: z.literal(true),
  allHardFailuresCovered: z.literal(true),
  statisticDefined: z.literal(true),
  status: z.enum(['current', 'expired', 'failed']),
  calibratedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
})
  .strict()
  .superRefine((calibration, context) => {
    const calibratedIds = [...calibration.calibratedReviewerIds].sort();
    const qualificationIds = calibration.reviewerQualifications
      .map((reviewer) => reviewer.reviewerId)
      .sort();
    if (
      new Set(calibratedIds).size !== calibratedIds.length ||
      new Set(qualificationIds).size !== qualificationIds.length ||
      calibratedIds.join('\0') !== qualificationIds.join('\0')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Every calibrated reviewer requires exactly one pinned qualification.',
      });
    }
    if (Date.parse(calibration.calibratedAt) >= Date.parse(calibration.expiresAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Calibration expiry must follow its calibration time.',
      });
    }
  });

export const HumanRubricProductionReliabilitySchema = ReliabilitySchema.extend({
  batchId: SafeEvaluationIdSchema,
  rubricDigest: Sha256DigestSchema,
  reviewerPoolVersion: SafeEvaluationIdSchema,
  assignmentCount: z.number().int().positive(),
  assignmentsBalancedAcrossArms: z.literal(true),
  reviewerEffectsRetained: z.literal(true),
  preAdjudicationReliability: z.literal(true),
  status: z.enum(['current', 'failed']),
}).strict();

const DimensionRatingSchema = z
  .object({
    dimensionId: SafeEvaluationIdSchema,
    score: z.number().int().min(0).max(4),
    evidenceReferences: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const HumanRubricReviewRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewId: SafeEvaluationIdSchema,
    packetDigest: Sha256DigestSchema,
    rubricId: SafeEvaluationIdSchema,
    rubricVersion: z.string().min(1),
    rubricDigest: Sha256DigestSchema,
    reviewerId: SafeEvaluationIdSchema,
    reviewerRole: z.enum(['primary', 'adjudicator']),
    qualificationVersion: SafeEvaluationIdSchema,
    calibrationVersion: SafeEvaluationIdSchema,
    assignmentBatch: SafeEvaluationIdSchema,
    adjudicatesReviewIds: z.array(SafeEvaluationIdSchema).length(2).optional(),
    dimensionRatings: z.array(DimensionRatingSchema).min(1),
    hardFailureRatings: z.record(SafeEvaluationIdSchema, z.boolean()),
    submittedAt: z.string().datetime({ offset: true }),
    attestations: z
      .object({
        authenticated: z.literal(true),
        blind: z.literal(true),
        independent: z.literal(true),
        conflictFree: z.literal(true),
        priorRatingsHidden: z.literal(true),
        humanReviewer: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((review, context) => {
    const dimensionIds = review.dimensionRatings.map((rating) => rating.dimensionId);
    if (new Set(dimensionIds).size !== dimensionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Dimension ratings must not repeat a dimension.',
      });
    }
    if (
      review.dimensionRatings.some(
        (rating) => new Set(rating.evidenceReferences).size !== rating.evidenceReferences.length,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Rating evidence references must differ.',
      });
    }
    if (review.reviewerRole === 'primary' && review.adjudicatesReviewIds !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A primary review cannot declare adjudication linkage.',
      });
    }
    if (review.reviewerRole === 'adjudicator' && review.adjudicatesReviewIds === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An adjudicator must identify the two primary reviews being adjudicated.',
      });
    }
  });

export type HumanRubricArtifact = z.infer<typeof HumanRubricArtifactSchema>;
export type HumanReviewPacket = z.infer<typeof HumanReviewPacketSchema>;
export type HumanRubricCalibration = z.infer<typeof HumanRubricCalibrationSchema>;
export type HumanRubricProductionReliability = z.infer<
  typeof HumanRubricProductionReliabilitySchema
>;
export type HumanRubricReviewRecord = z.infer<typeof HumanRubricReviewRecordSchema>;

export interface HumanRubricEvaluationInput {
  rubric: HumanRubricArtifact;
  rubricDigest: string;
  packet: HumanReviewPacket;
  calibration?: HumanRubricCalibration;
  productionReliability?: HumanRubricProductionReliability;
  reviews?: readonly HumanRubricReviewRecord[];
  evaluatedAt: string;
}

export interface HumanRubricDecision {
  status: 'passed' | 'failed' | 'unknown';
  reason: string;
  aggregateScore?: number;
  dimensionScores: Record<string, number>;
  rawReviewIds: string[];
}

function unknown(
  reason: string,
  reviews: readonly HumanRubricReviewRecord[] = [],
): HumanRubricDecision {
  return {
    status: 'unknown',
    reason,
    dimensionScores: {},
    rawReviewIds: reviews.map((review) => review.reviewId),
  };
}

function reliabilityPasses(
  reliability: z.infer<typeof ReliabilitySchema>,
  minimumArtifacts: number,
): boolean {
  return (
    reliability.artifactCount >= minimumArtifacts &&
    reliability.ordinalKrippendorffAlpha >= 0.8 &&
    reliability.alphaLowerBound95 >= 0.67 &&
    reliability.anchorAgreementRate >= 0.9 &&
    reliability.hardFailureDetectionRate === 1 &&
    reliability.blindDuplicateRate >= 0.1
  );
}

function ratingMap(
  rubric: HumanRubricArtifact,
  review: HumanRubricReviewRecord,
): Map<string, number> | undefined {
  const ratings = new Map(
    review.dimensionRatings.map((rating) => [rating.dimensionId, rating.score]),
  );
  if (
    ratings.size !== rubric.dimensions.length ||
    rubric.dimensions.some((dimension) => !ratings.has(dimension.id))
  ) {
    return undefined;
  }
  return ratings;
}

function hardFailureMapIsComplete(
  rubric: HumanRubricArtifact,
  review: HumanRubricReviewRecord,
): boolean {
  const keys = Object.keys(review.hardFailureRatings);
  return (
    keys.length === rubric.hardFailures.length &&
    rubric.hardFailures.every((failure) => keys.includes(failure.id))
  );
}

function weightedScore(rubric: HumanRubricArtifact, scores: ReadonlyMap<string, number>): number {
  return rubric.dimensions.reduce(
    (total, dimension) => total + (scores.get(dimension.id) ?? 0) * dimension.weight,
    0,
  );
}

function individualPasses(
  rubric: HumanRubricArtifact,
  review: HumanRubricReviewRecord,
  scores: ReadonlyMap<string, number>,
): boolean {
  return (
    !Object.values(review.hardFailureRatings).some(Boolean) &&
    weightedScore(rubric, scores) >= rubric.passThreshold
  );
}

function reviewPacketPayload(packet: HumanReviewPacket): Omit<HumanReviewPacket, 'packetDigest'> {
  const payload = { ...packet } as Partial<HumanReviewPacket>;
  delete payload.packetDigest;
  return payload as Omit<HumanReviewPacket, 'packetDigest'>;
}

function validateReviewIdentity(
  input: HumanRubricEvaluationInput,
  calibration: HumanRubricCalibration,
  production: HumanRubricProductionReliability,
  review: HumanRubricReviewRecord,
): string | undefined {
  if (
    review.packetDigest !== input.packet.packetDigest ||
    review.rubricId !== input.rubric.rubricId ||
    review.rubricVersion !== input.rubric.rubricVersion ||
    review.rubricDigest !== input.rubricDigest
  ) {
    return 'mixed-rubric-or-packet-identity';
  }
  if (review.calibrationVersion !== calibration.calibrationVersion) {
    return 'reviewer-calibration-version-mismatch';
  }
  const qualification = calibration.reviewerQualifications.find(
    (candidate) => candidate.reviewerId === review.reviewerId,
  );
  if (!qualification) {
    return 'reviewer-not-calibrated';
  }
  if (qualification.qualificationVersion !== review.qualificationVersion) {
    return 'reviewer-qualification-version-mismatch';
  }
  if (review.assignmentBatch !== production.batchId) return 'assignment-batch-mismatch';
  if (!ratingMap(input.rubric, review) || !hardFailureMapIsComplete(input.rubric, review)) {
    return 'review-record-incomplete';
  }
  const packetEvidence = new Set(input.packet.evidenceReferences);
  if (
    review.dimensionRatings.some((rating) =>
      rating.evidenceReferences.some((reference) => !packetEvidence.has(reference)),
    )
  ) {
    return 'rating-evidence-outside-blind-packet';
  }
  const submittedAt = Date.parse(review.submittedAt);
  if (
    submittedAt < Date.parse(calibration.calibratedAt) ||
    submittedAt > Date.parse(input.evaluatedAt)
  ) {
    return 'review-submission-time-invalid';
  }
  return undefined;
}

/** Apply the frozen #48 blind-review, calibration, reliability, and adjudication protocol. */
export function evaluateHumanRubric(input: HumanRubricEvaluationInput): HumanRubricDecision {
  if (!z.string().datetime({ offset: true }).safeParse(input.evaluatedAt).success) {
    return unknown('evaluation-time-invalid');
  }
  const rubricResult = HumanRubricArtifactSchema.safeParse(input.rubric);
  const packetResult = HumanReviewPacketSchema.safeParse(input.packet);
  if (!rubricResult.success || !packetResult.success) return unknown('invalid-rubric-or-packet');
  if (evaluationDigest(input.rubric) !== input.rubricDigest) {
    return unknown('rubric-digest-mismatch');
  }
  if (evaluationDigest(reviewPacketPayload(input.packet)) !== input.packet.packetDigest) {
    return unknown('packet-digest-mismatch');
  }
  const allowedEvidence = [
    ...input.rubric.evidenceView.allowedArtifacts,
    ...input.rubric.evidenceView.allowedReferences,
  ].sort();
  const packetEvidence = [...input.packet.evidenceReferences].sort();
  if (allowedEvidence.join('\0') !== packetEvidence.join('\0')) {
    return unknown('packet-evidence-view-mismatch');
  }
  if (
    input.rubric.evidenceView.modelEvidenceIndex === 'forbidden' &&
    input.packet.modelEvidenceIndex !== undefined
  ) {
    return unknown('model-evidence-index-forbidden');
  }
  if (
    input.packet.rubricId !== input.rubric.rubricId ||
    input.packet.rubricVersion !== input.rubric.rubricVersion ||
    input.packet.rubricDigest !== input.rubricDigest ||
    !input.packet.armIdentityExcluded ||
    !input.packet.equalEvidenceViewAttested ||
    !input.packet.immutable
  ) {
    return unknown('packet-identity-or-blinding-failed');
  }

  const calibrationResult = HumanRubricCalibrationSchema.safeParse(input.calibration);
  if (!calibrationResult.success) return unknown('calibration-missing-or-invalid');
  const calibration = calibrationResult.data;
  if (
    calibration.rubricId !== input.rubric.rubricId ||
    calibration.rubricVersion !== input.rubric.rubricVersion ||
    calibration.rubricDigest !== input.rubricDigest
  ) {
    return unknown('calibration-rubric-mismatch');
  }
  if (
    calibration.status !== 'current' ||
    Date.parse(input.evaluatedAt) < Date.parse(calibration.calibratedAt) ||
    Date.parse(input.evaluatedAt) >= Date.parse(calibration.expiresAt)
  ) {
    return unknown('calibration-stale');
  }
  if (!reliabilityPasses(calibration, 30)) return unknown('calibration-reliability-failed');

  const productionResult = HumanRubricProductionReliabilitySchema.safeParse(
    input.productionReliability,
  );
  if (!productionResult.success) return unknown('production-reliability-missing');
  const production = productionResult.data;
  if (
    production.status !== 'current' ||
    production.rubricDigest !== input.rubricDigest ||
    production.reviewerPoolVersion !== calibration.reviewerPoolVersion ||
    !reliabilityPasses(production, 1)
  ) {
    return unknown('production-reliability-drift');
  }

  const reviewsResult = z.array(HumanRubricReviewRecordSchema).safeParse(input.reviews ?? []);
  if (!reviewsResult.success) return unknown('review-record-invalid');
  const reviews = reviewsResult.data;
  const reviewIds = reviews.map((review) => review.reviewId);
  const reviewerIds = reviews.map((review) => review.reviewerId);
  if (
    new Set(reviewIds).size !== reviewIds.length ||
    new Set(reviewerIds).size !== reviewerIds.length
  ) {
    return unknown('duplicate-review-or-reviewer-identity', reviews);
  }
  for (const review of reviews) {
    const reason = validateReviewIdentity(input, calibration, production, review);
    if (reason) return unknown(reason, reviews);
  }

  const primary = reviews.filter((review) => review.reviewerRole === 'primary');
  const adjudicators = reviews.filter((review) => review.reviewerRole === 'adjudicator');
  if (primary.length !== 2) return unknown('two-primary-reviews-required', reviews);
  if (adjudicators.length > 1) return unknown('at-most-one-adjudicator-permitted', reviews);
  const adjudicatorLinks = adjudicators[0]?.adjudicatesReviewIds;
  if (
    adjudicatorLinks &&
    [...adjudicatorLinks].sort().join('\0') !==
      primary
        .map((review) => review.reviewId)
        .sort()
        .join('\0')
  ) {
    return unknown('adjudication-linkage-mismatch', reviews);
  }

  const primaryMaps = primary.map((review) => ratingMap(input.rubric, review)!);
  const primaryPasses = primary.map((review, index) =>
    individualPasses(input.rubric, review, primaryMaps[index]),
  );
  const dimensionsAgree = input.rubric.dimensions.every(
    (dimension) =>
      Math.abs(primaryMaps[0].get(dimension.id)! - primaryMaps[1].get(dimension.id)!) <= 1,
  );
  const hardFailuresAgree = input.rubric.hardFailures.every(
    (failure) =>
      primary[0].hardFailureRatings[failure.id] === primary[1].hardFailureRatings[failure.id],
  );
  const primaryAgreement =
    dimensionsAgree && hardFailuresAgree && primaryPasses[0] === primaryPasses[1];

  if (primaryAgreement && adjudicators.length > 0) {
    return unknown('unnecessary-adjudication', reviews);
  }

  let aggregate: Map<string, number>;
  let hardFailure: boolean;
  if (primaryAgreement) {
    aggregate = new Map(
      input.rubric.dimensions.map((dimension) => [
        dimension.id,
        (primaryMaps[0].get(dimension.id)! + primaryMaps[1].get(dimension.id)!) / 2,
      ]),
    );
    hardFailure = Object.values(primary[0].hardFailureRatings).some(Boolean);
  } else {
    const adjudicator = adjudicators[0];
    if (!adjudicator) return unknown('adjudication-required', reviews);
    const adjudicatorMap = ratingMap(input.rubric, adjudicator)!;
    const allMaps = [...primaryMaps, adjudicatorMap];
    const dimensionConsensus = input.rubric.dimensions.every((dimension) => {
      const scores = allMaps.map((ratings) => ratings.get(dimension.id)!).sort((a, b) => a - b);
      return scores[1] - scores[0] <= 1 || scores[2] - scores[1] <= 1;
    });
    if (!dimensionConsensus) return unknown('unresolved-dimension-disagreement', reviews);
    aggregate = new Map(
      input.rubric.dimensions.map((dimension) => {
        const scores = allMaps.map((ratings) => ratings.get(dimension.id)!).sort((a, b) => a - b);
        return [dimension.id, scores[1]];
      }),
    );
    const hardFailureVotes = input.rubric.hardFailures.map(
      (failure) => reviews.filter((review) => review.hardFailureRatings[failure.id]).length,
    );
    hardFailure = hardFailureVotes.some((votes) => votes >= 2);
    const individualDecisions = [
      ...primaryPasses,
      individualPasses(input.rubric, adjudicator, adjudicatorMap),
    ];
    const majorityPass = individualDecisions.filter(Boolean).length >= 2;
    const aggregatePass =
      !hardFailure && weightedScore(input.rubric, aggregate) >= input.rubric.passThreshold;
    if (majorityPass !== aggregatePass)
      return unknown('unresolved-pass-fail-disagreement', reviews);
  }

  const aggregateScore = Number(weightedScore(input.rubric, aggregate).toFixed(12));
  const status = !hardFailure && aggregateScore >= input.rubric.passThreshold ? 'passed' : 'failed';
  return {
    status,
    reason: hardFailure ? 'hard-failure-consensus' : `aggregate-score:${aggregateScore.toFixed(2)}`,
    aggregateScore,
    dimensionScores: Object.fromEntries(aggregate),
    rawReviewIds: reviews.map((review) => review.reviewId),
  };
}
