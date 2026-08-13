import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { resolveBookHome } from './book-home.js';
import type { SkillActivation, SkillExecution } from './settings.js';

export const SKILL_ENTRY_FILENAME = 'SKILL.md';
export const MAX_SKILL_HEADER_BYTES = 64 * 1024;
export const MAX_SKILL_BODY_BYTES = 100 * 1024;
export const MAX_SKILL_RESOURCES = 200;
export const MAX_SKILL_RESOURCE_DEPTH = 4;
export const MAX_SKILL_RESOURCE_BYTES = 2 * 1024 * 1024;

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KNOWN_FRONTMATTER_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'version',
  'metadata',
  'allowed-tools',
  'tools',
  'when_to_use',
  'model',
  'lifetime',
  'disabled',
  // Interoperable Claude/Codex skill metadata. Invocation controls are
  // advisory to Book's explicit `$name` UI and do not grant permissions.
  'disable-model-invocation',
  'user-invocable',
  'argument-hint',
]);

export type SkillSource = 'user' | 'project';
export type SkillRootKind = 'book' | 'agents' | 'claude' | 'opencode';
export type SkillIssueSeverity = 'error' | 'warning';

export interface SkillIssue {
  code: string;
  message: string;
  severity: SkillIssueSeverity;
}

export interface SkillResource {
  relativePath: string;
  byteSize: number;
  mtimeMs: number;
  digest: string;
}

export interface ShadowedSkill {
  path: string;
  source: SkillSource;
  rootKind: SkillRootKind;
}

/** Metadata discovered without retaining or injecting the SKILL.md body. */
export interface Skill {
  id: string;
  version: string;
  descriptorDigest: string;
  resourceDigest: string;
  name: string;
  description: string;
  whenToUse?: string;
  license?: string;
  compatibility?: string;
  metadata: Record<string, string>;
  /** Requested tool ceiling. It never grants permission by itself. */
  allowedTools?: string[];
  model?: string;
  lifetime: 'turn' | 'run';
  /** Absolute path to the skill entrypoint. */
  path: string;
  /** Absolute directory that owns the skill and its resources. */
  rootPath: string;
  source: SkillSource;
  rootKind: SkillRootKind;
  activation: SkillActivation;
  execution: SkillExecution;
  invocationCount: number;
  entryByteSize: number;
  entryMtimeMs: number;
  resources: SkillResource[];
  issues: SkillIssue[];
  valid: boolean;
  shadowed: ShadowedSkill[];
}

export interface LoadedSkillBody {
  body: string;
  digest: string;
  byteSize: number;
}

export interface SkillRoot {
  path: string;
  source: SkillSource;
  kind: SkillRootKind;
}

export interface DiscoverSkillsOptions {
  homeDir?: string;
  bookHomeDir?: string;
  includeUser?: boolean;
  projectRoot?: string;
  includeOpenCode?: boolean;
  enabled?: boolean;
  executionOverrides?: Readonly<Record<string, SkillExecution>>;
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function projectRootFor(workspace: string): string {
  let current = resolve(workspace);
  const filesystemRoot = parse(current).root;
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    if (current === filesystemRoot) return resolve(workspace);
    current = dirname(current);
  }
}

function directoriesFromRoot(root: string, workspace: string): string[] {
  const normalizedRoot = resolve(root);
  const normalizedWorkspace = resolve(workspace);
  if (!isInside(normalizedRoot, normalizedWorkspace)) return [normalizedWorkspace];
  const directories: string[] = [];
  let current = normalizedWorkspace;
  while (true) {
    directories.push(current);
    if (pathKey(current) === pathKey(normalizedRoot)) break;
    current = dirname(current);
  }
  return directories.reverse();
}

