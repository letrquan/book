import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../session/store.js';
import { buildSessionStatus, renderSessionStatus, runStatusCommand } from './status-cmd.js';
import type { SessionRecord } from '../types/sessions.js';

const dirs: string[] = [];

function store(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'book-status-'));
  dirs.push(dir);
  return new SessionStore(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function userRecord(content: string, kind = 'conversation'): SessionRecord {
  return {
    type: 'user',
    eventId: `u-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    data: { content, kind, includeInContext: true },
  };
}

function capture(): { write: (t: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { write: (t) => void chunks.push(t), text: () => chunks.join('') };
}

describe('book status', () => {
  it('reports the byte-exact original objective, not a summary', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('migrate every call site off framework X'));
    s.append(id, {
      type: 'assistant',
      eventId: 'a-1',
      timestamp: Date.now(),
      data: { id: 'a-1', complete: true, content: 'working' },
    });

    const status = buildSessionStatus(s.findById(id)!, s.load(id));
    expect(status.objective).toBe('migrate every call site off framework X');
  });

  it('ignores host-authored user turns when identifying the objective', () => {
    // Continuation and work-state messages are user-role but nobody asked for
    // them; treating one as the objective would misreport what the run is doing.
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('[continuation] You stopped without finishing.'));
    s.append(id, userRecord('[work-state] Current plan, restated by the host.'));
    s.append(id, userRecord('the real objective'));

    expect(buildSessionStatus(s.findById(id)!, s.load(id)).objective).toBe('the real objective');
  });

  it('sums spend across the session and prices it as an upper bound', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('do the work'));
    for (const promptTokens of [1_000, 2_000]) {
      s.append(id, {
        type: 'usage',
        timestamp: Date.now(),
        data: {
          version: 1,
          usage: { promptTokens, completionTokens: 100, totalTokens: promptTokens + 100 },
          responseModel: 'claude-sonnet-5',
        },
      });
    }

    const status = buildSessionStatus(s.findById(id)!, s.load(id));
    expect(status.usage).toMatchObject({ promptTokens: 3_000, completionTokens: 200 });
    // (3000*3 + 200*15) / 1e6
    expect(status.costUsd).toBeCloseTo(0.012, 6);
  });

  it('says so rather than guessing when a model cannot be priced', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, {
      type: 'usage',
      timestamp: Date.now(),
      data: {
        version: 1,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        responseModel: 'some-local-model',
      },
    });

    const status = buildSessionStatus(s.findById(id)!, s.load(id));
    expect(status.costUsd).toBeNull();
    expect(renderSessionStatus(status)).toContain('pricing unknown');
  });

  it('reports the restored plan and the compaction generation', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('long job'));
    s.append(id, {
      type: 'plan',
      timestamp: Date.now(),
      data: {
        version: 1,
        todos: [
          { content: 'done bit', status: 'completed' },
          { content: 'open bit', status: 'in_progress' },
        ],
      },
    });

    const status = buildSessionStatus(s.findById(id)!, s.load(id));
    expect(status.plan?.todos).toHaveLength(2);

    const rendered = renderSessionStatus(status);
    expect(rendered).toContain('1 open todo(s)');
    expect(rendered).toContain('open bit');
    expect(rendered).not.toContain('done bit');
    expect(rendered).toContain('never compacted');
  });

  it('exits non-zero and explains when no session matches', () => {
    const out = capture();
    const code = runStatusCommand({
      workspace: join(tmpdir(), 'book-status-empty'),
      store: store(),
      stdout: out,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('No session has run');
  });

  it('emits machine-readable JSON on request', () => {
    const s = store();
    const id = s.create({ cwd: process.cwd() });
    s.append(id, userRecord('an objective'));

    const out = capture();
    const code = runStatusCommand({
      session: id,
      workspace: process.cwd(),
      json: true,
      store: s,
      stdout: out,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toMatchObject({ sessionId: id, objective: 'an objective' });
  });
});
