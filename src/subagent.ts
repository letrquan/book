import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';
import type { AgentConfig, Message, ToolContext, ToolDefinition } from './types.js';
import { runAgentLoop } from './agent/loop.js';
import { createRegistry } from './tools/registry.js';
import { loadGitignore } from './tools/gitignore.js';
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
function loadAgentFile(
  filePath: string,
  source: 'user' | 'project',
): SubagentDef | null {
  if (!existsSync(filePath) || extname(filePath) !== '.md') return null;
  const raw = readFileSync(filePath, 'utf-8');
  const { body, frontmatter } = parseFrontmatter(raw);
  const name = String(
    frontmatter.name || filePath.split(/[/\\]/).pop()!.replace(/\.md$/, ''),
  );
  if (!name) return null;

  return {
    name,
    description: (frontmatter.description as string) || name,
    allowedTools: Array.isArray(frontmatter.tools)
      ? (frontmatter.tools as string[])
      : [],
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

/**
 * Run a subagent with isolated context and restricted tools.
 *
 * The subagent starts with an empty history, sees only its own system prompt
 * (the agent body), and can only use tools in its allowedTools list. When
 * allowedTools is empty, all tools are available.
 *
 * @returns The final assistant message content, or an error string.
 */
export async function runSubagent(
  def: SubagentDef,
  prompt: string,
  config: AgentConfig,
  fullRegistry = createRegistry(),
): Promise<{ content: string; error?: string }> {
  // Build the subagent's restricted registry if tools are specified.
  let registry = fullRegistry;
  if (def.allowedTools.length > 0) {
    const allowed = new Set(def.allowedTools.map((t) => t.split('(')[0].trim()));
    registry = createRegistry();
    for (const tool of fullRegistry.getDefinitions()) {
      if (allowed.has(tool.name)) {
        registry.register(tool);
      }
    }
  }

  // Build a subagent-specific config with overrides.
  const subConfig: AgentConfig = {
    ...config,
    model: def.model || config.model,
    maxTurns: def.maxTurns,
    autoCompactEnabled: false, // subagents are short-lived, no compaction needed
  };

  // The agent body becomes the system prompt; the Task prompt is the first user message.
  const history: Message[] = [];

  let result = '';
  let error: string | undefined;

  try {
    const updatedHistory = await runAgentLoop(
      subConfig,
      registry,
      `${def.body}\n\n## Task\n${prompt}`,
      history,
      {
        onText: (text) => {
          result += text;
        },
        onToolCall: () => {},
        onToolResult: () => {},
        onError: (err) => {
          error = err;
        },
        onTurnStart: () => {},
        onDone: () => {},
        onPermissionRequired: async () => 'deny',
        onUsage: () => {},
      },
      'bypassPermissions', // subagents run with bypass to avoid interactive prompts
      { isNewSession: true },
    );

    // Extract the last assistant message content from the history.
    for (let i = updatedHistory.length - 1; i >= 0; i--) {
      const m = updatedHistory[i];
      if (m.role === 'assistant' && m.content) {
        result = m.content;
        break;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Max turns reached is not a fatal error if the subagent produced output.
  if (error && result && error.includes('max turns')) {
    error = undefined;
  }

  return { content: result, error };
}
