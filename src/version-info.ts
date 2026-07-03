/**
 * /release-notes and /feedback helpers.
 *
 * /release-notes — show the installed package version, plus the CHANGELOG.md
 * tail if one exists in the workspace. There is no live release-feed fetch
 * (offline-first, like /cost); the CHANGELOG is the source of truth.
 *
 * /feedback — capture a minimal, non-secret session snapshot to a local file
 * under .book/feedback/ so the user can paste it into a bug report. Never
 * includes API keys or message bodies in full; it summarizes recent activity.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

/** Best-effort __dirname for ESM; undefined under tsx/tsup shim is fine. */
function thisDir(): string | null {
  try {
    return fileURLToPath(new URL('.', import.meta.url));
  } catch {
    return null;
  }
}

/** Load version from package.json (best-effort; the dist's location varies). */
export function getPackageVersion(): string {
  // package.json is at the workspace root in dev, and bundled by tsup in dist.
  const dir = thisDir();
  const candidates = [
    join(process.cwd(), 'package.json'),
    dir ? join(dir, '..', 'package.json') : '',
    dir ? join(dir, 'package.json') : '',
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf-8'));
      if (typeof pkg.version === 'string') return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return '(unknown)';
}

/** Read the tail of CHANGELOG.md from the workspace, if present. */
export function getChangelogTail(workspace: string, maxLines = 60): string | null {
  for (const name of ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md']) {
    const p = join(workspace, name);
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, 'utf-8');
      const lines = text.split('\n');
      return lines.slice(0, maxLines).join('\n').trim() || null;
    } catch {
      continue;
    }
  }
  return null;
}

/** Render /release-notes output. */
export function buildReleaseNotesReport(workspace: string): string {
  const version = getPackageVersion();
  const changelog = getChangelogTail(workspace);
  const lines: string[] = [`Book v${version}`];
  lines.push('');
  if (changelog) {
    lines.push('Changelog (top of file):');
    lines.push('─────────────────────────────');
    lines.push(changelog);
  } else {
    lines.push('No CHANGELOG.md found in this workspace.');
    lines.push(
      'Full release history is in the repository on disk (see git log for the version line).',
    );
  }
  return lines.join('\n');
}

export interface FeedbackContext {
  workspace: string;
  model: string;
  provider?: string;
  turn: number;
  messageCount: number;
  lastUserPromptPreview?: string;
  lastError?: string | null;
  /** Free-text body the user supplied after /feedback. */
  note?: string;
}

/** Capture a feedback snapshot to .book/feedback/<timestamp>.md and return its path. */
export function writeFeedbackReport(ctx: FeedbackContext): {
  ok: boolean;
  path?: string;
  error?: string;
} {
  try {
    const dir = join(ctx.workspace, '.book', 'feedback');
    mkdirSync(dir, { recursive: true });
    // Date is fine here — feedback writes are local-side side effects, the
    // workflow-script ban on Date.now() does not apply to runtime code.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `/feedback-${stamp}.md`.replace(/^\//, ''));
    const lines: string[] = [
      '# Book feedback report',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Environment',
      `- Workspace: ${ctx.workspace}`,
      `- Model: ${ctx.model}`,
      `- Provider: ${ctx.provider ?? '(auto)'}`,
      `- Last turn: ${ctx.turn}`,
      `- Messages in transcript: ${ctx.messageCount}`,
      '',
      '## User note',
      ctx.note ? ctx.note : '(none)',
      '',
      '## Last user prompt (preview, truncated)',
      ctx.lastUserPromptPreview ? ctx.lastUserPromptPreview.slice(0, 500) : '(none)',
      '',
      '## Last error',
      ctx.lastError ? ctx.lastError.slice(0, 500) : '(none)',
      '',
      '## Note',
      'This file contains no API keys or full transcripts. Review it before sharing.',
    ];
    writeFileSync(file, lines.join('\n'), 'utf-8');
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
