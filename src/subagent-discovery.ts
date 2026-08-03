import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';
import { parseFrontmatter } from './frontmatter.js';
import { canonicalToolName } from './tools/aliases.js';
import { resolveBookHome } from './book-home.js';

const KNOWN_AGENT_TOOLS = new Set([
  '*',
  'AskUserQuestion',
  'ApplyPatch',
  'Bash',
  'Check',
  'Edit',
  'EvidenceList',
  'EvidencePublish',
  'EvidenceReview',
  'GitBranch',
  'GitDiff',
  'GitLog',
  'GitStatus',
  'Glob',
  'Grep',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
]);

export function normalizeAgentTool(tool: string): string | undefined {
  const match = tool.trim().match(/^([^()]+)(\(.*\))?$/);
  if (!match) return undefined;
  const canonical = canonicalToolName(match[1].trim());
  if (!KNOWN_AGENT_TOOLS.has(canonical) && !canonical.startsWith('mcp__')) return undefined;
  return `${canonical}${match[2] ?? ''}`;
}

/**
 * A subagent definition loaded from .book/agents/<name>.md or
 * ~/.book/agents/<name>.md. Matches Claude Code's subagent model.
 */
export interface SubagentDef {
  /** Name used for invocation via the Task tool. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Strict capability rules. Empty denies all tools; `*` explicitly inherits. */
  allowedTools: string[];
  /** Override model for this subagent (optional). */
  model?: string;
  /** Maximum turns for this subagent. Undefined = unlimited. */
  maxTurns?: number;
  effort?: string;
  isolation?: 'workspace-readonly' | 'worktree';
  color?: string;
  unknownTools?: string[];
  /** The raw Markdown body — injected as the subagent's system prompt. */
  body: string;
  /** Source directory. */
  source: 'user' | 'project' | 'builtin';
}

/**
 * Load a single subagent .md file. Returns null if not found or malformed.
 */
export function loadAgentFile(filePath: string, source: 'user' | 'project'): SubagentDef | null {
  if (!existsSync(filePath) || extname(filePath) !== '.md') return null;
  const raw = readFileSync(filePath, 'utf-8');
  const { body, frontmatter } = parseFrontmatter(raw);
  const name = String(frontmatter.name || filePath.split(/[/\\]/).pop()!.replace(/\.md$/, ''));
  if (!name) return null;

  const toolsValue = frontmatter.tools ?? frontmatter['allowed-tools'];
  const requestedTools = Array.isArray(toolsValue)
    ? toolsValue
        .map(String)
        .map((tool) => tool.trim())
        .filter(Boolean)
    : typeof toolsValue === 'string'
      ? toolsValue
          .split(',')
          .map((tool) => tool.trim())
          .filter(Boolean)
      : [];
  const allowedTools = requestedTools.map((tool) => normalizeAgentTool(tool) ?? tool);
  const model = typeof frontmatter.model === 'string' ? frontmatter.model.trim() : undefined;
  const unknownTools = requestedTools.filter((tool) => !normalizeAgentTool(tool));
  return {
    name,
    description: (frontmatter.description as string) || name,
    allowedTools,
    model: model === 'inherit' ? undefined : model,
    maxTurns:
      typeof frontmatter.maxTurns === 'number'
        ? (frontmatter.maxTurns as number)
        : typeof frontmatter.maxTurns === 'string'
          ? parseInt(frontmatter.maxTurns as string, 10) || undefined
          : undefined,
    body,
    source,
    effort: typeof frontmatter.effort === 'string' ? frontmatter.effort : undefined,
    isolation:
      frontmatter.isolation === 'workspace-readonly' || frontmatter.isolation === 'worktree'
        ? frontmatter.isolation
        : undefined,
    color: typeof frontmatter.color === 'string' ? frontmatter.color : undefined,
    unknownTools,
  };
}

function markdownFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && extname(entry.name) === '.md') files.push(fullPath);
    }
  };
  visit(root);
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

/**
 * Discover all subagent definitions from the conventional directories.
 *
 * Search order (project wins on name collision):
 *   1. ~/.book/agents/*.md  (user)
 *   2. .book/agents/*.md    (project)
 */
export function discoverAgents(workspace: string): SubagentDef[] {
  const userDir = join(resolveBookHome(), 'agents');
  const projectDir = join(workspace, '.book', 'agents');

  const byName = new Map<string, SubagentDef>();

  for (const dir of [userDir, projectDir]) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = markdownFiles(dir);
    } catch {
      continue;
    }
    for (const fullPath of entries) {
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
