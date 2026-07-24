import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { parseFrontmatter } from '../frontmatter.js';
import { normalizeAgentTool } from '../subagent-discovery.js';

const MUTATION_TOOLS = new Set([
  'ApplyPatch',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
]);
const SAFE_AGENT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function assertSafeAgentName(name: string): void {
  if (!SAFE_AGENT_NAME.test(name) || name === '.' || name === '..') {
    throw new Error(
      `Unsafe agent name "${name}". Names must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens.`,
    );
  }
}

export interface AgentImportPreview {
  sourcePath: string;
  name: string;
  description: string;
  body: string;
  tools: string[];
  unsupportedTools: string[];
  missingTools: boolean;
  model?: string;
  maxTurns?: number;
  warnings: string[];
}

function sourceFiles(path: string): string[] {
  if (!existsSync(path)) throw new Error(`Agent import path does not exist: ${path}`);
  if (statSync(path).isFile()) return extname(path) === '.md' ? [path] : [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && extname(entry.name) === '.md') files.push(fullPath);
    }
  };
  visit(path);
  return files.sort();
}

function rawTools(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((tool) => tool.trim())
      .filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean);
  return [];
}

export function previewAgentImport(path: string): AgentImportPreview[] {
  return sourceFiles(path).map((sourcePath) => {
    const { body, frontmatter } = parseFrontmatter(readFileSync(sourcePath, 'utf8'));
    const requestedTools = rawTools(frontmatter.tools ?? frontmatter['allowed-tools']);
    const tools = requestedTools
      .map(normalizeAgentTool)
      .filter((tool): tool is string => Boolean(tool));
    const unsupportedTools = requestedTools.filter((tool) => !normalizeAgentTool(tool));
    const name = String(frontmatter.name ?? basename(sourcePath, '.md'));
    const description = String(frontmatter.description ?? name);
    const warnings: string[] = [];
    if (!SAFE_AGENT_NAME.test(name) || name === '.' || name === '..') {
      warnings.push(`Unsafe agent name: ${name}. Installation will be refused.`);
    }
    if (requestedTools.length === 0)
      warnings.push('No tools were declared; the imported profile denies all tools.');
    if (unsupportedTools.length > 0)
      warnings.push(`Unsupported tools: ${unsupportedTools.join(', ')}.`);
    const readOnlyNominal = /explor|review|research|read.?only/i.test(`${name} ${description}`);
    const risky = tools.filter((tool) => MUTATION_TOOLS.has(tool.split('(')[0]));
    if (readOnlyNominal && risky.length > 0) {
      warnings.push(`Nominally read-only profile includes mutation tools: ${risky.join(', ')}.`);
    }
    const modelValue = typeof frontmatter.model === 'string' ? frontmatter.model.trim() : undefined;
    return {
      sourcePath,
      name,
      description,
      body,
      tools: Array.from(new Set(tools)),
      unsupportedTools,
      missingTools: requestedTools.length === 0,
      model: modelValue && modelValue !== 'inherit' ? modelValue : undefined,
      maxTurns:
        typeof frontmatter.maxTurns === 'number'
          ? frontmatter.maxTurns
          : typeof frontmatter.maxTurns === 'string'
            ? Number.parseInt(frontmatter.maxTurns, 10) || undefined
            : undefined,
      warnings,
    };
  });
}

export function installAgentImports(
  previews: AgentImportPreview[],
  targetDirectory: string,
): string[] {
  const names = new Set<string>();
  const targets = previews.map((preview) => {
    assertSafeAgentName(preview.name);
    if (names.has(preview.name)) {
      throw new Error(`Duplicate imported agent name: ${preview.name}.`);
    }
    names.add(preview.name);
    const target = join(targetDirectory, `${preview.name}.md`);
    if (existsSync(target)) {
      throw new Error(`Agent definition already exists: ${target}. Remove or rename it first.`);
    }
    return target;
  });
  mkdirSync(targetDirectory, { recursive: true });
  return previews.map((preview, index) => {
    const target = targets[index];
    const frontmatter = [
      '---',
      `name: ${preview.name}`,
      `description: ${preview.description}`,
      'tools:',
      ...preview.tools.map((tool) => `- ${tool}`),
      ...(preview.model ? [`model: ${preview.model}`] : []),
      ...(preview.maxTurns ? [`maxTurns: ${preview.maxTurns}`] : []),
      '---',
      preview.body,
      '',
    ].join('\n');
    writeFileSync(target, frontmatter, { encoding: 'utf8', flag: 'wx' });
    return target;
  });
}
