/**
 * Curated, tool-restricted prompt for the /init command.
 *
 * Research-aligned: every agent CLI that has /init (Claude Code, OpenCode) is
 * agent-DRIVEN — the model analyzes the repo and writes a rich context file,
 * not a local template scaffold. Book has no bundled init skill yet (milestone
 * 1e is MISSING), so /init runs this prompt through the existing agent loop
 * with its tools restricted to read/search/write. The bundled-skill +
 * interactive multi-phase flow (CC's CLAUDE_CODE_NEW_INIT=1) is the follow-up.
 */
export function buildInitPrompt(_workspace: string): string {
  return [
    'You are initializing this project. Create or refine a CLAUDE.md file that documents the project for an AI coding agent.',
    '',
    'Steps:',
    '1. Read package.json (or equivalent: pyproject.toml, Cargo.toml, go.mod) to identify the language, runtime, dependencies, and the build/test/lint scripts.',
    '2. Glob the top-level tree and Read README.md if present. Skim the most important source directories to understand the project layout and conventions.',
    '3. Run `git remote -v` to capture the repo origin.',
    '',
    'Then, if CLAUDE.md does NOT exist, write a new CLAUDE.md with these sections:',
    '  # <Project Name>',
    '  A one-paragraph description of what the project is.',
    '  ## Tech stack',
    '  ## Architecture (high-level module map with key files)',
    '  ## Common commands (build, dev, test, lint — exact commands, runnable)',
    '  ## Key conventions (naming, patterns, testing habits observed)',
    "  ## Do/Don't notes grounded in what you observed in the repo",
    '',
    'If CLAUDE.md ALREADY exists, do NOT overwrite it. Read it, then propose targeted improvements as a short bulleted list and offer to apply them — let the user confirm before writing.',
    '',
    'Keep it concise and grounded in real repository content. Do not invent conventions you cannot point to. Prefer exact, runnable commands over narrative.',
  ].join('\n');
}
