import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluationDigest } from './identity.js';
import {
  HumanRubricArtifactSchema,
  evaluateHumanRubric,
  type HumanReviewPacket,
  type HumanRubricArtifact,
  type HumanRubricCalibration,
  type HumanRubricEvaluationInput,
  type HumanRubricProductionReliability,
  type HumanRubricReviewRecord,
} from './review.js';

const digest = `sha256:${'a'.repeat(64)}`;
let rubric: HumanRubricArtifact;
let rubricDigest: string;

beforeAll(async () => {
  rubric = HumanRubricArtifactSchema.parse(
    JSON.parse(
      await readFile(resolve('evals/harness/rubrics/review-quality-v1.json'), 'utf8'),
    ) as unknown,
  );
  rubricDigest = evaluationDigest(rubric);
});

function packet(): HumanReviewPacket {
  const payload = {
    schemaVersion: 1,
    packetId: 'packet-1',
    artifactDigest: digest,
    rubricId: rubric.rubricId,
    rubricVersion: rubric.rubricVersion,
    rubricDigest,
    evidenceDigest: digest,
    evidenceReferences: ['review.md', 'src/auth.ts'],
    presentationSeedDigest: digest,
    privacyReviewDigest: digest,
    armIdentityExcluded: true,
    equalEvidenceViewAttested: true,
    immutable: true,
  } as const;
  return {
    ...payload,
    evidenceReferences: [...payload.evidenceReferences],
    packetDigest: evaluationDigest(payload),
  };
}

function reliability(): HumanRubricCalibration {
  return {
    calibrationVersion: 'calibration-v1',
    calibrationSetDigest: digest,
    rubricId: rubric.rubricId,
    rubricVersion: rubric.rubricVersion,
    rubricDigest,
    reviewerPoolVersion: 'reviewer-pool-v1',
    calibratedReviewerIds: ['reviewer-a', 'reviewer-b', 'reviewer-c'],
    reviewerQualifications: [
      {
        reviewerId: 'reviewer-a',
        qualificationVersion: 'qualification-v1',
        domainRole: 'security-reviewer',
      },
      {
        reviewerId: 'reviewer-b',
        qualificationVersion: 'qualification-v1',
        domainRole: 'security-reviewer',
      },
      {
        reviewerId: 'reviewer-c',
        qualificationVersion: 'qualification-v1',
        domainRole: 'security-reviewer',
      },
    ],
    lockedBeforeScoring: true,
    separateFromCandidateAndHoldouts: true,
    stratifiedAcrossAnchors: true,
    nearThresholdCovered: true,
    allHardFailuresCovered: true,
    statisticDefined: true,
    status: 'current',
    calibratedAt: '2026-08-01T00:00:00Z',
    expiresAt: '2027-08-01T00:00:00Z',
    artifactCount: 30,
    ordinalKrippendorffAlpha: 0.82,
    alphaLowerBound95: 0.68,
    anchorAgreementRate: 0.91,
    hardFailureDetectionRate: 1,
    blindDuplicateRate: 0.1,
  };
}

function productionReliability(): HumanRubricProductionReliability {
  return {
    batchId: 'batch-1',
    rubricDigest,
    reviewerPoolVersion: 'reviewer-pool-v1',
    assignmentCount: 40,
    assignmentsBalancedAcrossArms: true,
    reviewerEffectsRetained: true,
    preAdjudicationReliability: true,
    status: 'current',
    artifactCount: 20,
    ordinalKrippendorffAlpha: 0.81,
    alphaLowerBound95: 0.67,
    anchorAgreementRate: 0.9,
    hardFailureDetectionRate: 1,
    blindDuplicateRate: 0.1,
  };
}

function review(
  reviewId: string,
  reviewerId: string,
  reviewerRole: 'primary' | 'adjudicator',
  score: number,
  hardFailure = false,
): HumanRubricReviewRecord {
  return {
    schemaVersion: 1,
    reviewId,
    packetDigest: packet().packetDigest,
    rubricId: rubric.rubricId,
    rubricVersion: rubric.rubricVersion,
    rubricDigest,
    reviewerId,
    reviewerRole,
    qualificationVersion: 'qualification-v1',
    calibrationVersion: 'calibration-v1',
    assignmentBatch: 'batch-1',
    ...(reviewerRole === 'adjudicator' ? { adjudicatesReviewIds: ['review-1', 'review-2'] } : {}),
    dimensionRatings: rubric.dimensions.map((dimension) => ({
      dimensionId: dimension.id,
      score,
      evidenceReferences: ['review.md', 'src/auth.ts'],
    })),
    hardFailureRatings: Object.fromEntries(
      rubric.hardFailures.map((failure, index) => [failure.id, index === 0 && hardFailure]),
    ),
    submittedAt: '2026-08-11T00:00:00Z',
    attestations: {
      authenticated: true,
      blind: true,
      independent: true,
      conflictFree: true,
      priorRatingsHidden: true,
      humanReviewer: true,
    },
  };
}

