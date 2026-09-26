/**
 * /release-notes and /feedback helpers.
 *
 * /release-notes — show the installed version and its entry in Book's own
 * CHANGELOG.md, which ships in the package. There is no live release-feed fetch
 * (offline-first, like /cost); the CHANGELOG is the source of truth.
 *
 * /feedback — capture a minimal, non-secret session snapshot to a local file
 * under .book/feedback/ so the user can paste it into a bug report. Never
 * includes API keys or message bodies in full; it summarizes recent activity.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

declare const __BOOK_VERSION__: string | undefined;

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
  if (typeof __BOOK_VERSION__ === 'string' && __BOOK_VERSION__.length > 0) {
    return __BOOK_VERSION__;
  }
  // package.json is at the workspace root in dev, and bundled by tsup in dist.
  const dir = thisDir();
  const candidates = [
    dir ? join(dir, '..', 'package.json') : '',
    dir ? join(dir, 'package.json') : '',
    join(process.cwd(), 'package.json'),
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

/**
 * Book's own CHANGELOG.md. It ships beside `dist/`, and sits at the repository
 * root in development. The workspace's changelog is the user's project, not
 * Book: /release-notes used to print whatever CHANGELOG the current project
 * had, under the heading "Book v…".
 */
export function findBookChangelog(): string | null {
  const dir = thisDir();
  const candidates = [
    dir ? join(dir, '..', 'CHANGELOG.md') : '',
    dir ? join(dir, 'CHANGELOG.md') : '',
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Changes /release-notes lists before pointing at the file for the rest. */
const RELEASE_NOTES_ITEMS = 12;

/** A release entry reduced to what changed, one line per change. */
export interface ReleaseDigest {
  /** The section's heading: `[0.2.0] - 2026-09-08`. */
  heading: string;
  /** Markdown: a `### Added`-style heading per group, then a line per change. */
  lines: string[];
  /** Changes the digest left out. */
  hidden: number;
}

/**
 * The changelog entry for `version` as a digest: each change's bold lead (the
 * sentence a CHANGELOG entry opens with), under its group heading. The entry is
 * the `## [version]` section, or the first section for a build ahead of its
 * last release. A release's entry runs to hundreds of hard-wrapped lines; the
 * report used to print the first sixty of the file, cut mid-paragraph.
 */
export function releaseDigest(
  changelog: string,
  version: string,
  maxItems = RELEASE_NOTES_ITEMS,
): ReleaseDigest | null {
  const lines = changelog.split(/\r?\n/);
  const headings = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith('## '));
  if (headings.length === 0) return null;
  const target = headings.find(({ line }) => line.startsWith(`## [${version}]`)) ?? headings[0]!;
  const next = headings.find(({ index }) => index > target.index);
  const section = lines.slice(target.index + 1, next ? next.index : lines.length);

  // A change's text runs on over the hard-wrapped lines indented under its
  // bullet; its lead is taken once they are joined, or a first sentence that
  // crosses a line break is cut at the wrap.
  const raw: Array<{ group: string; text: string }> = [];
  let group = '';
  let open = false;
  for (const line of section) {
    if (line.startsWith('### ')) {
      group = line.slice(4).trim();
      open = false;
    } else if (line.startsWith('- ')) {
      raw.push({ group, text: line.slice(2).trim() });
      open = true;
    } else if (open && /^\s{2}\S/.test(line)) {
      raw[raw.length - 1]!.text += ` ${line.trim()}`;
    } else {
      open = false;
    }
  }
  const items = raw.map((item) => ({ group: item.group, text: changeLead(item.text) }));
  const shown = items.slice(0, maxItems);
  const out: string[] = [];
  let current: string | undefined;
  for (const item of shown) {
    if (item.group !== current) {
      if (item.group) out.push(`### ${item.group}`);
      current = item.group;
    }
    out.push(`- ${item.text}`);
  }
  return {
    heading: target.line.replace(/^##\s*/, ''),
    lines: out,
    hidden: items.length - shown.length,
  };
}

/** A change's lead: its bold opening sentence, or its first sentence. */
function changeLead(text: string): string {
  const bold = /^\*\*(.+?)\*\*/.exec(text);
  if (bold) return bold[1]!.trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text);
  const lead = (sentence ? sentence[1]! : text).trim();
  if (lead.length <= 100) return lead;
  // Cut at a word, and never inside a code span: an unpaired backtick turns
  // the rest of the line into code.
  let cut = lead.slice(0, 99).replace(/\s+\S*$/, '');
  if ((cut.match(/`/g) ?? []).length % 2 === 1) cut = cut.slice(0, cut.lastIndexOf('`')).trimEnd();
  return `${cut}…`;
}

/** Render /release-notes output. */
export function buildReleaseNotesReport(
  changelogPath: string | null = findBookChangelog(),
): string {
  const version = getPackageVersion();
  let text: string | null = null;
  if (changelogPath) {
    try {
      text = readFileSync(changelogPath, 'utf-8');
    } catch {
      text = null;
    }
  }
  const digest = text ? releaseDigest(text, version) : null;
  if (!digest) return `Book v${version}\n\nNo release notes ship with this build.`;
  const lines = [`Book v${version} · ${digest.heading}`, '', ...digest.lines];
  if (digest.hidden > 0) {
    lines.push('', `… ${digest.hidden} more changes in \`${changelogPath}\``);
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
