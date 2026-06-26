import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

/**
 * Persisted permission rule store.
 * Matches Claude Code's rule evaluation order: deny → ask → allow. First match wins.
 */

export interface PermissionRule {
  id: string;
  toolName: string;
  /** Glob pattern matched against the tool's primary argument (e.g. 'git *'). Empty = all. */
  pattern?: string;
  scope: 'project' | 'session' | 'global';
  effect: 'allow' | 'deny' | 'ask';
  workspaceKey?: string;
  createdAt: number;
}

interface StoreData {
  rules: PermissionRule[];
}

const STORE_PATH = join(homedir(), '.book', 'permissions.json');

function workspaceKey(workspace: string): string {
  return workspace.replace(/[\\/:]+/g, '_');
}

function loadStore(): StoreData {
  try {
    if (existsSync(STORE_PATH)) {
      const raw = readFileSync(STORE_PATH, 'utf-8');
      return JSON.parse(raw) as StoreData;
    }
  } catch {
    // fall through to empty store
  }
  return { rules: [] };
}

function saveStore(data: StoreData): void {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // non-fatal: persistence is best-effort
  }
}

export class PermissionStore {
  private data: StoreData;

  constructor(private workspace: string) {
    this.data = loadStore();
  }

  /** Reload rules from disk. */
  reload(): void {
    this.data = loadStore();
  }

  /** Get all rules applicable to this workspace (session + project + global). Session rules are kept in-memory only. */
  private applicableRules(): PermissionRule[] {
    const key = workspaceKey(this.workspace);
    return this.data.rules.filter(
      (r) =>
        r.scope === 'global' ||
        r.scope === 'session' ||
        (r.scope === 'project' && r.workspaceKey === key),
    );
  }

  /**
   * Evaluate whether a tool call needs a permission prompt, per saved rules.
   * Returns the effect of the first matching rule, or 'ask' if no rule matches.
   * Evaluation order: deny → ask → allow (matching Claude Code).
   */
  evaluate(toolName: string, primaryArg: string): 'allow' | 'deny' | 'ask' {
    const rules = this.applicableRules();
    const order: ('deny' | 'ask' | 'allow')[] = ['deny', 'ask', 'allow'];
    for (const effect of order) {
      const match = rules.find(
        (r) => r.effect === effect && this.matches(r, toolName, primaryArg),
      );
      if (match) return effect;
    }
    return 'ask';
  }

  private matches(rule: PermissionRule, toolName: string, primaryArg: string): boolean {
    if (rule.toolName !== toolName) return false;
    if (!rule.pattern) return true;
    return this.globMatch(rule.pattern, primaryArg);
  }

  private globMatch(pattern: string, text: string): boolean {
    // Simple glob: '*' = any chars, otherwise literal substring match
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(text);
  }

  /** Persist an 'allow' rule from a 'Yes, don't ask again' choice. */
  allowAlways(toolName: string, pattern: string, scope: 'project' | 'session' = 'project'): void {
    const rule: PermissionRule = {
      id: crypto.randomUUID(),
      toolName,
      pattern,
      scope,
      workspaceKey: scope === 'project' ? workspaceKey(this.workspace) : undefined,
      effect: 'allow',
      createdAt: Date.now(),
    };
    // Avoid duplicates
    const dup = this.data.rules.find(
      (r) =>
        r.toolName === rule.toolName &&
        r.pattern === rule.pattern &&
        r.scope === rule.scope &&
        r.workspaceKey === rule.workspaceKey &&
        r.effect === 'allow',
    );
    if (!dup) {
      this.data.rules.push(rule);
      if (scope !== 'session') saveStore(this.data);
    }
  }
}