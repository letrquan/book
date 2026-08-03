import type { SkillRegistrySnapshot } from './skill-registry.js';

/** Render a body-free diagnostic report suitable for commands, logs, and SDK consumers. */
export function buildSkillReport(snapshot: SkillRegistrySnapshot | undefined): string {
  if (!snapshot) return 'Skill runtime has not been initialized for this session.';
  const invalid = snapshot.skills.filter((skill) => !skill.valid);
  const shadowed = snapshot.skills.reduce((total, skill) => total + skill.shadowed.length, 0);
  const lines = [
    '# Skills',
    '',
    `Catalog: ${snapshot.catalogDigest}`,
    `Discovered: ${snapshot.skills.length}`,
    `Active: ${snapshot.active.length}`,
    `Previous: ${snapshot.previous.length}`,
    `Invalid: ${invalid.length}`,
    `Shadowed sources: ${shadowed}`,
  ];
  if (snapshot.promptCatalog) {
    lines.push(
      '',
      '## Prompt catalog',
      '',
      `Budget: ${snapshot.promptCatalog.budgetChars} characters`,
      `Included: ${snapshot.promptCatalog.included.join(', ') || 'none'}`,
      `Collapsed: ${snapshot.promptCatalog.collapsed.join(', ') || 'none'}`,
      `Omitted: ${snapshot.promptCatalog.omitted.join(', ') || 'none'}`,
    );
  }
  lines.push(
    '',
    '## Effective tools',
    '',
    snapshot.effectiveTools?.join(', ') || 'No active skill intersection.',
  );
  if (snapshot.active.length) {
    lines.push('', '## Active frames', '');
    for (const frame of snapshot.active) {
      lines.push(
        `- ${frame.skillName}: ${frame.reason}, ${frame.expires}, ${frame.source}/${frame.rootKind}, body ${frame.bodyDigest.slice(0, 12)}`,
      );
    }
  }
  if (snapshot.previous.length) {
    lines.push('', '## Previous frames', '');
    for (const frame of snapshot.previous.slice(-10)) {
      lines.push(
        `- ${frame.skillName}: ${frame.reason}, ${frame.expires}, ${frame.source}/${frame.rootKind}, body ${frame.bodyDigest.slice(0, 12)}`,
      );
    }
  }
  if (invalid.length) {
    lines.push('', '## Validation failures', '');
    for (const skill of invalid) {
      lines.push(
        `- ${skill.name}: ${skill.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => `${issue.code}: ${issue.message}`)
          .join('; ')}`,
      );
    }
  }
  const recentEvents = snapshot.events.slice(-10);
  if (recentEvents.length) {
    lines.push('', '## Recent lifecycle', '');
    for (const event of recentEvents) {
      const code = typeof event.details?.code === 'string' ? ` (${event.details.code})` : '';
      lines.push(`- ${event.type}${event.skill ? `: ${event.skill}` : ''}${code}`);
    }
  }
  return lines.join('\n');
}
