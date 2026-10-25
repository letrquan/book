import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completeInBrowser,
  createChatGptOAuthFixture,
  type ChatGptOAuthFixture,
} from '../test/chatgpt-oauth-fixture.js';
import { loginWithChatGptInTui, logoutOfChatGptInTui } from './chatgpt-auth.js';
import type { ProviderSaveRequest } from './model-options.js';

let home: string;
let previousHome: string | undefined;
let fixture: ChatGptOAuthFixture;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'book-chatgpt-tui-'));
  previousHome = process.env.BOOK_HOME;
  process.env.BOOK_HOME = home;
  fixture = await createChatGptOAuthFixture();
});

afterEach(async () => {
  await fixture.close();
  if (previousHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function host() {
  const notes: string[] = [];
  const saves: ProviderSaveRequest[] = [];
  return {
    notes,
    saves,
    host: {
      workspace: home,
      note: (message: string) => notes.push(message),
      saveProvider: (request: ProviderSaveRequest) => {
        saves.push(request);
        return { ok: true };
      },
      env: {
        BOOK_CHATGPT_ISSUER: fixture.issuer,
        BOOK_CHATGPT_API_BASE: fixture.apiBase,
      },
      openBrowser: (url: string) => completeInBrowser(url),
    },
  };
}

describe('/login and /logout in the TUI', () => {
  it("signs in, shows the plan notice once, and saves the plan's models without activating one", async () => {
    const { notes, saves, host: tui } = host();
    await loginWithChatGptInTui(tui);
    expect(notes[0]).toMatch(/Continue with ChatGPT in your browser/);
    expect(notes[0]).not.toMatch(/id_token_hint/);
    expect(notes[1]).toMatch(/Signed in with ChatGPT as user@example\.com/);
    expect(notes[1]).toMatch(/You're using your ChatGPT plan/);
    expect(notes[1]).toContain('https://chatgpt.com/settings/usage');
    expect(saves).toEqual([
      expect.objectContaining({
        providerId: 'chatgpt',
        type: 'chatgpt',
        apiKey: '',
        models: [{ id: 'gpt-fixture', label: 'GPT Fixture' }],
        activate: false,
      }),
    ]);

    const second = host();
    await loginWithChatGptInTui(second.host);
    expect(second.notes[1]).not.toMatch(/You're using your ChatGPT plan/);

    const out = host();
    await logoutOfChatGptInTui(out.host);
    expect(out.notes).toEqual([
      expect.stringMatching(/Signed out of ChatGPT: the sign-in is revoked/),
    ]);
    await logoutOfChatGptInTui(out.host);
    expect(out.notes.at(-1)).toBe('Not signed in with ChatGPT.');
  });

  it('reports a failed sign-in as a note and saves nothing', async () => {
    await fixture.close();
    fixture = await createChatGptOAuthFixture({ deny: true });
    const { notes, saves, host: tui } = host();
    await loginWithChatGptInTui(tui);
    expect(notes.at(-1)).toMatch(/✕ ChatGPT sign-in failed: Sign-in was declined/);
    expect(saves).toEqual([]);
  });
});
