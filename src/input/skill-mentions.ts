import type { Skill } from '../skills.js';

export interface ActiveSkillMention {
  start: number;
  end: number;
  query: string;
}

export interface SkillMentionCandidate {
  name: string;
  description: string;
  source: Skill['source'];
  rootKind: Skill['rootKind'];
}

function isMentionBoundary(input: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s([{<"']/.test(input[index - 1]);
}

/** Find an unfinished `$skill-name` mention at the end of the prompt. */
export function findActiveSkillMention(input: string): ActiveSkillMention | null {
  for (let index = input.length - 1; index >= 0; index--) {
    if (input[index] !== '$' || !isMentionBoundary(input, index)) continue;

    const query = input.slice(index + 1);
    if (!/^[a-z0-9-]*$/i.test(query)) return null;
    return { start: index, end: input.length, query };
  }
  return null;
}

/** Rank valid, explicitly invocable skills for the active mention. */
export function getSkillMentionCandidates(
  skills: readonly Skill[],
  query: string,
  limit = 50,
): SkillMentionCandidate[] {
  const normalizedQuery = query.toLowerCase();
  const candidates: Array<SkillMentionCandidate & { score: number }> = [];

  for (const skill of skills) {
    // This is the explicit `$name` picker, so Claude-compatible
    // `disable-model-invocation` remains intentionally invocable by the user.
    if (!skill.valid || skill.activation === 'off' || skill.execution === 'deny') continue;

    const name = skill.name.toLowerCase();
    const description = skill.description.toLowerCase();
    let score: number | null = null;
    if (!normalizedQuery) score = 3;
    else if (name === normalizedQuery) score = 0;
    else if (name.startsWith(normalizedQuery)) score = 1;
    else if (name.includes(normalizedQuery)) score = 2;
    else if (description.includes(normalizedQuery)) score = 4;
    if (score === null) continue;

    candidates.push({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      rootKind: skill.rootKind,
      score,
    });
  }

  candidates.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return candidates.slice(0, limit).map(({ score: _score, ...candidate }) => candidate);
}

export function replaceActiveSkillMention(
  input: string,
  mention: ActiveSkillMention,
  skillName: string,
): string {
  return input.slice(0, mention.start) + `$${skillName} ` + input.slice(mention.end);
}