function input(reviews: HumanRubricReviewRecord[]): HumanRubricEvaluationInput {
  return {
    rubric,
    rubricDigest,
    packet: packet(),
    calibration: reliability(),
    productionReliability: productionReliability(),
    reviews,
    evaluatedAt: '2026-08-11T00:00:00Z',
  };
}

describe('Phase 0 human rubric protocol', () => {
  it('accepts two calibrated blind independent reviewers only with continuing reliability', () => {
    expect(
      evaluateHumanRubric(
        input([
          review('review-1', 'reviewer-a', 'primary', 4),
          review('review-2', 'reviewer-b', 'primary', 3),
        ]),
      ),
    ).toMatchObject({
      status: 'passed',
      reason: 'aggregate-score:3.50',
      aggregateScore: 3.5,
      rawReviewIds: ['review-1', 'review-2'],
    });
  });

  it('keeps disagreement unknown until a blind third review resolves it', () => {
    const primary = [
      review('review-1', 'reviewer-a', 'primary', 4),
      review('review-2', 'reviewer-b', 'primary', 1),
    ];
    expect(evaluateHumanRubric(input(primary))).toMatchObject({
      status: 'unknown',
      reason: 'adjudication-required',
    });
    expect(
      evaluateHumanRubric(input([...primary, review('review-3', 'reviewer-c', 'adjudicator', 4)])),
    ).toMatchObject({ status: 'passed', aggregateScore: 4 });
  });

  it('retains consensus hard failures as failure regardless of numeric score', () => {
    expect(
      evaluateHumanRubric(
        input([
          review('review-1', 'reviewer-a', 'primary', 4, true),
          review('review-2', 'reviewer-b', 'primary', 4, true),
        ]),
      ),
    ).toMatchObject({ status: 'failed', reason: 'hard-failure-consensus' });
  });

  it('fails closed on missing production reliability and duplicate reviewer identity', () => {
    expect(
      evaluateHumanRubric({
        ...input([
          review('review-1', 'reviewer-a', 'primary', 4),
          review('review-2', 'reviewer-b', 'primary', 4),
        ]),
        productionReliability: undefined,
      }),
    ).toMatchObject({ status: 'unknown', reason: 'production-reliability-missing' });

    expect(
      evaluateHumanRubric(
        input([
          review('review-1', 'reviewer-a', 'primary', 4),
          review('review-2', 'reviewer-a', 'primary', 4),
        ]),
      ),
    ).toMatchObject({
      status: 'unknown',
      reason: 'duplicate-review-or-reviewer-identity',
    });
  });

  it('does not let a caller substitute a different rubric under a pinned digest', () => {
    expect(
      evaluateHumanRubric({
        ...input([
          review('review-1', 'reviewer-a', 'primary', 4),
          review('review-2', 'reviewer-b', 'primary', 4),
        ]),
        rubric: { ...rubric, passThreshold: 2 },
      }),
    ).toMatchObject({ status: 'unknown', reason: 'rubric-digest-mismatch' });
  });

  it('rejects evidence outside the exact blind packet and unpinned reviewer qualifications', () => {
    const reviews = [
      review('review-1', 'reviewer-a', 'primary', 4),
      review('review-2', 'reviewer-b', 'primary', 4),
    ];
    const outsidePacket = { ...packet(), evidenceReferences: ['review.md', 'src/auth.ts', 'x'] };
    const outsidePayload = Object.fromEntries(
      Object.entries(outsidePacket).filter(([key]) => key !== 'packetDigest'),
    );
    outsidePacket.packetDigest = evaluationDigest(outsidePayload);
    expect(evaluateHumanRubric({ ...input(reviews), packet: outsidePacket })).toMatchObject({
      status: 'unknown',
      reason: 'packet-evidence-view-mismatch',
    });

    reviews[0].qualificationVersion = 'unapproved-qualification';
    expect(evaluateHumanRubric(input(reviews))).toMatchObject({
      status: 'unknown',
      reason: 'reviewer-qualification-version-mismatch',
    });
  });

  it('requires unique dimension ratings and exact blind adjudication linkage', () => {
    const duplicate = review('review-1', 'reviewer-a', 'primary', 4);
    duplicate.dimensionRatings.push({ ...duplicate.dimensionRatings[0] });
    expect(
      evaluateHumanRubric(input([duplicate, review('review-2', 'reviewer-b', 'primary', 4)])),
    ).toMatchObject({ status: 'unknown', reason: 'review-record-invalid' });

    const adjudicator = review('review-3', 'reviewer-c', 'adjudicator', 4);
    adjudicator.adjudicatesReviewIds = ['review-1', 'unrelated-review'];
    expect(
      evaluateHumanRubric(
        input([
          review('review-1', 'reviewer-a', 'primary', 4),
          review('review-2', 'reviewer-b', 'primary', 1),
          adjudicator,
        ]),
      ),
    ).toMatchObject({ status: 'unknown', reason: 'adjudication-linkage-mismatch' });
  });
});