/** Roots are ordered from lowest to highest precedence. */
export function skillRoots(workspace: string, options: DiscoverSkillsOptions = {}): SkillRoot[] {
  const roots: SkillRoot[] = [];
  if (options.includeUser !== false) {
    const home = options.homeDir ?? homedir();
    const bookHome =
      options.bookHomeDir ?? (options.homeDir ? join(home, '.book') : resolveBookHome());
    roots.push(
      { path: join(home, '.claude', 'skills'), source: 'user', kind: 'claude' },
      { path: join(home, '.agents', 'skills'), source: 'user', kind: 'agents' },
      ...(options.includeOpenCode === false
        ? []
        : [
            {
              path: join(home, '.config', 'opencode', 'skills'),
              source: 'user' as const,
              kind: 'opencode' as const,
            },
          ]),
      { path: join(bookHome, 'skills'), source: 'user', kind: 'book' },
    );
  }

  const projectRoot = options.projectRoot ?? projectRootFor(workspace);
  for (const directory of directoriesFromRoot(projectRoot, workspace)) {
    roots.push(
      { path: join(directory, '.claude', 'skills'), source: 'project', kind: 'claude' },
      { path: join(directory, '.agents', 'skills'), source: 'project', kind: 'agents' },
      ...(options.includeOpenCode === false
        ? []
        : [
            {
              path: join(directory, '.opencode', 'skills'),
              source: 'project' as const,
              kind: 'opencode' as const,
            },
          ]),
      { path: join(directory, '.book', 'skills'), source: 'project', kind: 'book' },
    );
  }
  const byPath = new Map<string, SkillRoot>();
  for (const root of roots) byPath.set(pathKey(root.path), root);
  return [...byPath.values()];
}

function readFrontmatterPrefix(path: string): {
  frontmatter: Record<string, unknown>;
  headerText: string;
  issues: SkillIssue[];
} {
  const issues: SkillIssue[] = [];
  const fd = openSync(path, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < MAX_SKILL_HEADER_BYTES) {
      const chunk = Buffer.alloc(Math.min(4096, MAX_SKILL_HEADER_BYTES - total));
      const count = readSync(fd, chunk, 0, chunk.length, total);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
      const text = Buffer.concat(chunks).toString('utf8');
      if (/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) {
        const match = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
        const headerText = match?.[0] ?? '';
        return { frontmatter: parseFrontmatter(headerText).frontmatter, headerText, issues };
      }
    }
  } finally {
    closeSync(fd);
  }
  issues.push({
    code: 'invalid_frontmatter',
    message: `Missing YAML frontmatter or closing delimiter within ${MAX_SKILL_HEADER_BYTES} bytes.`,
    severity: 'error',
  });
  return { frontmatter: {}, headerText: '', issues };
}

