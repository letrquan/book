import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';
import { parseFrontmatter } from './frontmatter.js';

/**
 * A subagent definition loaded from .book/agents/<name>.md or
 * ~/.book/agents/<name>.md. Matches Claude Code's subagent model.
 */
export interface SubagentDef {
  /** Name used for invocation via the Task tool. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Restrict which tools this subagent can use. Empty = all tools. */
  allowedTools: string[];
  /** Override model for this subagent (optional). */
  model?: string;
  /** Maximum turns for this subagent (default 5). */
  maxTurns: number;
  /** The raw Markdown body — injected as the subagent's system prompt. */
  body: string;
  /** Source directory. */
  source: 'user' | 'project';
}

/**
 * Load a single subagent .md file. Returns null if not found or malformed.
 */
function loadAgentFile(filePath: string, source: 'user' | 'project'): SubagentDef | null {
  if (!existsSync(filePath) || extname(filePath) !== '.md') return null;
  const raw = readFileSync(filePath, 'utf-8');
  const { body, frontmatter } = parseFrontmatter(raw);
  const name = String(frontmatter.name || filePath.split(/[/\\]/).pop()!.replace(/\.md$/, ''));
  if (!name) return null;

  return {
    name,
    description: (frontmatter.description as string) || name,
    allowedTools: Array.isArray(frontmatter.tools) ? (frontmatter.tools as string[]) : [],
    model: frontmatter.model as string | undefined,
    maxTurns:
      typeof frontmatter.maxTurns === 'number'
        ? (frontmatter.maxTurns as number)
        : typeof frontmatter.maxTurns === 'string'
          ? parseInt(frontmatter.maxTurns as string, 10) || 5
          : 5,
    body,
    source,
  };
}

/**
 * Discover all subagent definitions from the conventional directories.
 *
 * Search order (project wins on name collision):
 *   1. ~/.book/agents/*.md  (user)
 *   2. .book/agents/*.md    (project)
 */
export function discoverAgents(workspace: string): SubagentDef[] {
  const userDir = join(homedir(), '.book', 'agents');
  const projectDir = join(workspace, '.book', 'agents');

  const byName = new Map<string, SubagentDef>();

  for (const dir of [userDir, projectDir]) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const source = dir === userDir ? 'user' : 'project';
      const agent = loadAgentFile(fullPath, source);
      if (agent) byName.set(agent.name, agent);
    }
  }

  return Array.from(byName.values());
}
