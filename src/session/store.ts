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
  /**
   * In-memory updatedAt cache. bumpMeta() is too expensive to run per event
   * (it reads and rewrites the whole growing file), so append() only tracks
   * the latest timestamp here. flushMeta() writes it to the header once,
   * at turn boundaries. load()/list() fall back to the last record's
   * timestamp so a crash mid-turn still sorts correctly.
   */
  private updatedAt = new Map<string, number>();

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
    // Track the latest timestamp in memory only; flushMeta() persists it
    // to the header at turn boundaries (see onDone/onTurnStart callers).
    const cur = this.updatedAt.get(id);
    if (cur === undefined || record.timestamp > cur) {
      this.updatedAt.set(id, record.timestamp);
    }
  }

  /** Persist the tracked updatedAt to the session_meta header. Call at turn boundaries. */
  flushMeta(id: string): void {
    const updatedAt = this.updatedAt.get(id);
    if (updatedAt === undefined) return;
    const p = this.path(id);
    if (!existsSync(p)) return;
    let raw: string;
    try {
      raw = readFileSync(p, 'utf-8');
    } catch {
      return;
    }
    const lines = raw.split('\n');
    if (lines.length === 0) return;
    try {
      const meta = JSON.parse(lines[0]) as SessionRecord;
      if ((meta.data as { kind?: string })?.kind === 'session_meta') {
        (meta.data as { updatedAt: number }).updatedAt = updatedAt;
        lines[0] = JSON.stringify(meta);
        const body = lines.slice(1).join('\n');
        const trailing = raw.endsWith('\n') ? '\n' : '';
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

    // Effective updatedAt = the last persisted record's timestamp (line 0 is
    // always the meta header, so records[last] is the freshest write). This
    // keeps list()/cleanup() correct even if flushMeta() never ran (e.g. a
    // crash mid-turn) and preserves sort-by-activity for sessions whose record
    // timestamps predate their createdAt (synthetic/test timestamps).
    if (records.length) {
      meta.updatedAt = records[records.length - 1].timestamp;
      this.updatedAt.set(id, meta.updatedAt);
    }

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
