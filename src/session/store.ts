import {
  mkdirSync,
  appendFileSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  statSync,
} from 'fs';
import { join } from 'path';
import type { Message, SessionRecord } from '../types.js';

export interface SessionMeta {
  id: string;
  name?: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * JSONL session persistence. Each session is one file under <root>/<id>.jsonl.
 * The first line is a session_meta record; subsequent lines are event records
 * (user / assistant / tool_call / tool_result / usage). load() replays the
 * records into a Message[] history the agent loop can resume from.
 */
export class SessionStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }

  private path(id: string): string {
    return join(this.root, `${id}.jsonl`);
  }

  create(meta: { cwd: string; name?: string }): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    const header: SessionRecord = {
      type: 'session_meta',
      timestamp: now,
      data: {
        kind: 'session_meta',
        id,
        cwd: meta.cwd,
        name: meta.name,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      },
    };
    appendFileSync(this.path(id), JSON.stringify(header) + '\n', 'utf-8');
    return id;
  }

  append(id: string, record: SessionRecord): void {
    appendFileSync(this.path(id), JSON.stringify(record) + '\n', 'utf-8');
    // Update the meta header's updatedAt in place by rewriting the first line.
    this.bumpMeta(id, record.timestamp);
  }

  /** Rewrite the session_meta header with a new updatedAt. */
  private bumpMeta(id: string, updatedAt: number): void {
    const p = this.path(id);
    if (!existsSync(p)) return;
    const raw = readFileSync(p, 'utf-8');
    const lines = raw.split('\n');
    if (lines.length === 0) return;
    try {
      const meta = JSON.parse(lines[0]) as SessionRecord;
      if ((meta.data as { kind?: string })?.kind === 'session_meta') {
        (meta.data as { updatedAt: number }).updatedAt = updatedAt;
        lines[0] = JSON.stringify(meta);
        // Preserve the rest of the file (records), keep trailing newline state.
        const trailing = raw.endsWith('\n') ? '\n' : '';
        // Re-read original body after line 0 to avoid corrupting it.
        const body = lines.slice(1).join('\n');
        writeFileSync(p, lines[0] + '\n' + body + trailing, 'utf-8');
      }
    } catch {
      // non-fatal
    }
  }

  load(id: string): { history: Message[]; meta: SessionMeta } {
    const p = this.path(id);
    if (!existsSync(p)) throw new Error(`Session not found: ${id}`);
    const raw = readFileSync(p, 'utf-8');
    const records = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SessionRecord);

    const metaRec = records.find((r) => (r.data as { kind?: string })?.kind === 'session_meta');
    const meta: SessionMeta = metaRec
      ? (metaRec.data as SessionMeta)
      : { id, cwd: '', createdAt: 0, updatedAt: 0, messageCount: 0 };

    const history: Message[] = [];
    let count = 0;
    for (const r of records) {
      if ((r.data as { kind?: string })?.kind === 'session_meta') continue;
      count++;
      const data = r.data as { content?: string };
      if (r.type === 'user') {
        history.push({
          id: crypto.randomUUID(),
          role: 'user',
          content: data.content ?? '',
          timestamp: r.timestamp,
        });
      } else if (r.type === 'assistant') {
        const last = history[history.length - 1];
        if (last?.role === 'assistant') {
          last.content += data.content ?? '';
        } else {
          history.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: data.content ?? '',
            timestamp: r.timestamp,
          });
        }
      }
    }
    meta.messageCount = count;
    return { history, meta };
  }

  list(): SessionMeta[] {
    const metas: SessionMeta[] = [];
    for (const f of readdirSync(this.root)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.replace(/\.jsonl$/, '');
      try {
        const { meta } = this.load(id);
        metas.push(meta);
      } catch {
        // skip corrupt files
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  mostRecentInCwd(cwd: string): SessionMeta | undefined {
    return this.list().find((m) => m.cwd === cwd);
  }

  findByName(name: string): SessionMeta | undefined {
    return this.list().find((m) => m.name === name);
  }

  findById(id: string): SessionMeta | undefined {
    return this.list().find((m) => m.id === id);
  }

  cleanup(days: number): number {
    const cutoff = Date.now() - days * 86400_000;
    let removed = 0;
    for (const f of readdirSync(this.root)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.replace(/\.jsonl$/, '');
      try {
        const { meta } = this.load(id);
        if (meta.updatedAt < cutoff) {
          unlinkSync(this.path(id));
          removed++;
        }
      } catch {
        // corrupt file — remove if its mtime is old
        if (statSync(this.path(id)).mtimeMs < cutoff) {
          unlinkSync(this.path(id));
          removed++;
        }
      }
    }
    return removed;
  }
}