function stringField(frontmatter: Record<string, unknown>, name: string): string | undefined {
  const value = frontmatter[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function metadataFromHeader(headerText: string): Record<string, string> {
  const lines = headerText.split(/\r?\n/);
  const metadata: Record<string, string> = {};
  const start = lines.findIndex((line) => /^metadata\s*:\s*$/.test(line.trim()));
  if (start < 0) return metadata;
  for (const line of lines.slice(start + 1)) {
    if (/^---\s*$/.test(line)) break;
    if (line.trim() && !/^\s+/.test(line)) break;
    const match = line.match(/^\s+([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    metadata[match[1]] = match[2].replace(/^["'](.*)["']$/, '$1');
  }
  return metadata;
}

function allowedToolsFrom(frontmatter: Record<string, unknown>): string[] | undefined {
  const value = frontmatter['allowed-tools'] ?? frontmatter.tools;
  if (Array.isArray(value)) {
    const tools = value
      .map(String)
      .map((tool) => tool.trim())
      .filter(Boolean);
    return tools.length ? tools : undefined;
  }
  if (typeof value === 'string') {
    const tools = value.match(/[^\s]+(?:\([^)]*\))?/g)?.map((tool) => tool.trim()) ?? [];
    return tools.length ? tools : undefined;
  }
  return undefined;
}

function collectResources(
  rootPath: string,
  entryPath: string,
): {
  resources: SkillResource[];
  issues: SkillIssue[];
} {
  const resources: SkillResource[] = [];
  const issues: SkillIssue[] = [];
  let depthLimitReported = false;
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_SKILL_RESOURCE_DEPTH) {
      if (!depthLimitReported) {
        depthLimitReported = true;
        issues.push({
          code: 'resource_depth_limit',
          message: `Resources deeper than ${MAX_SKILL_RESOURCE_DEPTH} directories are ignored.`,
          severity: 'warning',
        });
      }
      return;
    }
    if (resources.length >= MAX_SKILL_RESOURCES) return;
    let entries: string[];
    try {
      entries = readdirSync(directory).sort();
    } catch (error) {
      issues.push({
        code: 'resource_unreadable',
        message: `Could not inspect resources in ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'warning',
      });
      return;
    }
    for (const entry of entries) {
      if (resources.length >= MAX_SKILL_RESOURCES) break;
      const fullPath = join(directory, entry);
      if (pathKey(fullPath) === pathKey(entryPath)) continue;
      let info;
      try {
        info = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) {
        issues.push({
          code: 'resource_symlink_ignored',
          message: `Ignored symbolic-link resource: ${relative(rootPath, fullPath)}`,
          severity: 'warning',
        });
        continue;
      }
      if (info.isDirectory()) {
        visit(fullPath, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      let digest = createHash('sha256')
        .update(`unavailable:${info.size}:${info.mtimeMs}`)
        .digest('hex');
      if (info.size > MAX_SKILL_RESOURCE_BYTES) {
        issues.push({
          code: 'resource_too_large',
          message: `Resource exceeds ${MAX_SKILL_RESOURCE_BYTES} bytes: ${relative(rootPath, fullPath)}`,
          severity: 'warning',
        });
      }
      try {
        const fd = openSync(fullPath, 'r');
        try {
          const prefix = Buffer.alloc(Math.min(info.size, 8192));
          const read = readSync(fd, prefix, 0, prefix.length, 0);
          if (prefix.subarray(0, read).includes(0)) {
            issues.push({
              code: 'binary_resource',
              message: `Binary resource cannot be loaded into model context: ${relative(rootPath, fullPath)}`,
              severity: 'warning',
            });
          }
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        issues.push({
          code: 'resource_unreadable',
          message: `Could not validate resource ${relative(rootPath, fullPath)}: ${error instanceof Error ? error.message : String(error)}`,
          severity: 'warning',
        });
      }
      if (info.size <= MAX_SKILL_RESOURCE_BYTES) {
        try {
          digest = createHash('sha256').update(readFileSync(fullPath)).digest('hex');
        } catch {
          // The visible unreadable-resource issue above is the actionable diagnostic.
        }
      }
      resources.push({
        relativePath: relative(rootPath, fullPath).split(sep).join('/'),
        byteSize: info.size,
        mtimeMs: info.mtimeMs,
        digest,
      });
    }
  };
  visit(rootPath, 1);
  if (resources.length >= MAX_SKILL_RESOURCES) {
    issues.push({
      code: 'resource_limit',
      message: `Only the first ${MAX_SKILL_RESOURCES} resources are available.`,
      severity: 'warning',
    });
  }
  return { resources, issues };
}

function descriptorFromEntry(
  entryPath: string,
  root: SkillRoot,
  directoryName: string,
  flat = false,
): Skill {
  const { frontmatter, headerText, issues: headerIssues } = readFrontmatterPrefix(entryPath);
  const issues = [...headerIssues];
  const declaredName = stringField(frontmatter, 'name');
  const name = declaredName ?? directoryName;
  const description = stringField(frontmatter, 'description') ?? '';

  if (!SKILL_NAME_PATTERN.test(name) || name.length > 64) {
    issues.push({
      code: 'invalid_name',
      message: 'Skill names must be 1-64 lowercase letters, numbers, or single hyphens.',
      severity: 'error',
    });
  }
  if (!flat && declaredName !== directoryName) {
    issues.push({
      code: 'name_directory_mismatch',
      message: `Declared name "${declaredName ?? '(missing)'}" must match directory "${directoryName}".`,
      severity: 'error',
    });
  }
  if (!declaredName && flat) {
    issues.push({
      code: 'legacy_flat_skill',
      message: 'Flat .skill.md files are supported for compatibility; use <name>/SKILL.md.',
      severity: 'warning',
    });
  }
  if (!description || description.length > 1024) {
    issues.push({
      code: 'invalid_description',
      message: 'Skill description is required and must be at most 1024 characters.',
      severity: 'error',
    });
  }
  const compatibility = stringField(frontmatter, 'compatibility');
  if (compatibility && compatibility.length > 500) {
    issues.push({
      code: 'invalid_compatibility',
      message: 'Skill compatibility must be at most 500 characters.',
      severity: 'error',
    });
  }
  const whenToUse = stringField(frontmatter, 'when_to_use');
  if (whenToUse && whenToUse.length > 1024) {
    issues.push({
      code: 'invalid_when_to_use',
      message: 'Skill when_to_use must be at most 1024 characters.',
      severity: 'error',
    });
  }
  const model = stringField(frontmatter, 'model');
  if (model) {
    issues.push({
      code: 'unsupported_model_hint',
      message: 'The model field is retained for compatibility but does not change Book models.',
      severity: 'warning',
    });
  }
  const requestedLifetime = stringField(frontmatter, 'lifetime');
  if (requestedLifetime && requestedLifetime !== 'run' && requestedLifetime !== 'turn') {
    issues.push({
      code: 'invalid_lifetime',
      message: 'Skill lifetime must be run or turn; Book will use run.',
      severity: 'warning',
    });
  }
  const lifetime = requestedLifetime === 'turn' ? 'turn' : 'run';
  for (const field of Object.keys(frontmatter)) {
    if (!KNOWN_FRONTMATTER_FIELDS.has(field)) {
      issues.push({
        code: 'unknown_frontmatter_field',
        message: `Unknown frontmatter field: ${field}`,
        severity: 'warning',
      });
    }
  }

  let entryByteSize = 0;
  let entryMtimeMs = 0;
  try {
    const entryInfo = statSync(entryPath);
    entryByteSize = entryInfo.size;
    entryMtimeMs = entryInfo.mtimeMs;
    if (entryByteSize > MAX_SKILL_BODY_BYTES + MAX_SKILL_HEADER_BYTES) {
      issues.push({
        code: 'body_too_large',
        message: `SKILL.md exceeds the ${MAX_SKILL_BODY_BYTES}-byte body budget.`,
        severity: 'error',
      });
    }
  } catch {
    issues.push({
      code: 'skill_unreadable',
      message: 'Skill entrypoint is unreadable.',
      severity: 'error',
    });
  }

  const rootPath = dirname(entryPath);
  const resourceResult = flat
    ? { resources: [] as SkillResource[], issues: [] as SkillIssue[] }
    : collectResources(rootPath, entryPath);
  issues.push(...resourceResult.issues);

  const metadata = metadataFromHeader(headerText);
  const version = stringField(frontmatter, 'version') ?? metadata.version ?? 'unversioned';
  const resourceDigest = createHash('sha256')
    .update(JSON.stringify(resourceResult.resources))
    .digest('hex');
  const descriptorDigest = createHash('sha256')
    .update(
      JSON.stringify({
        name,
        description,
        whenToUse,
        version,
        source: root.source,
        rootKind: root.kind,
        path: pathKey(entryPath),
        allowedTools: allowedToolsFrom(frontmatter),
        lifetime,
        resourceDigest,
      }),
    )
    .digest('hex');

  return {
    id: `${root.kind}:${pathKey(entryPath)}`,
    version,
    descriptorDigest,
    resourceDigest,
    name,
    description,
    whenToUse,
    license: stringField(frontmatter, 'license'),
    compatibility,
    metadata,
    allowedTools: allowedToolsFrom(frontmatter),
    model,
    lifetime,
    path: entryPath,
    rootPath,
    source: root.source,
    rootKind: root.kind,
    activation: String(frontmatter.disabled).toLowerCase() === 'true' ? 'off' : 'manual',
    execution: 'inherit',
    invocationCount: 0,
    entryByteSize,
    entryMtimeMs,
    resources: resourceResult.resources,
    issues,
    valid: !issues.some((issue) => issue.severity === 'error'),
    shadowed: [],
  };
}

function skillsUnderRoot(root: SkillRoot): Skill[] {
  if (!existsSync(root.path)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root.path).sort();
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    const fullPath = join(root.path, entry);
    let info;
    try {
      info = lstatSync(fullPath);
    } catch {
      continue;
    }
    let directory = info.isDirectory();
    if (info.isSymbolicLink()) {
      try {
        directory = statSync(fullPath).isDirectory();
      } catch {
        continue;
      }
    }
    if (directory) {
      const entryPath = join(fullPath, SKILL_ENTRY_FILENAME);
      if (existsSync(entryPath) && statSync(entryPath).isFile()) {
        skills.push(descriptorFromEntry(entryPath, root, entry));
      }
    } else if (info.isFile() && entry.endsWith('.skill.md')) {
      skills.push(descriptorFromEntry(fullPath, root, entry.replace(/\.skill\.md$/, ''), true));
    }
  }
  return skills;
}

export function discoverSkills(
  workspace: string,
  overrides: Readonly<Record<string, SkillActivation>> = {},
  options: DiscoverSkillsOptions = {},
): Skill[] {
  const byName = new Map<string, Skill>();
  for (const root of skillRoots(workspace, options)) {
    for (const skill of skillsUnderRoot(root)) {
      const previous = byName.get(skill.name);
      if (previous) {
        skill.shadowed = [
          ...previous.shadowed,
          { path: previous.path, source: previous.source, rootKind: previous.rootKind },
        ];
      }
      byName.set(skill.name, skill);
    }
  }
  return applySkillOverrides(
    [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    overrides,
    options.executionOverrides ?? {},
    options.enabled ?? true,
  );
}

export function applySkillOverrides(
  skills: readonly Skill[],
  overrides: Readonly<Record<string, SkillActivation>>,
  executionOverrides: Readonly<Record<string, SkillExecution>> = {},
  enabled = true,
): Skill[] {
  return skills.map((skill) => ({
    ...skill,
    activation: enabled ? (overrides[skill.name] ?? skill.activation ?? 'manual') : 'off',
    execution: executionOverrides[skill.name] ?? skill.execution ?? 'inherit',
  }));
}

export function loadSkillBody(skill: Skill): LoadedSkillBody {
  if (!skill.valid) throw new Error(`Skill "${skill.name}" is invalid.`);
  const canonicalRoot = realpathSync(skill.rootPath);
  const canonicalEntry = realpathSync(skill.path);
  if (!isInside(canonicalRoot, canonicalEntry)) {
    throw new Error(`Skill entrypoint escapes its root: ${skill.path}`);
  }
  const current = statSync(canonicalEntry);
  if (current.size !== skill.entryByteSize || current.mtimeMs !== skill.entryMtimeMs) {
    throw new Error(`Skill "${skill.name}" changed after discovery; reload skills before use.`);
  }
  const buffer = readFileSync(canonicalEntry);
  if (buffer.includes(0)) {
    throw new Error(`Skill "${skill.name}" contains binary content.`);
  }
  const raw = buffer.toString('utf8');
  const { body } = parseFrontmatter(raw);
  const byteSize = Buffer.byteLength(body);
  if (byteSize > MAX_SKILL_BODY_BYTES) {
    throw new Error(`Skill body exceeds ${MAX_SKILL_BODY_BYTES} bytes.`);
  }
  return {
    body,
    digest: createHash('sha256').update(body).digest('hex'),
    byteSize,
  };
}

export interface SkillListingResult {
  text: string;
  budgetChars: number;
  visibleCount: number;
  included: string[];
  omitted: string[];
  collapsed: string[];
  charCount: number;
}

export function buildSkillListing(
  skills: readonly Skill[],
  budgetChars = 8000,
): SkillListingResult {
  const visible = skills.filter(
    (skill) => skill.valid && (skill.activation === 'auto' || skill.activation === 'name-only'),
  );
  if (visible.length === 0) {
    return {
      text: '',
      budgetChars,
      visibleCount: 0,
      included: [],
      omitted: [],
      collapsed: [],
      charCount: 0,
    };
  }

  const sorted = [...visible].sort(
    (a, b) => b.invocationCount - a.invocationCount || a.name.localeCompare(b.name),
  );
  const lines = [
    '## Available skills',
    'Use InvokeSkill when a request matches a description. A user can force exact use with `$skill-name`.',
  ];
  let remainingBudget = budgetChars - lines.join('\n').length;
  const includedNames: string[] = [];
  const collapsedNames = new Set<string>();

  let included = 0;
  for (const skill of sorted) {
    if (skill.activation === 'name-only') {
      const bare = `- **${skill.name}**`;
      if (bare.length > remainingBudget) break;
      lines.push(bare);
      remainingBudget -= bare.length + 1;
      included++;
      includedNames.push(skill.name);
      collapsedNames.add(skill.name);
      continue;
    }
    const entry = `- **${skill.name}**: ${skill.description}`;
    const trigger = skill.whenToUse ? `\n  when: ${skill.whenToUse}` : '';
    const full = `${entry}${trigger}`;
    if (full.length > remainingBudget) {
      const bare = `- **${skill.name}**`;
      if (bare.length <= remainingBudget) {
        lines.push(bare);
        included++;
        includedNames.push(skill.name);
        collapsedNames.add(skill.name);
      }
      break;
    }
    lines.push(full);
    remainingBudget -= full.length + 1;
    included++;
    includedNames.push(skill.name);
  }
  let omitted = sorted.length - included;
  if (omitted > 0) {
    let warning = `- ${omitted} additional skill${omitted === 1 ? ' was' : 's were'} omitted from this prompt budget. Use /skills to inspect the full catalog.`;
    while (warning.length > remainingBudget && lines.length > 2) {
      const removed = lines.pop();
      if (!removed) break;
      remainingBudget += removed.length + 1;
      included--;
      const removedName = includedNames.pop();
      if (removedName) collapsedNames.delete(removedName);
      omitted = sorted.length - included;
      warning = `- ${omitted} additional skill${omitted === 1 ? ' was' : 's were'} omitted from this prompt budget. Use /skills to inspect the full catalog.`;
    }
    if (warning.length <= remainingBudget) lines.push(warning);
  }
  const text = lines.join('\n');
  const includedSet = new Set(includedNames);
  return {
    text,
    budgetChars,
    visibleCount: sorted.length,
    included: includedNames,
    omitted: sorted.filter((skill) => !includedSet.has(skill.name)).map((skill) => skill.name),
    collapsed: includedNames.filter((name) => collapsedNames.has(name)),
    charCount: text.length,
  };
}

export function generateSkillListing(skills: readonly Skill[], budgetChars = 8000): string {
  return buildSkillListing(skills, budgetChars).text;
}

export function explicitSkillMentions(prompt: string, skills: readonly Skill[]): string[] {
  const available = new Set(skills.map((skill) => skill.name));
  const mentions: string[] = [];
  const pattern = /(?<![A-Za-z0-9_-])\$([a-z0-9]+(?:-[a-z0-9]+)*)(?![A-Za-z0-9_-])/g;
  for (const match of prompt.matchAll(pattern)) {
    const name = match[1];
    if (available.has(name) && !mentions.includes(name)) mentions.push(name);
  }
  return mentions;
}
