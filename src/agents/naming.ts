const MAX_WORDS = 6;

export function deriveAgentDisplayName(prompt: string, fallback: string): string {
  const cleaned = prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>\[\](){}]/g, ' ')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s]+/g, ' ')
    .replace(/\b[\w.-]+(?:[\\/][\w.-]+)+\b/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  const words = cleaned.split(' ').filter(Boolean).slice(0, MAX_WORDS);
  const name = words.join(' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function uniqueAgentDisplayName(requested: string, activeNames: Iterable<string>): string {
  const names = new Set(activeNames);
  if (!names.has(requested)) return requested;
  let suffix = 2;
  while (names.has(`${requested} ${suffix}`)) suffix++;
  return `${requested} ${suffix}`;
}
