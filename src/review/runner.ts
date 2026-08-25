import type { AgentManager } from '../agents/manager.js';
import type { EvidenceItem } from '../agents/types.js';
import type { FixAgentRunner, FixEvidence } from './fix.js';
import type { ReviewAgentRunner } from './orchestration.js';

/**
 * The run the reviewer/patcher agents belong to.
 *
 * Supplying it is what puts every agent a review spawns under the caller's
 * accounting root: `RunAccounting.checkBeforeModelCall` is keyed by `rootRunId`,
 * so an agent spawned without one starts a fresh root that has no budget and
 * silently escapes `--max-budget-usd`. Optional because the interactive host has
 * no budget root to attach to.
 *
 * `parentSessionId` is what makes a review *visible*: a session's agent surface
 * shows only agents owned by that session, so without it every reviewer, lens,
 * verifier and patcher runs invisibly and a multi-minute review looks like a
 * hung prompt. Re-narrating each completion as a model turn is suppressed
 * separately, by `notifyParentOnCompletion: false` — the review renders its own
 * report, so a completion notification would only bill a turn to restate it.
 * Ownership and delivery are different questions; conflating them is what cost
 * the review its progress display.
 *
 * A host with no session to attach to (print mode) simply omits it.
 */
export interface ReviewRunAttribution {
  rootRunId?: string;
  parentRunId?: string;
  /** Session that owns the spawned agents, for progress display only. */
  parentSessionId?: string;
}

function evidenceProjection(item: EvidenceItem): FixEvidence {
  return {
    id: item.id,
    verificationState: item.verificationState,
    verdict: item.verdict,
    reviewNotes: item.reviewNotes,
  };
}

export function reviewRunnerFor(
  manager: AgentManager,
  attribution: ReviewRunAttribution = {},
): ReviewAgentRunner {
  return {
    async spawn(agent, prompt, options) {
      const record = await manager.spawn({
        agent,
        prompt,
        description: options?.description,
        evidenceIds: options?.evidenceIds,
        rootRunId: attribution.rootRunId,
        parentRunId: attribution.parentRunId,
        parentSessionId: attribution.parentSessionId,
        notifyParentOnCompletion: false,
      });
      return {
        id: record.id,
        status: record.status,
        result: record.result,
        error: record.error,
        producedEvidenceIds: record.producedEvidenceIds,
      };
    },
    async wait(id, timeoutMs) {
      const record = await manager.wait(id, timeoutMs);
      return {
        id: record.id,
        status: record.status,
        result: record.result,
        error: record.error,
        producedEvidenceIds: record.producedEvidenceIds,
      };
    },
    async stop(id, reason) {
      await manager.stop(id, reason);
    },
  };
}

export function fixRunnerFor(
  manager: AgentManager,
  attribution: ReviewRunAttribution = {},
): FixAgentRunner {
  return {
    ...reviewRunnerFor(manager, attribution),
    async findPatchCandidateEvidence(agentId) {
      const evidence = (await manager.listEvidence())
        .filter(
          (item) =>
            item.sourceAgentId === agentId &&
            item.kind === 'patch_candidate' &&
            item.patchCandidate !== undefined,
        )
        .sort((left, right) => right.createdAt - left.createdAt)[0];
      return evidence ? evidenceProjection(evidence) : undefined;
    },
    async getEvidence(evidenceId) {
      const evidence = (await manager.listEvidence({ ids: [evidenceId] }))[0];
      return evidence ? evidenceProjection(evidence) : undefined;
    },
    async apply(agentId, evidenceId) {
      const result = await manager.apply(agentId, evidenceId);
      return { status: result.status, commit: result.commit, error: result.error };
    },
  };
}
