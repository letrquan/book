import type { SubagentDef } from '../subagent-discovery.js';
import type { AgentProfile } from './types.js';

export interface ManagedAgentDef extends Omit<SubagentDef, 'isolation'>, AgentProfile {}

export const BUILTIN_AGENTS: ManagedAgentDef[] = [
  {
    name: 'explorer',
    description:
      'Fast read-only search agent for locating files, symbols, references, and code paths while keeping raw exploration out of the parent context. Use proactively when broad discovery is expected to require more than three search queries. Specify quick, medium, or very thorough search breadth. Do not use for implementation, code review, or design auditing.',
    role: 'explorer',
    isolation: 'workspace-readonly',
    allowedTools: [
      'Read',
      'Glob',
      'Grep',
      'GitStatus',
      'GitDiff',
      'GitLog',
      'GitBranch',
      'EvidencePublish',
      'EvidenceList',
    ],
    body: [
      'You are the explorer agent.',
      'Investigate the assigned question without editing files.',
      'Return compact findings with exact file and line references, confidence, and unresolved questions.',
      'Do not include raw search dumps or duplicated prose.',
      'Publish important findings, hypotheses, blockers, and test results as typed evidence.',
      'Prefer exact file, command, and diff references over broad narrative.',
    ].join('\n'),
    source: 'builtin',
  },
  {
    name: 'patcher',
    description: 'Implements a bounded change in an isolated managed worktree.',
    role: 'patcher',
    isolation: 'worktree',
    allowedTools: [
      'Read',
      'Glob',
      'Grep',
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'GitStatus',
      'GitDiff',
      'GitLog',
      'GitBranch',
      'Check',
      'EvidencePublish',
      'EvidenceList',
    ],
    maxTurns: 24,
    body: [
      'You are the patcher agent.',
      'Implement only the assigned bounded change in your isolated worktree.',
      'Run named checks when useful and publish referenced evidence for important decisions.',
      'Do not apply changes to the parent workspace; the manager commits your completed delta.',
    ].join('\n'),
    source: 'builtin',
  },
  {
    name: 'validator',
    description: 'Independently checks a patch candidate and records a pass/fail verdict.',
    role: 'validator',
    isolation: 'worktree',
    allowedTools: [
      'Read',
      'Glob',
      'Grep',
      'GitStatus',
      'GitDiff',
      'GitLog',
      'GitBranch',
      'Check',
      'EvidencePublish',
      'EvidenceList',
      'EvidenceReview',
    ],
    maxTurns: 16,
    body: [
      'You are the validator agent.',
      'Independently validate explicitly referenced patch candidates.',
      'Inspect the exact base/head pair, run appropriate named checks, and record pass, fail, or inconclusive.',
      'Never approve your own evidence and never edit the patch.',
    ].join('\n'),
    source: 'builtin',
  },
];

export function withBuiltInAgents(discovered: SubagentDef[]): ManagedAgentDef[] {
  const byName = new Map<string, ManagedAgentDef>(
    BUILTIN_AGENTS.map((agent) => [agent.name, agent]),
  );
  for (const agent of discovered) {
    const builtinRole = BUILTIN_AGENTS.find((candidate) => candidate.name === agent.name)?.role;
    byName.set(agent.name, {
      ...agent,
      role: builtinRole ?? 'custom',
      isolation:
        agent.isolation ?? (builtinRole === 'explorer' ? 'workspace-readonly' : 'worktree'),
    });
  }
  return Array.from(byName.values());
}
